import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { AndroidDebugAttacher, AttachOptions, DebugBridge, DebugConfiguration, verifyJdwp, waitForProcess } from '../debug/attach';

const options: AttachOptions = {
  serial: 'emulator-5554', pid: 1234, applicationId: 'com.example.app',
  adapter: 'intellij_jvm', rootPath: '/workspace'
};

function fakeBridge(): { bridge: DebugBridge; calls: Array<[string, Record<string, unknown> | undefined, string | undefined]> } {
  const calls: Array<[string, Record<string, unknown> | undefined, string | undefined]> = [];
  return { bridge: { async request<T>(method: string, params?: Record<string, unknown>, _signal?: AbortSignal, serial?: string): Promise<T> {
    calls.push([method, params, serial]);
    return {} as T;
  } }, calls };
}

test('creates a serial-scoped JDWP forward and removes it when its debug session ends', async () => {
  const { bridge, calls } = fakeBridge();
  let configuration: DebugConfiguration | undefined;
  const attacher = new AndroidDebugAttacher(async config => {
    configuration = config;
    return true;
  }, async () => 45001, async () => undefined);
  assert.equal(await attacher.attach(bridge, options), true);
  assert.equal(configuration?.type, 'intellij_jvm');
  assert.equal(configuration?.port, 45001);
  assert.deepEqual(calls, [['debug.forwardJdwp', { pid: 1234, localPort: 45001 }, 'emulator-5554']]);
  await attacher.onDidTerminate(configuration!);
  await attacher.onDidTerminate(configuration!);
  assert.deepEqual(calls[1], ['debug.removeForward', { localPort: 45001 }, 'emulator-5554']);
  assert.equal(calls.length, 2);
});

test('removes the forward when the adapter refuses or the JDWP probe fails', async () => {
  const refused = fakeBridge();
  const attacher = new AndroidDebugAttacher(async () => false, async () => 45002, async () => undefined);
  assert.equal(await attacher.attach(refused.bridge, options), false);
  assert.deepEqual(refused.calls.map(call => call[0]), ['debug.forwardJdwp', 'debug.removeForward']);

  const failedProbe = fakeBridge();
  const unresponsive = new AndroidDebugAttacher(async () => true, async () => 45003,
    async () => { throw new Error('JDWP indisponível'); });
  await assert.rejects(unresponsive.attach(failedProbe.bridge, options), /JDWP indisponível/);
  assert.deepEqual(failedProbe.calls.map(call => call[0]), ['debug.forwardJdwp', 'debug.removeForward']);
});

test('retries forward removal after a transient bridge failure', async () => {
  const { bridge, calls } = fakeBridge();
  const request = bridge.request.bind(bridge);
  let failures = 1;
  bridge.request = async <T>(method: string, params?: Record<string, unknown>, signal?: AbortSignal, serial?: string): Promise<T> => {
    if (method === 'debug.removeForward' && failures-- > 0) { throw new Error('ADB indisponível'); }
    return request<T>(method, params, signal, serial);
  };
  let configuration: DebugConfiguration | undefined;
  const attacher = new AndroidDebugAttacher(async config => {
    configuration = config;
    return true;
  }, async () => 45004, async () => undefined);
  await attacher.attach(bridge, options);
  await assert.rejects(attacher.onDidTerminate(configuration!), /ADB indisponível/);
  await attacher.dispose();
  assert.deepEqual(calls.map(call => call[0]), ['debug.forwardJdwp', 'debug.removeForward']);
});

test('checks the JDWP handshake before opening the debug adapter', async () => {
  const server = createServer(socket => {
    socket.once('data', data => socket.write(data));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try { await verifyJdwp(address.port); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('waits for the selected package on the selected serial and accepts only valid PIDs', async () => {
  const calls: Array<[string, string | undefined]> = [];
  let polls = 0;
  const bridge: DebugBridge = { async request<T>(
    method: string, _params?: Record<string, unknown>, _signal?: AbortSignal, serial?: string,
  ): Promise<T> {
    calls.push([method, serial]);
    polls++;
    return { pids: polls === 1 ? [] : [4321, 4321, -1] } as T;
  } };
  assert.deepEqual(await waitForProcess(bridge, 'device-a', 'com.example.app', undefined, 1000, 1), [4321]);
  assert.deepEqual(calls, [['debug.findProcess', 'device-a'], ['debug.findProcess', 'device-a']]);
});
