import type { DeviceInfo } from './bridgeClient';
import type { MementoLike } from './selection';

export const DEVICE_STATE_KEY = 'androidSupport.deviceSerial.v1';

export interface DeviceSelectionUi {
  pick(devices: readonly DeviceInfo[], current?: string): Promise<string | undefined>;
}

/** Keeps an explicit per-workspace serial. A stale or unavailable serial is never used. */
export class DeviceSelectionStore {
  private serial: string | undefined;
  private staleEmulatorSelection: boolean;
  private devices: DeviceInfo[] = [];
  private hasSnapshot = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly memento: MementoLike) {
    const saved = memento.get<string>(DEVICE_STATE_KEY);
    this.staleEmulatorSelection = typeof saved === 'string' && /^emulator-\d+$/.test(saved);
    this.serial = typeof saved === 'string' && saved.length > 0 && !this.staleEmulatorSelection ? saved : undefined;
  }

  get selectedSerial(): string | undefined {
    return this.hasSnapshot && this.devices.some(device => device.serial === this.serial && device.state === 'device')
      ? this.serial : undefined;
  }

  get snapshot(): readonly DeviceInfo[] { return [...this.devices]; }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  async updateDevices(devices: readonly DeviceInfo[]): Promise<void> {
    this.devices = [...devices];
    this.hasSnapshot = true;
    if (this.staleEmulatorSelection) {
      await this.memento.update(DEVICE_STATE_KEY, undefined);
      this.staleEmulatorSelection = false;
    }
    if (this.serial && !this.devices.some(device => device.serial === this.serial && device.state === 'device')) {
      this.serial = undefined;
      await this.memento.update(DEVICE_STATE_KEY, undefined);
    }
    this.notify();
  }

  async select(serial: string): Promise<void> {
    if (!this.hasSnapshot) { throw new Error('A lista de dispositivos ADB ainda não foi recebida.'); }
    const device = this.devices.find(item => item.serial === serial);
    if (!device) { throw new Error(`Dispositivo ${serial} não encontrado.`); }
    if (device.state !== 'device') { throw new Error(`Dispositivo ${serial} está ${device.state}.`); }
    this.serial = serial;
    await this.memento.update(DEVICE_STATE_KEY, /^emulator-\d+$/.test(serial) ? undefined : serial);
    this.notify();
  }

  async pick(ui: DeviceSelectionUi): Promise<string | undefined> {
    if (!this.hasSnapshot) { throw new Error('A lista de dispositivos ADB ainda não foi recebida.'); }
    if (this.devices.length === 0) { throw new Error('Nenhum dispositivo ADB encontrado.'); }
    const chosen = await ui.pick(this.devices, this.selectedSerial);
    if (!chosen) { return undefined; }
    await this.select(chosen);
    return chosen;
  }

  private notify(): void { for (const listener of this.listeners) { listener(); } }
}

export function createVscodeDeviceSelectionUi(): DeviceSelectionUi {
  return {
    async pick(devices, current) {
      // Loaded only when invoked, so DeviceSelectionStore remains unit testable outside VS Code.
      const vscode = require('vscode') as typeof import('vscode');
      const items = devices.map(device => ({
        label: device.serial,
        description: `${device.state}${device.model ? ` · ${device.model}` : ''}${device.serial === current ? ' · selecionado' : ''}`,
        detail: device.state === 'unauthorized' ? 'Autorize a depuração USB no dispositivo.'
          : device.state === 'offline' ? 'Dispositivo ADB offline.' : undefined,
        value: device.serial
      }));
      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Selecione explicitamente um dispositivo Android',
        matchOnDescription: true
      });
      return selected?.value;
    }
  };
}
