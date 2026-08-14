import { intersect, subtract, union } from '@jscad/modeling/src/operations/booleans';
import { extrudeLinear } from '@jscad/modeling/src/operations/extrusions';
import { hull } from '@jscad/modeling/src/operations/hulls';
import { rotateX, transform, translate } from '@jscad/modeling/src/operations/transforms';
import { cuboid, cylinder, polygon } from '@jscad/modeling/src/primitives';
import { degToRad } from '@jscad/modeling/src/utils';
import * as mat4 from '@jscad/modeling/src/maths/mat4';

import type { Geom3 } from '@jscad/modeling/src/geometries/types';
import type { Mat4, Vec3 } from '@jscad/modeling/src/maths/types';

import { Params, VentFanBox, VentPanel, VentRainRing } from '../params';
import { Surface } from '.';

// How far parts embed into the surrounding wall so unions are watertight.
const EMBED = 1;
// How far louvre blades overlap radially into the wall around the bore.
const LOUVRE_RIM_EMBED = 1.5;
// Extra vertical overlap between adjacent louvre blades (1 = edges exactly
// meet in projection; >1 guarantees no straight-through line of sight).
const LOUVRE_OVERLAP = 1.35;
const BORE_SEGMENTS = 64;
const SCREW_SEGMENTS = 24;
const CUT_EPS = 0.2;

type Frame = {
  center: Vec3;
  outward: Vec3;
  wallDepth: number;
};

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const negate = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]];

// World-space direction pointing towards a given enclosure surface. Uses the
// same convention as holes.ts / the renderer's surface labels: front = +Y,
// back = -Y, left = +X, right = -X, top = +Z, bottom = -Z.
const directionTowards = (surface: Surface): Vec3 => {
  switch (surface) {
    case 'front':
      return [0, 1, 0];
    case 'back':
      return [0, -1, 0];
    case 'left':
      return [1, 0, 0];
    case 'right':
      return [-1, 0, 0];
    case 'top':
      return [0, 0, 1];
    case 'bottom':
      return [0, 0, -1];
  }
};

// Local placement frame for a vent panel: where its centre sits and which way
// "outward" points. Positions follow the same conventions as holes.ts. For
// the 'top' surface the frame is expressed in lid-local coordinates (the
// lid's outside face is at z = 0, so outward is -Z).
const ventFrame = (params: Params, vent: VentPanel): Frame => {
  const { length, width, height, floor, roof, wall, insertThickness, insertClearance } = params;
  const totalWallThickness = insertThickness + insertClearance * 2 + wall * 2;

  switch (vent.surface) {
    case 'front':
      return {
        center: [width / 2 - vent.y, length - totalWallThickness / 2, height / 2 + vent.x],
        outward: [0, 1, 0],
        wallDepth: totalWallThickness,
      };
    case 'back':
      return {
        center: [width / 2 - vent.y, totalWallThickness / 2, height / 2 + vent.x],
        outward: [0, -1, 0],
        wallDepth: totalWallThickness,
      };
    case 'right':
      return {
        center: [totalWallThickness / 2, length / 2 - vent.y, height / 2 + vent.x],
        outward: [-1, 0, 0],
        wallDepth: totalWallThickness,
      };
    case 'left':
      return {
        center: [width - totalWallThickness / 2, length / 2 - vent.y, height / 2 + vent.x],
        outward: [1, 0, 0],
        wallDepth: totalWallThickness,
      };
    case 'bottom':
      return {
        center: [width / 2 - vent.y, length / 2 - vent.x, floor / 2],
        outward: [0, 0, -1],
        wallDepth: floor,
      };
    case 'top':
      // Lid-local coordinates: outside face at z = 0.
      return {
        center: [width / 2 - vent.y, length / 2 - vent.x, roof / 2],
        outward: [0, 0, -1],
        wallDepth: roof,
      };
  }
};

// Resolved world-space drain direction for a vent. Must lie in the wall
// plane; if the user picked the vent's own surface (or its opposite) fall
// back to something sensible.
const resolveDrainDirection = (frame: Frame, vent: VentPanel): Vec3 => {
  let drain = directionTowards(vent.louvreDrainSurface);
  if (Math.abs(dot(drain, frame.outward)) > 0.5) {
    drain =
      vent.surface === 'top' || vent.surface === 'bottom' ? directionTowards('back') : [0, 0, -1];
  }
  return drain;
};

