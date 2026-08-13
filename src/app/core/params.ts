import type { Surface } from './enclosure';

export type Hole = {
  shape: 'circle' | 'square' | 'rectangle';
  diameter: number;
  width: number;
  length: number;
  surface: Surface;
  x: number;
  y: number;
};

export type PCBMount = {
  surface: Surface;
  x: number;
  y: number;
  height: number;
  outerDiameter: number;
  screwDiameter: number;
};

export type InternalWall = {
  x: number;
  y: number;
  height: number;
  length: number;
  thickness: number;
  rotation: number;
};

// A single screw hole positioned in polar coordinates around a vent centre.
// angleDeg is measured in the vent's local plane: 0 deg points towards the
// panel's local +X, 90 deg points away from the drain direction ("up" when
// draining towards the bottom).
export type VentExtraScrewHole = {
  angleDeg: number;
  radius: number;
  diameter: number;
};

export type VentFanBox = {
  frameShape: 'square' | 'circle';
  frameSize: number;
  depth: number;
  wallThickness: number;
  // Square axial fans: 4 corner holes inset from the frame edge.
  screwHoleInset: number;
  screwHoleDiameter: number;
  // Circular (blower) fans: irregular mounting ears outside the frame radius.
  extraScrewHoles: VentExtraScrewHole[];
};

export type VentPanel = {
  surface: Surface;
  x: number;
  y: number;
  // Clear airflow bore through the wall (normally somewhat smaller than the
  // fan's outer frame size).
  diameter: number;
  louvreCount: number;
  // Blade angle in degrees measured from the wall plane (45 = classic rain
  // louvre, smaller = flatter/more closed, larger = more open).
  louvreAngle: number;
  louvreThickness: number;
  // Which enclosure surface the louvre blades slope towards, i.e. the "low"
  // edge water runs off towards.
  louvreDrainSurface: Surface;
  meshPanel: boolean;
  // Square grille openings of meshHoleSize, spaced meshPitch apart.
  meshHoleSize: number;
  meshPitch: number;
  meshThickness: number;
  // Optional stand-off duct on the inside of the wall that carries the fan
  // on its inner mounting plate, behind the louvres (which stay outermost).
  fanBox?: VentFanBox;
  // Screw holes cut straight through the wall around the vent, for mounting a
  // fan flush against the inside of the wall when there is no fan box.
  extraScrewHoles: VentExtraScrewHole[];
};

export const DEFAULT_VENT_FAN_BOX: VentFanBox = {
  frameShape: 'square',
  frameSize: 120,
  depth: 30,
  wallThickness: 2.5,
  screwHoleInset: 7.5,
  screwHoleDiameter: 4.4,
  extraScrewHoles: [],
};

export type Params = {
  length: number;
  width: number;
  height: number;
  floor: number;
  roof: number;
  wall: number;
  waterProof: boolean;
  sealThickness: number;
  insertThickness: number;
  insertHeight: number;
  insertClearance: number;
  showLid: boolean;
  showBase: boolean;
  showGrid: boolean;
  gridSpacing: number;
  cornerRadius: number;
  holes: Hole[];
  pcbMounts: PCBMount[];
  internalWalls: InternalWall[];
  ventPanels: VentPanel[];
  wallMounts: boolean;
  wallMountCount: number;
  wallMountScrewDiameter: number;
  lidScrews: boolean;
  lidScrewDiameter: number;
  baseLidScrewDiameter: number;
};

export const DEFAULT_PARAMS: Params = {
  length: 80,
  width: 100,
  height: 30,
  floor: 2,
  roof: 2,
  wall: 1,
  waterProof: true,
  sealThickness: 2,
  insertThickness: 2,
  insertHeight: 4,
  insertClearance: 0.04,
  showLid: true,
  showBase: true,
  showGrid: true,
  gridSpacing: 10,
  cornerRadius: 3,
  holes: [
    {
      shape: 'circle',
      surface: 'front',
      diameter: 12.5,
      width: 10,
      length: 10,
      x: 0,
      y: 0,
    },
    {
      shape: 'square',
      surface: 'left',
      diameter: 10,
      width: 12,
      length: 10,
      x: 0,
      y: 0,
    },
    {
      shape: 'rectangle',
      surface: 'back',
      width: 40,
      length: 6,
      diameter: 10,
      x: 0,
      y: 0,
    },
    {
      shape: 'square',
      surface: 'right',
      width: 12.5,
      length: 10,
      diameter: 10,
      x: 0,
      y: 0,
    },
    {
      shape: 'square',
      surface: 'top',
      width: 30,
      length: 10,
      diameter: 10,
      x: 0,
      y: 0,
    },
  ],
  pcbMounts: [
    {
      surface: 'bottom',
      x: 30,
      y: 24,
      height: 5,
      outerDiameter: 6,
      screwDiameter: 2,
    },
    {
      surface: 'bottom',
      x: -30,
      y: 24,
      height: 5,
      outerDiameter: 6,
      screwDiameter: 2,
    },
    {
      surface: 'bottom',
      x: -30,
      y: -24,
      height: 5,
      outerDiameter: 6,
      screwDiameter: 2,
    },
    {
      surface: 'bottom',
      x: 30,
      y: -24,
      height: 5,
      outerDiameter: 6,
      screwDiameter: 2,
    },
  ],
  internalWalls: [
    {
      x: 0,
      y: 0,
      height: 10,
      length: 25,
      thickness: 2,
      rotation: 0,
    },
  ],
  ventPanels: [],
  wallMounts: true,
  wallMountCount: 4,
  wallMountScrewDiameter: 3.98,
  lidScrews: true,
  lidScrewDiameter: 2.98,
  baseLidScrewDiameter: 2.88,
};

export const cloneParams = (params: Params): Params => {
  return JSON.parse(JSON.stringify(params)) as Params;
};
