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
});