// Distance from the vent centre to the edge of its wall face, measured
// along the drain direction (i.e. towards the collar's bottom). Used to
// stop the rain collar's swept skirt from overhanging past the enclosure.
const drainEdgeDistance = (params: Params, frame: Frame, drain: Vec3): number => {
  const axisIndex = drain[0] !== 0 ? 0 : drain[1] !== 0 ? 1 : 2;
  const axisMax = axisIndex === 0 ? params.width : axisIndex === 1 ? params.length : params.height;
  const c = frame.center[axisIndex];
  return drain[axisIndex] > 0 ? axisMax - c : c;
};

// Transform from the vent's canonical frame (+Z = outward through the wall,
// -Y = drain direction, origin = vent centre on the wall mid-plane) into
// enclosure coordinates.
const ventTransform = (frame: Frame, vent: VentPanel): Mat4 => {
  const drain = resolveDrainDirection(frame, vent);

  const zAxis = frame.outward;
  const yAxis = negate(drain);
  const xAxis = cross(yAxis, zAxis);

  return mat4.fromValues(
    xAxis[0],
    xAxis[1],
    xAxis[2],
    0,
    yAxis[0],
    yAxis[1],
    yAxis[2],
    0,
    zAxis[0],
    zAxis[1],
    zAxis[2],
    0,
    frame.center[0],
    frame.center[1],
    frame.center[2],
    1,
  );
};

const placeOnSurface = (frame: Frame, vent: VentPanel, geometry: Geom3): Geom3 => {
  return transform(ventTransform(frame, vent), geometry);
};

// --- Canonical-frame part builders ------------------------------------------
// All builders work in the vent's canonical frame: origin at the vent centre
// on the wall mid-plane, +Z pointing outward, -Y the drain direction. The
// wall occupies z in [-wallDepth/2, +wallDepth/2].

const boreCutout = (vent: VentPanel, wallDepth: number): Geom3 => {
  return cylinder({
    radius: vent.diameter / 2,
    height: wallDepth + CUT_EPS,
    segments: BORE_SEGMENTS,
  });
};

const extraScrewHoleCutouts = (
  holes: VentPanel['extraScrewHoles'],
  wallDepth: number,
): Geom3[] => {
  return holes
    .filter((hole) => hole.diameter > 0 && hole.radius > 0)
    .map((hole) => {
      const angle = degToRad(hole.angleDeg);
      return translate(
        [Math.cos(angle) * hole.radius, Math.sin(angle) * hole.radius, 0],
        cylinder({
          radius: hole.diameter / 2,
          height: wallDepth + CUT_EPS,
          segments: SCREW_SEGMENTS,
        }),
      );
    });
};

// Derived dimensions of the louvre blade stack, shared between the blade
// builder and the rain collar (whose rim must meet the blades' leading
// edges). The blades sit flush with the inner wall face and span `extent`
// along the vent axis, so their leading (outer) edges all lie on the plane
// z = -wallDepth/2 + extent.
const louvreStack = (vent: VentPanel) => {
  const count = Math.max(2, Math.round(vent.louvreCount));
  const angleFromWall = Math.min(75, Math.max(15, vent.louvreAngle));
  const thickness = Math.max(0.4, vent.louvreThickness);

  // Tilt measured from the vent axis; blade chord direction is
  // (0, -sin(tilt), cos(tilt)) - i.e. downhill towards -Y going outward.
  const tilt = degToRad(90 - angleFromWall);
  const pitch = vent.diameter / Math.max(1, count);
  const chord = (LOUVRE_OVERLAP * pitch) / Math.sin(tilt);
  const extent = chord * Math.cos(tilt) + thickness * Math.sin(tilt);

  return { count, thickness, tilt, pitch, chord, extent };
};

