import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import test, { type TestContext } from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseEmulatorPort, listAvds, startAvd } from '../emulator';

test('lista AVDs existentes e rejeita nome inexistente antes de iniciar', async t => {
  if (process.platform === 'win32') { t.skip('Fixture usa um executável POSIX'); return; }
  const sdk = mkdtempSync(join(tmpdir(), 'android-emulator-'));
  t.after(() => rmSync(sdk, { recursive: true, force: true }));
  mkdirSync(join(sdk, 'emulator'));
  const binary = join(sdk, 'emulator', 'emulator');
  writeFileSync(binary, '#!/bin/sh\nprintf "Pixel_8\\nPixel_9\\n"\n');
  chmodSync(binary, 0o755);
  assert.deepEqual(await listAvds(sdk), ['Pixel_8', 'Pixel_9']);
  await assert.rejects(startAvd(sdk, '/missing/adb', 'Unknown', []), /AVD não encontrado/);
  const alternate = join(sdk, 'alternate-emulator');
  writeFileSync(alternate, '#!/bin/sh\nprintf "Fallback_AVD\\n"\n');
  chmodSync(alternate, 0o755);
  assert.deepEqual(await listAvds(sdk, undefined, alternate), ['Fallback_AVD']);
  await assert.rejects(startAvd(sdk, '/missing/adb', 'Pixel_8', [], undefined, alternate), /AVD não encontrado/);
  await assert.rejects(listAvds(sdk, undefined, 'relative/emulator'), /caminho absoluto/);
});

test('reserva par de portas par e evita serial de emulador ativo', async () => {
  const checked: number[] = [];
  const port = await chooseEmulatorPort(['emulator-5554'], async value => {
    checked.push(value);
    return value !== 5557;
  });
  assert.equal(port, 5558);
  assert.deepEqual(checked, [5556, 5557, 5558, 5559]);
});

function fakeAvd(t: TestContext,
  mode: 'boot' | 'exit' | 'race' | 'wait' | 'stubborn' | 'adb-fail' | 'spawn-fail') {
  const root = mkdtempSync(join(tmpdir(), 'android-avd-lifecycle-'));
  const sdk = join(root, 'sdk');
  const pidFile = join(root, 'emulator.pid');
  mkdirSync(join(sdk, 'emulator'), { recursive: true });
  const emulator = join(sdk, 'emulator', 'emulator');
  const adb = join(root, 'adb');
  writeFileSync(emulator, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('-list-avds')) {
  process.stdout.write('TestAVD\\n');
  ${mode === 'spawn-fail' ? 'fs.unlinkSync(__filename);' : ''}
} else {
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  ${mode === 'exit' || mode === 'race' ? "console.error('porta ocupada na inicialização'); process.exit(17);" : 'setInterval(() => {}, 1000);'}
  ${mode === 'stubborn' ? "process.on('SIGTERM', () => {});" : ''}
}
`);
  writeFileSync(adb, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'start-server') {
  ${mode === 'adb-fail' ? "console.error('servidor indisponível'); process.exit(2);" : 'process.exit(0);'}
}
if (args.includes('get-state')) { console.log(${mode === 'boot' || mode === 'race' ? "'device'" : "'offline'"}); }
else if (args.includes('sys.boot_completed')) { console.log('1'); }
`);
  chmodSync(emulator, 0o755);
  chmodSync(adb, 0o755);
  t.after(() => {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already stopped */ }
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { sdk, adb, pidFile };
}

async function fakePid(file: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(file)) { return Number(readFileSync(file, 'utf8')); }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('O emulador falso não iniciou.');
}

function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch { return false; }
}

