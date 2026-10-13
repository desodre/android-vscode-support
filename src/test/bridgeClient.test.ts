import assert from 'node:assert/strict';
import { once } from 'node:events';
import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, Server, Socket } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { BridgeClient, DeviceInfo } from '../bridgeClient';

let server: Server;
let port: number;
let client: BridgeClient;
const sockets = new Set<Socket>();
let holdNextVersion = false;
let heldSocket: Socket | undefined;
let onHeldRequest: (() => void) | undefined;

function frame(payload: string): Buffer {
  const bytes = Buffer.from(payload, 'utf8');
  return Buffer.concat([Buffer.from(`OKAY${bytes.length.toString(16).toUpperCase().padStart(4, '0')}`), bytes]);
}

before(async () => {
  server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) { return; }
      const length = Number.parseInt(buffer.subarray(0, 4).toString(), 16);
      if (buffer.length < 4 + length) { return; }
      const request = buffer.subarray(4, 4 + length).toString();
      if (request === 'host:version' && holdNextVersion) {
        holdNextVersion = false;
        heldSocket = socket;
        onHeldRequest?.();
      } else if (request === 'host:version') { socket.end(frame('0029')); }
      else if (request === 'host:devices-l') {
        socket.end(frame('emulator-5554\tdevice product:sdk model:Pixel_9 device:emu transport_id:1\n'));
      } else { socket.destroy(); }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  port = address.port;
  client = await BridgeClient.start(
    process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'java') : 'java',
    join(process.cwd(), 'bridge', 'build', 'install', 'bridge', 'lib'),
    '127.0.0.1', port, () => undefined
  );
});

after(async () => {
  client?.dispose();
  for (const socket of sockets) { socket.destroy(); }
  await new Promise<void>(resolve => server.close(() => resolve()));
});

test('consulta versão e dispositivos simultaneamente usando adb-utils', async () => {
  const [version, devices] = await Promise.all([
    client.request<{ version: number }>('server.version'),
    client.request<DeviceInfo[]>('devices.list')
  ]);
  assert.equal(version.version, 41);
  assert.deepEqual(devices, [{
    serial: 'emulator-5554', state: 'device', product: 'sdk', model: 'Pixel_9', device: 'emu', transportId: 1
  }]);
});

test('retorna erro para operação desconhecida e continua atendendo', async () => {
  await assert.rejects(client.request('missing.operation'), /Operação desconhecida/);
  assert.equal((await client.request<{ version: number }>('server.version')).version, 41);
});

test('cancela requisição antes do envio', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.request('server.version', {}, controller.signal), /cancelada/);
});

test('cancela requisição em andamento e libera a conexão ADB', async () => {
  holdNextVersion = true;
  const received = new Promise<void>(resolve => { onHeldRequest = resolve; });
  const controller = new AbortController();
  const request = client.request('server.version', {}, controller.signal);
  await received;
  assert(heldSocket);
  const closed = once(heldSocket, 'close', { signal: AbortSignal.timeout(3000) });
  controller.abort();
  await assert.rejects(request, /cancelada/);
  await closed;
  assert.equal((await client.request<{ version: number }>('server.version')).version, 41);
});

test('encerra o processo Kotlin ao desativar o cliente', async () => {
  const process = (client as unknown as { process: ChildProcessWithoutNullStreams }).process;
  const exited = once(process, 'exit', { signal: AbortSignal.timeout(3000) });
  client.dispose();
  await exited;
});