// Angled, overlapping rain-louvre blades spanning the bore. Each blade is
// tilted so its outer edge sits lower (towards -Y, the drain direction) than
// its inner edge, and adjacent blades overlap in Y-projection so there is no
// straight line of sight through the vent. Blades sit flush with the inner
// wall face and protrude outward, never into the enclosure.
const louvres = (vent: VentPanel, wallDepth: number): Geom3 | null => {
  const bore = vent.diameter;

  if (bore <= 0) {
    return null;
  }

  const { count, thickness, tilt, pitch, chord, extent } = louvreStack(vent);
  const bladeCenterZ = -wallDepth / 2 + extent / 2;
  const bladeLength = bore + LOUVRE_RIM_EMBED * 2;

  const blades: Geom3[] = [];
  for (let i = 0; i < count; i++) {
    const y = -bore / 2 + pitch * (i + 0.5);
    blades.push(
      translate(
        [0, y, bladeCenterZ],
        rotateX(tilt, cuboid({ size: [bladeLength, thickness, chord] })),
      ),
    );
  }

  // Trim the blade stack: inside the wall thickness the blades may embed
  // LOUVRE_RIM_EMBED into the wall around the bore (so they fuse with it);
  // outside the wall they are trimmed to the bore circle.
  const rimRegion = cylinder({
    radius: bore / 2 + LOUVRE_RIM_EMBED,
    height: wallDepth,
    segments: BORE_SEGMENTS,
  });
  const boreRegion = cylinder({
    radius: bore / 2,
    height: (extent + wallDepth) * 2,
    segments: BORE_SEGMENTS,
  });

  return intersect(union(blades), union(rimRegion, boreRegion));
};

// Insect screen: a thin crosshatch grille (square openings) rather than a
// field of drilled holes - a perforated pattern would need hundreds of
// boolean subtractions and make preview/export unusably slow. The grille is
// built additively from bars and clipped to the bore, embedding 1mm into the
// surrounding wall. It sits flush with the inner wall face, behind the
// louvres.
const meshGrille = (vent: VentPanel, wallDepth: number): Geom3 | null => {
  const bore = vent.diameter;
  const pitch = Math.max(2, vent.meshPitch);
  const opening = Math.min(pitch - 0.6, Math.max(1, vent.meshHoleSize));
  const barWidth = pitch - opening;
  const thickness = Math.max(0.6, vent.meshThickness);

  if (bore <= 0) {
    return null;
  }

  const radius = bore / 2 + EMBED;
  const z = -wallDepth / 2 + thickness / 2;
  const bars: Geom3[] = [];
  const steps = Math.ceil(radius / pitch);

  for (let k = -steps; k <= steps; k++) {
    const offset = k * pitch;
    if (Math.abs(offset) > radius + barWidth) {
      continue;
    }
    bars.push(translate([0, offset, z], cuboid({ size: [radius * 2, barWidth, thickness] })));
    bars.push(translate([offset, 0, z], cuboid({ size: [barWidth, radius * 2, thickness] })));
  }

  if (bars.length === 0) {
    return null;
  }

  const disc = cylinder({
    radius,
    height: thickness,
    center: [0, 0, z],
    segments: BORE_SEGMENTS,
  });

  return intersect(union(bars), disc);
};

