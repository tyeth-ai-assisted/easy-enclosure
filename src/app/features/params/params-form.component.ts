import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import type {
  Hole,
  InternalWall,
  PCBMount,
  Params,
  VentExtraScrewHole,
  VentFanBox,
  VentPanel,
  VentRainRing,
} from '../../core/params';
import { DEFAULT_VENT_FAN_BOX, DEFAULT_VENT_RAIN_RING } from '../../core/params';
import { EnclosureStateService } from '../../core/state/enclosure-state.service';

type Surface = 'top' | 'bottom' | 'left' | 'right' | 'front' | 'back';

@Component({
  selector: 'app-params-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './params-form.component.html',
  styleUrl: './params-form.component.css',
})
export class ParamsFormComponent {
  private readonly state = inject(EnclosureStateService);

  readonly activeTab = signal<number | null>(null);

  readonly surfaces: Surface[] = ['front', 'right', 'back', 'left', 'top', 'bottom'];

  surfaceLabel(surface: Surface): string {
    if (surface === 'top') {
      return 'Lid';
    }
    return surface[0].toUpperCase() + surface.slice(1);
  }

  params(): Params {
    return this.state.params();
  }

  setActiveTab(tab: number): void {
    this.activeTab.set(this.activeTab() === tab ? null : tab);
  }

  resetToSimpleEnclosure(): void {
    this.state.resetToSimpleEnclosure();
    this.activeTab.set(1);
  }

  setNumberParam<K extends keyof Params>(key: K, rawValue: string): void {
    if (!rawValue) {
      return;
    }
    const parsed = parseFloat(rawValue);
    if (!Number.isNaN(parsed)) {
      this.state.updateParam(key, parsed as Params[K]);
    }
  }

  setBooleanParam<K extends keyof Params>(key: K, checked: boolean): void {
    this.state.updateParam(key, checked as Params[K]);
  }

  addHole(): void {
    const current = this.params();
    const next: Hole = {
      shape: 'circle',
      surface: 'front',
      diameter: 12.5,
      width: 10,
      length: 10,
      y: current.width / 2,
      x: 6,
    };
    this.state.patchParams({ holes: [...current.holes, next] });
  }

  removeHole(index: number): void {
    const current = this.params();
    this.state.patchParams({ holes: current.holes.filter((_, i) => i !== index) });
  }

  updateHole(index: number, patch: Partial<Hole>): void {
    const current = this.params();
    this.state.patchParams({
      holes: current.holes.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    });
  }

  addPcbMount(): void {
    const current = this.params();
    const next: PCBMount = {
      surface: 'bottom',
      x: 0,
      y: 0,
      height: 5,
      outerDiameter: 6,
      screwDiameter: 2,
    };
    this.state.patchParams({ pcbMounts: [...current.pcbMounts, next] });
  }

  removePcbMount(index: number): void {
    const current = this.params();
    this.state.patchParams({ pcbMounts: current.pcbMounts.filter((_, i) => i !== index) });
  }

  updatePcbMount(index: number, patch: Partial<PCBMount>): void {
    const current = this.params();
    this.state.patchParams({
      pcbMounts: current.pcbMounts.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    });
  }

  addInternalWall(): void {
    const current = this.params();
    const next: InternalWall = {
      x: 0,
      y: 0,
      height: 10,
      length: 25,
      thickness: 2,
      rotation: 0,
    };
    this.state.patchParams({ internalWalls: [...current.internalWalls, next] });
  }

  removeInternalWall(index: number): void {
    const current = this.params();
    this.state.patchParams({ internalWalls: current.internalWalls.filter((_, i) => i !== index) });
  }

  updateInternalWall(index: number, patch: Partial<InternalWall>): void {
    const current = this.params();
    this.state.patchParams({
      internalWalls: current.internalWalls.map((item, i) =>
        i === index ? { ...item, ...patch } : item,
      ),
    });
  }

  addVentPanel(): void {
    const current = this.params();
    const next: VentPanel = {
      surface: 'front',
      x: 0,
      y: 0,
      diameter: 40,
      louvreCount: 5,
      louvreAngle: 45,
      louvreThickness: 1.2,
      louvreDrainSurface: 'bottom',
      meshPanel: false,
      meshHoleSize: 4,
      meshPitch: 6,
      meshThickness: 1.2,
      extraScrewHoles: [],
    };
    this.state.patchParams({ ventPanels: [...current.ventPanels, next] });
  }

