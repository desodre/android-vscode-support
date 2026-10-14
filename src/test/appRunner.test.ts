import assert from 'node:assert/strict';
import test from 'node:test';
import { apkCandidates, applicationIdFor, applicationIdToStop, installApk, launchApp, launcherActivities, stopApp } from '../appRunner';
import { BuiltArtifact } from '../gradle/artifacts';
import { GradleSelection } from '../gradle/runner';

const selection: GradleSelection = {
  rootPath: '/project', modulePath: ':app', variant: 'freeDebug', applicationId: 'com.example.free', runnable: true,
};
const apk: BuiltArtifact = {
  type: 'APK', file: '/project/app/build/outputs/apk/free/debug/app.apk',
  variant: 'freeDebug', applicationId: 'com.example.free', filters: [],
};

test('seleciona apenas APK da variante e do applicationId corretos', () => {
  const other = { ...apk, variant: 'paidDebug' };
  assert.deepEqual(apkCandidates([other, { ...apk, applicationId: 'com.example.other' }, apk], selection), [apk]);
  assert.equal(applicationIdFor(apk, selection), 'com.example.free');
  assert.throws(() => applicationIdFor({ ...apk, applicationId: 'com.example.other' }, selection), /diferente/);
});

test('Stop usa applicationId instalado ou metadados quando Gradle não o fornece', () => {
  const unknown = { ...selection, applicationId: null };
  assert.equal(applicationIdToStop(unknown, [apk]), 'com.example.free');
  assert.equal(applicationIdToStop(unknown, [], 'com.example.free'), 'com.example.free');
  assert.throws(() => applicationIdToStop(unknown, [apk, { ...apk, applicationId: 'com.example.other' }]), /ambíguo/);
});

test('instala, consulta launcher, inicia e para sempre no serial explícito', async () => {
  const calls: unknown[][] = [];
  const bridge = {
    async request<T>(method: string, params: Record<string, unknown> = {}, _signal?: AbortSignal, serial?: string): Promise<T> {
      calls.push([method, params, serial]);
      return (method === 'app.launchers' ? ['com.example.free/.MainActivity'] : {}) as T;
    },
  };
  const appId = await installApk(bridge, 'emulator-5554', apk, selection);
  const components = await launcherActivities(bridge, 'emulator-5554', appId);
  await launchApp(bridge, 'emulator-5554', appId, components[0]);
  await stopApp(bridge, 'emulator-5554', appId);
  assert.deepEqual(calls.map(call => [call[0], call[2]]), [
    ['app.install', 'emulator-5554'], ['app.launchers', 'emulator-5554'],
    ['app.launch', 'emulator-5554'], ['app.stop', 'emulator-5554'],
  ]);
});

test('recusa instalar variante errada ou operação sem serial', async () => {
  const bridge = { async request<T>(): Promise<T> { throw new Error('não deveria chamar a ponte'); } };
  await assert.rejects(installApk(bridge, '', apk, selection), /Selecione um dispositivo/);
  await assert.rejects(installApk(bridge, 'serial', { ...apk, variant: 'paidRelease' }, selection), /variante selecionada/);
  await assert.rejects(launchApp(bridge, 'serial', 'com.example.free', 'com.other/.Main'), /inválida/);
});