// C-shaped rain collar: a straight tube around the vent that is SHEARED
// (not rotated) towards the drain side. The shear maps (x, y, z) to
// (x, y - z * tan(tilt), z): every cross-sectional slice keeps the exact
// circular ring shape of the straight tube and both end caps stay flat and
// parallel to the wall, while the tube's walls lean at the same angle as
// the louvre blades - a parallelogram side profile with no ballooning.
// The tube spans the same z-range as the louvre stack (inner wall face to
// the blades' leading-edge plane) with the same shear rate, so at the top
// of the ring (by the gap) the collar's edge runs along the topmost blade,
// reading as one continuous line from the side.
const rainRing = (
  vent: VentPanel,
  ring: VentRainRing,
  wallDepth: number,
  drainLimit: number,
): Geom3 | null => {
  const wallT = Math.max(0.8, ring.wallThickness);
  const gap = Math.min(170, Math.max(0, ring.gapAngleDeg));
  // Sit just outside the louvre stack, which is trimmed to the bore circle
  // outside the wall.
  const innerRadius = vent.diameter / 2 + 1;
  const outerRadius = innerRadius + wallT;

  if (vent.diameter <= 0) {
    return null;
  }

  const { tilt, extent } = louvreStack(vent);
  // Same z-extent as the louvre stack: near cap at the blades' inner edges,
  // far cap at their leading edges.
  const length = extent;

  // Straight annulus along +Z, near cap at z = 0.
  let tube = subtract(
    cylinder({
      radius: outerRadius,
      height: length,
      center: [0, 0, length / 2],
      segments: BORE_SEGMENTS,
    }),
    cylinder({
      radius: innerRadius,
      height: length + CUT_EPS,
      center: [0, 0, length / 2],
      segments: BORE_SEGMENTS,
    }),
  );

  // Cut the top opening in the unsheared frame (the shear is linear, so the
  // wedge composes correctly and stays centred opposite the drain).
  if (gap > 0) {
    const half = degToRad(gap / 2);
    const reach = outerRadius * 2;
    tube = subtract(
      tube,
      translate(
        [0, 0, -CUT_EPS],
        extrudeLinear(
          { height: length + CUT_EPS * 2 },
          polygon({
            points: [
              [0, 0],
              [Math.sin(half) * reach, Math.cos(half) * reach],
              [-Math.sin(half) * reach, Math.cos(half) * reach],
            ],
          }),
        ),
      ),
    );
  }

  // Shear towards the drain side (-Y as z increases), matching the blades'
  // own lean. Column-major mat4: y' = y - tan(tilt) * z.
  const sheared = transform(
    mat4.fromValues(1, 0, 0, 0, 0, 1, 0, 0, 0, -Math.tan(tilt), 1, 0, 0, 0, 0, 1),
    tube,
  );

  // Near cap sits on the inner wall face (fully embedded through the wall),
  // far cap lands on the louvre leading-edge plane.
  const collar = translate([0, 0, -wallDepth / 2], sheared);

  // Clip at the wall face's edge on the drain side, in case the sheared
  // mouth would overhang past the enclosure.
  const keep = (length + outerRadius * 2) * 4;
  return intersect(
    collar,
    cuboid({
      size: [keep, keep, keep],
      center: [0, -drainLimit + keep / 2, 0],
    }),
  );
};

// Stand-off duct on the INSIDE of the wall. The louvres stay the outermost
// weather barrier on the outer wall face; the fan box extends inward from
// the wall and the fan mounts against the inner end plate, which carries the
// airflow opening and the fan's screw pattern. Returned geometry already has
// its openings subtracted, so it must be unioned into the body AFTER the
// wall cutouts have been applied.
const fanBox = (vent: VentPanel, box: VentFanBox, wallDepth: number): Geom3 | null => {
  const size = box.frameSize;
  const wallT = Math.max(0.8, box.wallThickness);
  const plateT = wallT;
  const depth = Math.max(plateT + 1, box.depth);

  if (size <= 0) {
    return null;
  }

  // Canonical frame: +Z is outward. The duct spans from the inner wall face
  // (embedded 1mm into the wall for a solid union) down to -depth inside the
  // enclosure, with the fan mounting plate at the inner end (lowest z).
  const z1 = -wallDepth / 2 + EMBED;
  const z0 = -wallDepth / 2 - depth;
  const outerHeight = z1 - z0;
  const outerCenterZ = (z0 + z1) / 2;
  const cavityHeight = z1 + CUT_EPS - (z0 + plateT);
  const cavityCenterZ = (z0 + plateT + z1 + CUT_EPS) / 2;
  const plateCutHeight = plateT + CUT_EPS * 2;
  const plateCutCenterZ = z0 + plateT / 2;

  const solids: Geom3[] = [];
  const cuts: Geom3[] = [];

  // Airflow opening through the end plate, matching the wall bore.
  cuts.push(
    cylinder({
      radius: vent.diameter / 2,
      height: plateCutHeight,
      center: [0, 0, plateCutCenterZ],
      segments: BORE_SEGMENTS,
    }),
  );

  if (box.frameShape === 'square') {
    solids.push(cuboid({ size: [size, size, outerHeight], center: [0, 0, outerCenterZ] }));
    cuts.push(
      cuboid({
        size: [size - wallT * 2, size - wallT * 2, cavityHeight],
        center: [0, 0, cavityCenterZ],
      }),
    );

    const inset = box.screwHoleInset;
    const offset = size / 2 - inset;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        cuts.push(
          cylinder({
            radius: box.screwHoleDiameter / 2,
            height: plateCutHeight,
            center: [sx * offset, sy * offset, plateCutCenterZ],
            segments: SCREW_SEGMENTS,
          }),
        );
      }
    }
  } else {
    solids.push(
      cylinder({
        radius: size / 2,
        height: outerHeight,
        center: [0, 0, outerCenterZ],
        segments: BORE_SEGMENTS,
      }),
    );
    cuts.push(
      cylinder({
        radius: size / 2 - wallT,
        height: cavityHeight,
        center: [0, 0, cavityCenterZ],
        segments: BORE_SEGMENTS,
      }),
    );

    // Blower mounting ears: stadium-shaped tabs on the end plate reaching out
    // to each screw position, which may sit outside the frame radius.
    for (const hole of box.extraScrewHoles) {
      if (hole.diameter <= 0 || hole.radius <= 0) {
        continue;
      }
      const angle = degToRad(hole.angleDeg);
      const dir: [number, number] = [Math.cos(angle), Math.sin(angle)];
      const padRadius = hole.diameter / 2 + 3;
      const anchorRadius = Math.min(hole.radius, size / 2 - padRadius / 2);
      const pad = (r: number) =>
        cylinder({
          radius: padRadius,
          height: plateT,
          center: [dir[0] * r, dir[1] * r, z0 + plateT / 2],
          segments: SCREW_SEGMENTS,
        });
      solids.push(hull(pad(anchorRadius), pad(hole.radius)));
      cuts.push(
        cylinder({
          radius: hole.diameter / 2,
          height: plateCutHeight,
          center: [dir[0] * hole.radius, dir[1] * hole.radius, plateCutCenterZ],
          segments: SCREW_SEGMENTS,
        }),
      );
    }
  }

  return subtract(union(solids), union(cuts));
};

