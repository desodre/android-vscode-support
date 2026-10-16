import type { DeviceInfo } from './bridgeClient';

export interface BridgeStream { stop(): void; done: Promise<void> }

/** The part of `BridgeClient` the manager relies on; tests provide a fake. */
export interface ManagedBridge {
  readonly isClosed: boolean;
  startStream(method: string, params: Record<string, unknown>, device: string | undefined,
    listener: (name: string, data: unknown) => void): BridgeStream;
  dispose(): void;
}

/**
 * Owns the Kotlin service process: one start at a time, a new client after the previous one closes,
 * and a device tracking stream for whichever client is current.
 */
export class BridgeManager<C extends ManagedBridge> {
  private client: Promise<C> | undefined;
  private tracking: BridgeStream | undefined;

  constructor(
    private readonly start: () => Promise<C>,
    private readonly onDevicesChanged: (devices: DeviceInfo[]) => void,
    private readonly log: (message: string) => void,
  ) {}

  async get(): Promise<C> {
    const previous = this.client;
    if (previous) {
      const client = await previous;
      if (!client.isClosed) { this.ensureTracking(client); return client; }
      if (this.client === previous) { this.client = undefined; }
    }
    if (!this.client) {
      this.client = this.start().then(client => {
        this.tracking?.stop();
        this.tracking = undefined;
        this.ensureTracking(client);
        return client;
      }).catch(error => {
        this.client = undefined;
        throw error;
      });
    }
    return this.client;
  }

  async dispose(): Promise<void> {
    this.tracking?.stop();
    this.tracking = undefined;
    const client = this.client;
    this.client = undefined;
    await client?.then(value => value.dispose(), () => undefined);
  }

  private ensureTracking(client: C): void {
    if (this.tracking) { return; }
    const tracking = client.startStream('devices.track', {}, undefined, (event, data) => {
      if (event === 'devices.changed') { this.onDevicesChanged(data as DeviceInfo[]); }
    });
    this.tracking = tracking;
    void tracking.done.catch(error => {
      if (this.tracking === tracking && !client.isClosed) {
        this.log(`Monitor de dispositivos encerrado: ${String(error)}`);
      }
    }).finally(() => {
      if (this.tracking === tracking) { this.tracking = undefined; }
    });
  }
}
