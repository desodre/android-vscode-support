import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DeviceInfo } from '../bridgeClient';
import { DEVICE_STATE_KEY, DeviceSelectionStore } from '../deviceSelection';

const device = (serial: string, state: string): DeviceInfo => ({
  serial, state, product: null, model: null, device: null, transportId: null
});

function memory(initial?: string) {
  const values = new Map<string, unknown>();
  if (initial) { values.set(DEVICE_STATE_KEY, initial); }
  return {
    get<T>(key: string): T | undefined { return values.get(key) as T | undefined; },
    async update(key: string, value: unknown) { values.set(key, value); }
  };
}

test('does not silently choose the sole connected device', async () => {
  const selection = new DeviceSelectionStore(memory());
  await selection.updateDevices([device('emulator-5554', 'device')]);
  assert.equal(selection.selectedSerial, undefined);
  assert.equal(await selection.pick({ pick: async () => undefined }), undefined);
  assert.equal(selection.selectedSerial, undefined);
  assert.equal(await selection.pick({ pick: async () => 'emulator-5554' }), 'emulator-5554');
  assert.equal(selection.selectedSerial, 'emulator-5554');
});

test('persisted serial needs a fresh online snapshot and is cleared on disconnect', async () => {
  const state = memory('usb-1');
  const selection = new DeviceSelectionStore(state);
  assert.equal(selection.selectedSerial, undefined);
  await selection.updateDevices([device('usb-1', 'device')]);
  assert.equal(selection.selectedSerial, 'usb-1');
  await selection.updateDevices([]);
  assert.equal(selection.selectedSerial, undefined);
  assert.equal(state.get(DEVICE_STATE_KEY), undefined);
});

test('emulator serial is never restored in another extension session', async () => {
  const oldState = memory('emulator-5554');
  const nextSession = new DeviceSelectionStore(oldState);
  await nextSession.updateDevices([device('emulator-5554', 'device')]);
  assert.equal(nextSession.selectedSerial, undefined);
  assert.equal(oldState.get(DEVICE_STATE_KEY), undefined);
  await nextSession.select('emulator-5554');
  assert.equal(nextSession.selectedSerial, 'emulator-5554');
  assert.equal(oldState.get(DEVICE_STATE_KEY), undefined);
});

test('offline and unauthorized devices cannot be selected', async () => {
  const selection = new DeviceSelectionStore(memory());
  await selection.updateDevices([device('usb-1', 'offline'), device('usb-2', 'unauthorized')]);
  await assert.rejects(selection.select('usb-1'), /offline/);
  await assert.rejects(selection.select('usb-2'), /unauthorized/);
  assert.equal(selection.selectedSerial, undefined);
});

test('selected device becomes invalid when state changes', async () => {
  const selection = new DeviceSelectionStore(memory());
  await selection.updateDevices([device('usb-1', 'device'), device('usb-2', 'device')]);
  assert.equal(selection.selectedSerial, undefined);
  await selection.select('usb-1');
  await selection.updateDevices([device('usb-1', 'offline'), device('usb-2', 'device')]);
  assert.equal(selection.selectedSerial, undefined);
});