// --- Public API --------------------------------------------------------------

const ventsForSurfaces = (params: Params, surfacesFilter: Surface[]): VentPanel[] => {
  return (params.ventPanels ?? []).filter(
    (vent) => surfacesFilter.includes(vent.surface) && vent.diameter > 0,
  );
};

// Material removed from the wall: the airflow bore, plus (when there is no
// fan box) any flush-mount screw holes straight through the wall.
export const ventPanelCutouts = (
  params: Params,
  surfacesFilter: Surface[] = ['front', 'back', 'left', 'right', 'bottom'],
): Geom3 | null => {
  const cutouts: Geom3[] = [];

  ventsForSurfaces(params, surfacesFilter).forEach((vent) => {
    const frame = ventFrame(params, vent);
    const parts: Geom3[] = [boreCutout(vent, frame.wallDepth)];
    if (!vent.fanBox) {
      parts.push(...extraScrewHoleCutouts(vent.extraScrewHoles ?? [], frame.wallDepth));
    }
    cutouts.push(placeOnSurface(frame, vent, union(parts)));
  });

  return cutouts.length > 0 ? union(cutouts) : null;
};

// Material added on/around the wall: louvre blades, the optional insect mesh
// and the optional fan box. Must be unioned in AFTER all subtractions.
export const ventPanelAdditions = (
  params: Params,
  surfacesFilter: Surface[] = ['front', 'back', 'left', 'right', 'bottom'],
): Geom3 | null => {
  const additions: Geom3[] = [];

  ventsForSurfaces(params, surfacesFilter).forEach((vent) => {
    const frame = ventFrame(params, vent);
    const parts: Geom3[] = [];

    const fins = louvres(vent, frame.wallDepth);
    if (fins) {
      parts.push(fins);
    }

    if (vent.meshPanel) {
      const mesh = meshGrille(vent, frame.wallDepth);
      if (mesh) {
        parts.push(mesh);
      }
    }

    if (vent.fanBox) {
      const box = fanBox(vent, vent.fanBox, frame.wallDepth);
      if (box) {
        parts.push(box);
      }
    }

    if (vent.rainRing?.enabled) {
      const drain = resolveDrainDirection(frame, vent);
      const collar = rainRing(
        vent,
        vent.rainRing,
        frame.wallDepth,
        drainEdgeDistance(params, frame, drain),
      );
      if (collar) {
        parts.push(collar);
      }
    }

    if (parts.length > 0) {
      additions.push(placeOnSurface(frame, vent, union(parts)));
    }
  });

  return additions.length > 0 ? union(additions) : null;
};