test('AVD pronto retorna somente o serial do processo iniciado', async t => {
  if (process.platform === 'win32') { t.skip('Fixture usa executáveis POSIX'); return; }
  const { sdk, adb, pidFile } = fakeAvd(t, 'boot');
  assert.equal(execFileSync(join(sdk, 'emulator', 'emulator'), ['-list-avds'], { encoding: 'utf8' }), 'TestAVD\n');
  assert.deepEqual(await listAvds(sdk), ['TestAVD']);
  const serial = await startAvd(sdk, adb, 'TestAVD', [], undefined, undefined,
    { bootTimeoutMs: 5_000, pollIntervalMs: 20 });
  assert.match(serial, /^emulator-\d+$/);
  assert.ok(groupAlive(await fakePid(pidFile)));
});

test('falha de início do AVD mostra stderr e encerra o processo', async t => {
  if (process.platform === 'win32') { t.skip('Fixture usa executáveis POSIX'); return; }
  const { sdk, adb, pidFile } = fakeAvd(t, 'exit');
  await assert.rejects(startAvd(sdk, adb, 'TestAVD', [], undefined, undefined,
    { bootTimeoutMs: 5_000, pollIntervalMs: 20 }), /Emulador encerrou.*porta ocupada/);
  assert.equal(groupAlive(await fakePid(pidFile)), false);
});

test('porta tomada entre verificação e spawn não aceita outro emulador como sucesso', async t => {
  if (process.platform === 'win32') { t.skip('Fixture usa executáveis POSIX'); return; }
  const { sdk, adb } = fakeAvd(t, 'race');
  await assert.rejects(startAvd(sdk, adb, 'TestAVD', [], undefined, undefined,
    { bootTimeoutMs: 5_000, pollIntervalMs: 20 }), /Emulador encerrou.*porta ocupada/);
});

test('cancelamento encerra apenas o emulador recém-iniciado', async t => {
  if (process.platform === 'win32') { t.skip('Fixture usa executáveis POSIX'); return; }
  const { sdk, adb, pidFile } = fakeAvd(t, 'wait');
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
    { detached: true, stdio: 'ignore' });
  t.after(() => { if (unrelated.pid) { try { process.kill(-unrelated.pid, 'SIGKILL'); } catch {} } });
  const controller = new AbortController();
  const starting = startAvd(sdk, adb, 'TestAVD', ['emulator-5554'], controller.signal,
    undefined, { bootTimeoutMs: 5_000, pollIntervalMs: 20 });
  const pid = await fakePid(pidFile);
  controller.abort();
  await assert.rejects(starting, /cancelada/);
  assert.equal(groupAlive(pid), false);
  assert.ok(unrelated.pid && groupAlive(unrelated.pid));
});

test('timeout e falha do ADB encerram o emulador iniciado', async t => {
  if (process.platform === 'win32') { t.skip('Fixture usa executáveis POSIX'); return; }
  for (const mode of ['wait', 'adb-fail'] as const) {
    const { sdk, adb, pidFile } = fakeAvd(t, mode);
    await assert.rejects(startAvd(sdk, adb, 'TestAVD', [], undefined, undefined,
      { bootTimeoutMs: 300, pollIntervalMs: 20 }),
    mode === 'wait' ? /Tempo esgotado/ : /Falha ao iniciar o servidor ADB/);
    assert.equal(groupAlive(await fakePid(pidFile)), false);
  }
});

test('emulador que ignora SIGTERM é encerrado à força no timeout', async t => {
  if (process.platform === 'win32') { t.skip('Fixture usa executáveis POSIX'); return; }
  const { sdk, adb, pidFile } = fakeAvd(t, 'stubborn');
  await assert.rejects(startAvd(sdk, adb, 'TestAVD', [], undefined, undefined,
    { bootTimeoutMs: 300, pollIntervalMs: 20 }), /Tempo esgotado/);
  assert.equal(groupAlive(await fakePid(pidFile)), false);
});

test('falha de spawn retorna erro sem aguardar boot', async t => {
  if (process.platform === 'win32') { t.skip('Fixture usa executáveis POSIX'); return; }
  const { sdk, adb } = fakeAvd(t, 'spawn-fail');
  await assert.rejects(startAvd(sdk, adb, 'TestAVD', [], undefined, undefined,
    { bootTimeoutMs: 2_000, pollIntervalMs: 20 }), /Emulador encerrou/);
});
