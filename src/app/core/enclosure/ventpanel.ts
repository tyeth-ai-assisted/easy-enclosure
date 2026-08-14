import { intersect, subtract, union } from '@jscad/modeling/src/operations/booleans';
import { extrudeLinear } from '@jscad/modeling/src/operations/extrusions';
import { hull } from '@jscad/modeling/src/operations/hulls';
import { rotateX, rotateZ, transform, translate } from '@jscad/modeling/src/operations/transforms';
import { cuboid, cylinder, polygon } from '@jscad/modeling/src/primitives';
import { degToRad } from '@jscad/modeling/src/utils';
import * as mat4 from '@jscad/modeling/src/maths/mat4';

import type { Geom3 } from '@jscad/modeling/src/geometries/types';
import type { Mat4, Vec3 } from '@jscad/modeling/src/maths/types';

import { Params, VentExtraScrewHole, VentFanBox, VentPanel, VentRainRing } from '../params';
import { Surface } from '.';

// How far parts embed into the surrounding wall so unions are watertight.
const EMBED = 1;
// How far louvre blades overlap radially into the wall around the bore.
const LOUVRE_RIM_EMBED = 1.5;
// Radial clearance between the bore and the rain collar's inner wall.
const RAIN_RING_CLEARANCE = 1;
// Lateral clearance around the fan inside its duct pocket, so a real fan of
// exactly frameSize can be slid in through the duct's open face.
const FAN_POCKET_CLEARANCE = 0.5;
// Defaults for the inside screw bosses (per-hole overrides in
// VentExtraScrewHole.outerDiameter / .height).
const SCREW_BOSS_HEIGHT = 5;
const SCREW_BOSS_WALL = 2;
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

