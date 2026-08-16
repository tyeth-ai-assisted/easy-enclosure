import { intersect } from '@jscad/modeling/src/operations/booleans';
import measureVolume from '@jscad/modeling/src/measurements/measureVolume';
import { cuboid } from '@jscad/modeling/src/primitives';
import { DEFAULT_PARAMS, DEFAULT_VENT_FAN_BOX, cloneParams } from '../params';
import { ventPanelAdditions } from './ventpanel';

describe('ventPanelAdditions', () => {
  it('keeps a wall-mounted fan box open towards the lid when louvres drain right', () => {
    const params = cloneParams(DEFAULT_PARAMS);
    params.width = 200;
    params.length = 200;
    params.height = 200;
    params.ventPanels = [
      {
        surface: 'front',
        x: 0,
        y: 0,
        diameter: 20,
        louvreCount: 4,
        louvreAngle: 45,
        louvreThickness: 1.2,
        louvreDrainSurface: 'right',
        meshPanel: false,
        meshHoleSize: 4,
        meshPitch: 6,
        meshThickness: 1.2,
        fanBox: {
          ...DEFAULT_VENT_FAN_BOX,
          frameSize: 40,
          depth: 20,
          wallThickness: 2,
        },
        extraScrewHoles: [],
      },
    ];

    const additions = ventPanelAdditions(params);
    expect(additions).not.toBeNull();

    const totalWallThickness =
      params.insertThickness + params.insertClearance * 2 + params.wall * 2;
    const ventCenterY = params.length - totalWallThickness / 2;
    const pocket = params.ventPanels[0].fanBox!.frameSize + 0.5;
    const wallThickness = params.ventPanels[0].fanBox!.wallThickness;
    const wallCenterOffset = (pocket + wallThickness) / 2;
    const probeSize: [number, number, number] = [5, 5, 1];
    const boxMidY = ventCenterY - params.ventPanels[0].fanBox!.depth / 2;

    const lidSideProbe = cuboid({
      size: probeSize,
      center: [params.width / 2, boxMidY, params.height / 2 + wallCenterOffset],
    });
    const floorSideProbe = cuboid({
      size: probeSize,
      center: [params.width / 2, boxMidY, params.height / 2 - wallCenterOffset],
    });

    expect(measureVolume(intersect(additions!, lidSideProbe))).toBeLessThan(0.001);
    expect(measureVolume(intersect(additions!, floorSideProbe))).toBeGreaterThan(1);
  });

  it('gives a rectangular fan box a width x depth pocket independent of wall thickness', () => {
    // Front vent draining to the bottom: canonical X maps to world -X,
    // canonical Y (open-face axis) to world +Z, canonical Z (outward) to
    // world +Y, and the fan box lid rotation is 0.
    const frameWidth = 81;
    const frameDepth = 26;
    const boxDepth = 30;
    const inset = 4.5;
    const holeDiameter = 4;
    const offsetX = frameWidth / 2 - inset;
    const offsetY = frameDepth / 2 - inset;

    for (const wallThickness of [2.5, 5]) {
      const params = cloneParams(DEFAULT_PARAMS);
      params.width = 200;
      params.length = 200;
      params.height = 200;
      params.ventPanels = [
        {
          surface: 'front',
          x: 0,
          y: 0,
          // Deliberately larger than the slim plate: the plate's airflow
          // opening must be clamped so the screw pattern survives.
          diameter: 112,
          louvreCount: 4,
          louvreAngle: 45,
          louvreThickness: 1.2,
          louvreDrainSurface: 'bottom',
          meshPanel: false,
          meshHoleSize: 4,
          meshPitch: 6,
          meshThickness: 1.2,
          fanBox: {
            ...DEFAULT_VENT_FAN_BOX,
            frameShape: 'rectangle',
            frameWidth,
            frameDepth,
            depth: boxDepth,
            wallThickness,
            screwHoleInset: inset,
            screwHoleDiameter: holeDiameter,
          },
          extraScrewHoles: [],
        },
      ];

      const additions = ventPanelAdditions(params);
      expect(additions).not.toBeNull();

      const totalWallThickness =
        params.insertThickness + params.insertClearance * 2 + params.wall * 2;
      const ventCenterY = params.length - totalWallThickness / 2;
      const plateT = wallThickness;
      const z0 = -totalWallThickness / 2 - boxDepth;
      const z1 = -totalWallThickness / 2 + 1;
      const pocketMidZ = (z0 + plateT + z1) / 2;
      const plateMidZ = z0 + plateT / 2;
      const pocketW = frameWidth + 0.5;
      const pocketD = frameDepth + 0.5;

      const world = (cx: number, cy: number, cz: number): [number, number, number] => [
        params.width / 2 - cx,
        ventCenterY + cz,
        params.height / 2 + cy,
      ];

      // Clear pocket: a slab 0.1mm smaller than width x depth fits...
      const clearProbe = cuboid({
        size: [pocketW - 0.1, 1, pocketD - 0.1],
        center: world(0, 0, pocketMidZ),
      });
      expect(measureVolume(intersect(additions!, clearProbe))).toBeLessThan(0.001);
      // ...and one 0.1mm larger hits the duct walls.
      const oversizeProbe = cuboid({
        size: [pocketW + 0.1, 1, pocketD + 0.1],
        center: world(0, 0, pocketMidZ),
      });
      expect(measureVolume(intersect(additions!, oversizeProbe))).toBeGreaterThan(1);

      // The end plate survives the oversized bore: solid at a pocket corner...
      const cornerProbe = cuboid({
        size: [1, plateT - 0.2, 1],
        center: world(39, -12, plateMidZ),
      });
      expect(measureVolume(intersect(additions!, cornerProbe))).toBeGreaterThan(0.05);
      // ...and on the rib between the airflow opening and a screw hole.
      const holeDist = Math.hypot(offsetX, offsetY);
      const ribRadial = holeDist - holeDiameter / 2 - 0.6;
      const ribProbe = cuboid({
        size: [0.6, plateT - 0.2, 0.6],
        center: world((offsetX / holeDist) * ribRadial, (offsetY / holeDist) * ribRadial, plateMidZ),
      });
      expect(measureVolume(intersect(additions!, ribProbe))).toBeGreaterThan(0.05);
      // The corner screw hole itself is open through the plate.
      const holeProbe = cuboid({
        size: [1, plateT + 1, 1],
        center: world(offsetX, offsetY, plateMidZ),
      });
      expect(measureVolume(intersect(additions!, holeProbe))).toBeLessThan(0.001);
    }
  });
});