  removeVentPanel(index: number): void {
    const current = this.params();
    this.state.patchParams({ ventPanels: current.ventPanels.filter((_, i) => i !== index) });
  }

  updateVentPanel(index: number, patch: Partial<VentPanel>): void {
    const current = this.params();
    this.state.patchParams({
      ventPanels: current.ventPanels.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    });
  }

  toggleVentFanBox(index: number, enabled: boolean): void {
    this.updateVentPanel(index, {
      fanBox: enabled ? { ...DEFAULT_VENT_FAN_BOX, extraScrewHoles: [] } : undefined,
    });
  }

  updateVentFanBox(index: number, patch: Partial<VentFanBox>): void {
    const current = this.params().ventPanels[index];
    if (!current?.fanBox) {
      return;
    }
    this.updateVentPanel(index, { fanBox: { ...current.fanBox, ...patch } });
  }

  toggleVentRainRing(index: number, enabled: boolean): void {
    this.updateVentPanel(index, {
      rainRing: enabled ? { ...DEFAULT_VENT_RAIN_RING } : undefined,
    });
  }

  updateVentRainRing(index: number, patch: Partial<VentRainRing>): void {
    const current = this.params().ventPanels[index];
    if (!current?.rainRing) {
      return;
    }
    this.updateVentPanel(index, { rainRing: { ...current.rainRing, ...patch } });
  }

  addVentFanBoxScrewHole(index: number): void {
    const current = this.params().ventPanels[index];
    if (!current?.fanBox) {
      return;
    }
    const next: VentExtraScrewHole = {
      angleDeg: 90,
      radius: current.diameter / 2 + 8,
      diameter: 4.3,
    };
    this.updateVentFanBox(index, {
      extraScrewHoles: [...current.fanBox.extraScrewHoles, next],
    });
  }

  removeVentFanBoxScrewHole(index: number, holeIndex: number): void {
    const current = this.params().ventPanels[index];
    if (!current?.fanBox) {
      return;
    }
    this.updateVentFanBox(index, {
      extraScrewHoles: current.fanBox.extraScrewHoles.filter((_, i) => i !== holeIndex),
    });
  }

  updateVentFanBoxScrewHole(
    index: number,
    holeIndex: number,
    patch: Partial<VentExtraScrewHole>,
  ): void {
    const current = this.params().ventPanels[index];
    if (!current?.fanBox) {
      return;
    }
    this.updateVentFanBox(index, {
      extraScrewHoles: current.fanBox.extraScrewHoles.map((item, i) =>
        i === holeIndex ? { ...item, ...patch } : item,
      ),
    });
  }

  addVentWallScrewHole(index: number): void {
    const current = this.params().ventPanels[index];
    if (!current) {
      return;
    }
    const next: VentExtraScrewHole = {
      angleDeg: 90,
      radius: current.diameter / 2 + 8,
      diameter: 4.3,
      outerDiameter: 8.3,
      height: 5,
      throughWall: false,
      internalHeight: 0,
    };
    this.updateVentPanel(index, { extraScrewHoles: [...current.extraScrewHoles, next] });
  }

  removeVentWallScrewHole(index: number, holeIndex: number): void {
    const current = this.params().ventPanels[index];
    if (!current) {
      return;
    }
    this.updateVentPanel(index, {
      extraScrewHoles: current.extraScrewHoles.filter((_, i) => i !== holeIndex),
    });
  }

  updateVentWallScrewHole(
    index: number,
    holeIndex: number,
    patch: Partial<VentExtraScrewHole>,
  ): void {
    const current = this.params().ventPanels[index];
    if (!current) {
      return;
    }
    this.updateVentPanel(index, {
      extraScrewHoles: current.extraScrewHoles.map((item, i) =>
        i === holeIndex ? { ...item, ...patch } : item,
      ),
    });
  }

  onWaterproofChange(checked: boolean): void {
    this.state.patchParams({
      waterProof: checked,
      lidScrews: checked ? true : this.params().lidScrews,
    });
  }

  onLidScrewsChange(checked: boolean): void {
    this.state.patchParams({
      lidScrews: checked,
      waterProof: checked ? this.params().waterProof : false,
    });
  }

  parseIntValue(rawValue: string): number {
    return parseInt(rawValue, 10);
  }
}
