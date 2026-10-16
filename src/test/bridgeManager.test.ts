import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DeviceInfo } from '../bridgeClient';
import { BridgeManager, BridgeStream, ManagedBridge } from '../bridgeManager';

class FakeBridge implements ManagedBridge {
  isClosed = false;
  disposed = false;
  readonly streams: Array<{ method: string; stopped: boolean; end(error?: Error): void;
    emit(name: string, data: unknown): void }> = [];

  startStream(method: string, _params: Record<string, unknown>, _device: string | undefined,
    listener: (name: string, data: unknown) => void): BridgeStream {
    let end!: (error?: Error) => void;
    const done = new Promise<void>((resolve, reject) => { end = error => error ? reject(error) : resolve(); });
    const entry = { method, stopped: false, end, emit: listener };
    this.streams.push(entry);
    return { stop: () => { entry.stopped = true; end(new Error('Operação cancelada.')); }, done };
  }

  dispose(): void { this.disposed = true; this.isClosed = true; }
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('chamadas concorrentes iniciam um único serviço e um único monitor de dispositivos', async () => {
  const clients: FakeBridge[] = [];
  const manager = new BridgeManager(async () => { await tick(); const client = new FakeBridge(); clients.push(client); return client; },
    () => undefined, () => undefined);
  const [first, second] = await Promise.all([manager.get(), manager.get()]);
  assert.equal(first, second);
  assert.equal(clients.length, 1);
  assert.deepEqual(clients[0].streams.map(stream => stream.method), ['devices.track']);
  await manager.get();
  assert.equal(clients[0].streams.length, 1);
});

test('encaminha devices.changed e reinicia o monitor encerrado', async () => {
  const received: DeviceInfo[][] = [];
  const logs: string[] = [];
  const client = new FakeBridge();
  const manager = new BridgeManager(async () => client, devices => received.push(devices), message => logs.push(message));
  await manager.get();
  const devices = [{ serial: 'abc', state: 'device', product: null, model: null, device: null, transportId: 1 }];
  client.streams[0].emit('devices.changed', devices);
  client.streams[0].emit('outro.evento', []);
  assert.deepEqual(received, [devices]);
  client.streams[0].end(new Error('conexão perdida'));
  await tick();
  assert.deepEqual(logs, ['Monitor de dispositivos encerrado: Error: conexão perdida']);
  await manager.get();
  assert.equal(client.streams.length, 2);
});

test('substitui um serviço encerrado e para o monitor antigo', async () => {
  const clients: FakeBridge[] = [];
  const logs: string[] = [];
  const manager = new BridgeManager(async () => { const client = new FakeBridge(); clients.push(client); return client; },
    () => undefined, message => logs.push(message));
  const first = await manager.get();
  first.isClosed = true;
  const second = await manager.get();
  assert.notEqual(first, second);
  assert.equal(first.streams[0].stopped, true);
  assert.equal(second.streams.length, 1);
  await tick();
  assert.deepEqual(logs, [], 'monitor de cliente encerrado não gera log');
});

test('falha de inicialização permite nova tentativa', async () => {
  let attempts = 0;
  const manager = new BridgeManager(async () => {
    attempts++;
    if (attempts === 1) { throw new Error('JDK ausente'); }
    return new FakeBridge();
  }, () => undefined, () => undefined);
  await assert.rejects(manager.get(), /JDK ausente/);
  assert.ok(await manager.get());
  assert.equal(attempts, 2);
});

test('dispose para o monitor e encerra o serviço', async () => {
  const client = new FakeBridge();
  const manager = new BridgeManager(async () => client, () => undefined, () => undefined);
  await manager.get();
  await manager.dispose();
  assert.equal(client.streams[0].stopped, true);
  assert.equal(client.disposed, true);
  await manager.dispose();
});
