import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