// The fan must remain insertable after the base has been printed. For vents
// on a vertical wall, rotate the fan box independently of the louvres so its
// open face always points towards the enclosure lid (+Z in base coordinates).
// A lid/floor vent has no in-plane lid direction, so preserve its canonical
// opening opposite the resolved drain direction.
const fanBoxLidRotation = (frame: Frame, vent: VentPanel): number => {
  const lidDirection: Vec3 = [0, 0, 1];
  if (Math.abs(dot(lidDirection, frame.outward)) > 0.5) {
    return 0;
  }

  const drain = resolveDrainDirection(frame, vent);
  const canonicalY = negate(drain);
  const canonicalX = cross(canonicalY, frame.outward);
  const targetX = dot(lidDirection, canonicalX);
  const targetY = dot(lidDirection, canonicalY);

  // rotateZ(angle) maps canonical +Y to [-sin(angle), cos(angle)].
  return Math.atan2(-targetX, targetY);
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

const validScrewHoles = (holes: VentPanel['extraScrewHoles']) =>
  holes.filter((hole) => hole.diameter > 0 && hole.radius > 0);

const screwBossHeight = (hole: VentExtraScrewHole) => Math.max(1, hole.height ?? SCREW_BOSS_HEIGHT);

// Blind pilot-hole cutouts for the inside screw bosses: drilled EMBED deep
// into the wall from the inner face for extra thread engagement, but never
// through to the outer weather surface - the remaining outer skin is
// wallDepth - EMBED. (These used to be straight-through holes, which gave
// wind-driven rain a direct path past the louvres.)
const screwBossPilotCutouts = (
  holes: VentPanel['extraScrewHoles'],
  wallDepth: number,
): Geom3[] => {
  return validScrewHoles(holes).map((hole) => {
    const angle = degToRad(hole.angleDeg);
    return translate(
      [
        Math.cos(angle) * hole.radius,
        Math.sin(angle) * hole.radius,
        -wallDepth / 2 + (EMBED - CUT_EPS) / 2,
      ],
      cylinder({
        radius: hole.diameter / 2,
        height: EMBED + CUT_EPS,
        segments: SCREW_SEGMENTS,
      }),
    );
  });
};

// Raised screw bosses standing inward from the inner wall face, one per
// extraScrewHole, each with a blind pilot hole down its centre. The fan is
// driven from inside the enclosure against the boss tips; nothing penetrates
// the outer surface.
const ventScrewBosses = (
  holes: VentPanel['extraScrewHoles'],
  wallDepth: number,
): Geom3 | null => {
  const bosses = validScrewHoles(holes).map((hole) => {
    const angle = degToRad(hole.angleDeg);
    const height = screwBossHeight(hole);
    const outerRadius =
      Math.max(hole.diameter + 1.6, hole.outerDiameter ?? hole.diameter + SCREW_BOSS_WALL * 2) / 2;
    const x = Math.cos(angle) * hole.radius;
    const y = Math.sin(angle) * hole.radius;
    // Boss body spans from EMBED inside the wall down to the tip; the pilot
    // runs the full boss length and meets the blind in-wall cutout above.
    const centerZ = -wallDepth / 2 + (EMBED - height) / 2;
    return subtract(
      cylinder({
        radius: outerRadius,
        height: height + EMBED,
        center: [x, y, centerZ],
        segments: SCREW_SEGMENTS,
      }),
      cylinder({
        radius: hole.diameter / 2,
        height: height + EMBED + CUT_EPS,
        center: [x, y, centerZ - CUT_EPS / 2],
        segments: SCREW_SEGMENTS,
      }),
    );
  });
  return bosses.length > 0 ? union(bosses) : null;
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

// y-centre of an end blade seated so its TOP surface passes exactly through
// the bore's top or bottom edge (edgeSign = +1 / -1) at the OUTER wall face.
// The regular blade grid leaves both extremes short of the bore edge on the
// weather face: the bottom by most of a pitch (a wide visible slit) and the
// top by a fraction of a millimetre (a thin open crescent around the bore's
// top edge). The bottom instance is the drip sill; the top instance is the
// cap blade, which becomes the true topmost blade that the rain collar
// aligns to (rainRingFrame / topBladePlaneCut derive from this same helper,
// so the collar and the cap can never drift apart).
const louvreEndBladeY = (vent: VentPanel, wallDepth: number, edgeSign: 1 | -1): number => {
  const { thickness, tilt, extent } = louvreStack(vent);
  const sinT = Math.sin(tilt);
  const cosT = Math.cos(tilt);
  const bladeCenterZ = -wallDepth / 2 + extent / 2;
  const tAtWallFace = (wallDepth / 2 - bladeCenterZ - (thickness / 2) * sinT) / cosT;
  return (edgeSign * vent.diameter) / 2 - (thickness / 2) * cosT + tAtWallFace * sinT;
};

// Shared placement of the rain collar in the vent's canonical frame, used by
// BOTH rainRing() (to build the collar) and louvres() (to clip the blades to
// the collar's inner wall) so the two can never drift apart. The collar is a
// straight annulus (inner/outer radius) spanning z_local in [0, span], then
// sheared y' = y - z_local * tan(tilt) and translated by [0, yOffset, zStart].
export const rainRingFrame = (vent: VentPanel, ring: VentRainRing, wallDepth: number) => {
  const wallT = Math.max(0.8, ring.wallThickness);
  const gap = Math.min(170, Math.max(0, ring.gapAngleDeg));
  // Sit just outside the louvre blades' clipped edges.
  const innerRadius = vent.diameter / 2 + RAIN_RING_CLEARANCE;
  const outerRadius = innerRadius + wallT;

  const { tilt, thickness, chord } = louvreStack(vent);
  const sinT = Math.sin(tilt);
  const cosT = Math.cos(tilt);
  const gapHalf = degToRad(gap / 2);

  // The collar spans exactly the topmost blade's TOP-surface z-range. With a
  // top opening it is seated so its gap-edge INNER corners lie on that top
  // surface's plane: the blades' clipped edges end exactly on the collar's
  // inner wall (rainRingInnerRegion), so the topmost blade's edge then runs
  // precisely into the collar's gap-edge corners; any collar material still
  // standing above the blade plane is shaved off in rainRing() by the
  // blade's own face plane, keeping edge and blade coincident by
  // construction for any parameter combination. A closed ring (gap = 0)
  // instead sits tangent to the plane at the outer radius, as before.
  const span = chord * cosT;
  const zStart = -wallDepth / 2 + thickness * sinT;
  // The true topmost blade is the cap blade (seated on the bore's top edge
  // at the outer wall face), not the last grid blade.
  const topBladeY = louvreEndBladeY(vent, wallDepth, 1);
  const trailingCornerY = topBladeY + (thickness / 2) * cosT + (chord / 2) * sinT;
  const seatRadius = gap > 0 ? innerRadius : outerRadius;
  const yOffset = trailingCornerY - seatRadius * Math.cos(gapHalf);

  // Column-major mat4 shear towards the drain side: y' = y - tan(tilt) * z.
  const shear: Mat4 = mat4.fromValues(1, 0, 0, 0, 0, 1, 0, 0, 0, -Math.tan(tilt), 1, 0, 0, 0, 0, 1);

  return { wallT, gap, gapHalf, innerRadius, outerRadius, span, zStart, yOffset, shear };
};

// Half-space (as an oversized solid) bounded below by the topmost louvre
// blade's ACTUAL top-surface plane, built with the very same rotateX +
// translate that louvres() uses to place that blade - not from re-derived
// coordinates. rainRing() subtracts this from the collar so the collar's
// opening edge is exactly coincident with the blade's face plane by
// construction, for any vent/blade parameter combination.
export const topBladePlaneCut = (vent: VentPanel, wallDepth: number): Geom3 => {
  const { thickness, tilt, chord, extent } = louvreStack(vent);
  const topBladeY = louvreEndBladeY(vent, wallDepth, 1);
  const bladeCenterZ = -wallDepth / 2 + extent / 2;
  const reach = (vent.diameter + chord + wallDepth) * 4;
  return translate(
    [0, topBladeY, bladeCenterZ],
    rotateX(
      tilt,
      cuboid({ size: [reach, reach, reach], center: [0, thickness / 2 + reach / 2, 0] }),
    ),
  );
};

// Solid bounded by the rain collar's inner wall, extended along the vent
// axis: a cylinder of the collar's inner radius carried through the same
// shear and offset as the collar itself. Clipping the louvre blades to this
// makes every blade's edge land exactly on the collar's inner surface at
// every height, instead of stopping RAIN_RING_CLEARANCE short at the bare
// bore circle and leaving an annular slit for wind-driven rain.
const rainRingInnerRegion = (
  vent: VentPanel,
  ring: VentRainRing,
  wallDepth: number,
  height: number,
): Geom3 => {
  const { innerRadius, zStart, yOffset, shear } = rainRingFrame(vent, ring, wallDepth);
  return translate(
    [0, yOffset, zStart],
    transform(shear, cylinder({ radius: innerRadius, height, segments: BORE_SEGMENTS })),
  );
};

// Angled, overlapping rain-louvre blades spanning the bore. Each blade is
// tilted so its outer edge sits lower (towards -Y, the drain direction) than
// its inner edge, and adjacent blades overlap in Y-projection so there is no
// straight line of sight through the vent. Blades sit flush with the inner
// wall face and protrude outward, never into the enclosure.
export const louvres = (vent: VentPanel, wallDepth: number, drainLimit: number): Geom3 | null => {
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

  // End blades: the regular grid leaves both extremes of the stack short of
  // the bore edge ON THE OUTER WALL FACE - the bottom by most of a pitch (a
  // wide visible slit under the first blade) and the top by a fraction of a
  // millimetre (a thin open crescent over the last blade). Seat one extra
  // blade at each end so its top surface passes exactly through the bore's
  // bottom / top edge at the outer wall face: the bottom one is a drip sill
  // (wall lip + sill act as a standard louvre pair), the top one is a cap
  // blade that closes the bore's top edge flush and becomes the true topmost
  // blade the rain collar aligns to (it typically merges with the grid's
  // last blade into one slightly thicker slat).
  for (const edgeSign of [-1, 1] as const) {
    blades.push(
      translate(
        [0, louvreEndBladeY(vent, wallDepth, edgeSign), bladeCenterZ],
        rotateX(tilt, cuboid({ size: [bladeLength, thickness, chord] })),
      ),
    );
  }

  // Trim the blade stack: inside the wall thickness the blades may embed
  // LOUVRE_RIM_EMBED into the wall around the bore (so they fuse with it);
  // outside the wall they are trimmed to the bore circle - unless a rain
  // collar surrounds the vent, in which case the blades extend all the way
  // out to the collar's inner wall (which is sheared with z, so the clip
  // region must be the same sheared cylinder the collar is built around;
  // a plain bore-radius clip would leave an annular rain slit between the
  // blade edges and the collar).
  const rimRegion = cylinder({
    radius: bore / 2 + LOUVRE_RIM_EMBED,
    height: wallDepth,
    segments: BORE_SEGMENTS,
  });
  const outsideRegion = vent.rainRing?.enabled
    ? rainRingInnerRegion(vent, vent.rainRing, wallDepth, (extent + wallDepth) * 2)
    : cylinder({
        radius: bore / 2,
        height: (extent + wallDepth) * 2,
        segments: BORE_SEGMENTS,
      });

  // Clip at the enclosure's edge on the drain side (like the rain collar):
  // the sill reaches down to the collar's inner wall, which on large vents
  // can dip past the enclosure's outer surface.
  const keep = (extent + bore + LOUVRE_RIM_EMBED * 2) * 4;
  return intersect(
    union(blades),
    union(rimRegion, outsideRegion),
    cuboid({ size: [keep, keep, keep], center: [0, -drainLimit + keep / 2, 0] }),
  );
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
// The tube spans exactly the topmost blade's TOP-surface z-range with the
// same shear rate, and its opening edge is cut by the topmost blade's own
// face plane - collar edge and top slat read as one continuous flush line
// from the side, coincident by construction.
export const rainRing = (
  vent: VentPanel,
  ring: VentRainRing,
  wallDepth: number,
  drainLimit: number,
): Geom3 | null => {
  if (vent.diameter <= 0) {
    return null;
  }

  // The collar's opening edge must coincide with the topmost blade's actual
  // TOP surface (the thick plate's outward face), so the two read as one
  // continuous line. Rather than computing matching cap coordinates (which
  // kept drifting out of alignment whenever the blade geometry changed),
  // the collar is seated so its gap-edge inner corners lie on that surface's
  // plane (see rainRingFrame()) and then everything still standing above the
  // plane is CUT AWAY by the blade's own face plane (topBladePlaneCut, built
  // from the same transform that places the blade). The blade's clipped edge
  // and the collar's opening edge are then the same plane-cylinder
  // intersection curve - exactly coincident by construction.
  const { gap, gapHalf, innerRadius, outerRadius, span, zStart, yOffset, shear } = rainRingFrame(
    vent,
    ring,
    wallDepth,
  );

  // Straight annulus along +Z, near cap at z = 0.
  let tube = subtract(
    cylinder({
      radius: outerRadius,
      height: span,
      center: [0, 0, span / 2],
      segments: BORE_SEGMENTS,
    }),
    cylinder({
      radius: innerRadius,
      height: span + CUT_EPS,
      center: [0, 0, span / 2],
      segments: BORE_SEGMENTS,
    }),
  );

  // Cut the top opening in the unsheared frame (the shear is linear, so the
  // wedge composes correctly and stays centred opposite the drain).
  if (gap > 0) {
    const reach = outerRadius * 2;
    tube = subtract(
      tube,
      translate(
        [0, 0, -CUT_EPS],
        extrudeLinear(
          { height: span + CUT_EPS * 2 },
          polygon({
            points: [
              [0, 0],
              [Math.sin(gapHalf) * reach, Math.cos(gapHalf) * reach],
              [-Math.sin(gapHalf) * reach, Math.cos(gapHalf) * reach],
            ],
          }),
        ),
      ),
    );
  }

  // Shear towards the drain side (-Y as z increases), matching the blades'
  // own lean: y' = y - tan(tilt) * z.
  const sheared = transform(shear, tube);

  // Position so the gap-edge inner corners lie on the topmost blade's top
  // surface, near cap through far cap. The near cap remains inside the wall
  // thickness, keeping the collar embedded.
  let collar = translate([0, yOffset, zStart], sheared);

  // Shave everything above the topmost blade's actual face plane so the
  // collar's opening edge is exactly that plane (skipped for a closed ring,
  // which sits tangent below the plane instead).
  if (gap > 0) {
    collar = subtract(collar, topBladePlaneCut(vent, wallDepth));
  }

  // Clip at the wall face's edge on the drain side, in case the sheared
  // mouth would overhang past the enclosure.
  const keep = (span + outerRadius * 2) * 4;
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
// airflow opening and the fan's screw pattern. The fan pocket is sized to
// actually admit the fan (frameSize plus a sliding clearance) and the face
// canonical +Y face is deliberately left without a wall - a fully enclosed
// duct would make it physically impossible to insert a real fan after
// printing. The caller rotates this completed box independently of the
// louvres so +Y faces the enclosure lid for wall vents. Returned geometry
// already has its openings subtracted, so it must be unioned into the body
// AFTER the wall cutouts have been applied.
export const fanBox = (vent: VentPanel, box: VentFanBox, wallDepth: number): Geom3 | null => {
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
  const plateCutHeight = plateT + CUT_EPS * 2;
  const plateCutCenterZ = z0 + plateT / 2;
  // Interior pocket the fan actually sits in: the fan's own frame size plus
  // clearance, so the fan can be slid in through the open +Y face.
  const pocket = size + FAN_POCKET_CLEARANCE;

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
    // Footprint: walls on -Y and both X sides only; the +Y face has no wall
    // so the fan can be dropped/slid into the pocket.
    const outerW = pocket + wallT * 2;
    const outerD = pocket + wallT;
    const yCenter = -wallT / 2;

    // End plate carrying the bore and the fan's screw pattern.
    solids.push(
      cuboid({ size: [outerW, outerD, plateT], center: [0, yCenter, z0 + plateT / 2] }),
    );
    // Wall opposite the canonical opening.
    solids.push(
      cuboid({
        size: [outerW, wallT, outerHeight],
        center: [0, -(pocket + wallT) / 2, outerCenterZ],
      }),
    );
    // Side walls.
    for (const sx of [-1, 1]) {
      solids.push(
        cuboid({
          size: [wallT, outerD, outerHeight],
          center: [(sx * (pocket + wallT)) / 2, yCenter, outerCenterZ],
        }),
      );
    }

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
    const pocketR = pocket / 2;

    // End plate carrying the bore, the screw ears and the duct wall footing.
    solids.push(
      cylinder({
        radius: pocketR + wallT,
        height: plateT,
        center: [0, 0, z0 + plateT / 2],
        segments: BORE_SEGMENTS,
      }),
    );
    // Duct wall: a tube around the pocket with its +Y half removed, leaving
    // an opening the full pocket diameter wide for the fan to slide in.
    const tube = subtract(
      cylinder({
        radius: pocketR + wallT,
        height: outerHeight,
        center: [0, 0, outerCenterZ],
        segments: BORE_SEGMENTS,
      }),
      cylinder({
        radius: pocketR,
        height: outerHeight + CUT_EPS,
        center: [0, 0, outerCenterZ],
        segments: BORE_SEGMENTS,
      }),
    );
    const half = (pocketR + wallT) * 2 + CUT_EPS;
    solids.push(
      subtract(tube, cuboid({ size: [half, half, half * 2], center: [0, half / 2, outerCenterZ] })),
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
// fan box) the blind pilot segments of the inside screw bosses - never a
// hole through the outer weather surface.
export const ventPanelCutouts = (
  params: Params,
  surfacesFilter: Surface[] = ['front', 'back', 'left', 'right', 'bottom'],
): Geom3 | null => {
  const cutouts: Geom3[] = [];

  ventsForSurfaces(params, surfacesFilter).forEach((vent) => {
    const frame = ventFrame(params, vent);
    const parts: Geom3[] = [boreCutout(vent, frame.wallDepth)];
    if (!vent.fanBox) {
      parts.push(...screwBossPilotCutouts(vent.extraScrewHoles ?? [], frame.wallDepth));
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
    const drain = resolveDrainDirection(frame, vent);
    const drainLimit = drainEdgeDistance(params, frame, drain);

    const fins = louvres(vent, frame.wallDepth, drainLimit);
    if (fins) {
      parts.push(fins);
    }

    if (vent.meshPanel) {
      const mesh = meshGrille(vent, frame.wallDepth);
      if (mesh) {
        parts.push(mesh);
      }
    }

    if (!vent.fanBox) {
      const bosses = ventScrewBosses(vent.extraScrewHoles ?? [], frame.wallDepth);
      if (bosses) {
        parts.push(bosses);
      }
    }

    if (vent.fanBox) {
      const box = fanBox(vent, vent.fanBox, frame.wallDepth);
      if (box) {
        const lidFacingBox = rotateZ(fanBoxLidRotation(frame, vent), box);
        // The pocket must admit the fan itself, so on tight builds the duct
        // walls can reach past the enclosure's outer shell (they simply fuse
        // into the enclosure walls on the way). Trim anything that would
        // protrude beyond the outer envelope, e.g. through the floor.
        additions.push(
          intersect(
            placeOnSurface(frame, vent, lidFacingBox),
            cuboid({
              size: [params.width, params.length, params.height],
              center: [params.width / 2, params.length / 2, params.height / 2],
            }),
          ),
        );
      }
    }

    if (vent.rainRing?.enabled) {
      const collar = rainRing(vent, vent.rainRing, frame.wallDepth, drainLimit);
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
