import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { discoverAndroidWorkspace, findGradleRoots, normalizeDiscovery, variantTask } from '../projectDiscovery';

const raw = (rootDir: string) => ({
  rootDir,
  projects: [
    { path: ':', name: 'sample', projectDir: rootDir, android: null },
    { path: ':plain', name: 'plain', projectDir: `${rootDir}/plain`, android: null },
    {
      path: ':app', name: 'app', projectDir: `${rootDir}/app`,
      android: {
        type: 'application', namespace: 'com.example',
        variants: [
          { name: 'paidRelease', buildType: 'release', flavors: [{ dimension: 'tier', name: 'paid' }], applicationId: 'com.example.paid' },
          { name: 'freeDebug', buildType: 'debug', flavors: [{ dimension: 'tier', name: 'free' }], applicationId: null,
            projectDependencies: [':lib', ':lib', 'external', 7],
            javaSourceDirs: ['/r/app/custom/free', '/r/app/custom/free', 7], kotlinSourceDirs: [] },
          { name: 'freeDebug', buildType: 'debug', flavors: [] },
          { bogus: true }
        ]
      }
    },
    { path: ':lib', name: 'lib', projectDir: `${rootDir}/lib`, android: { type: 'library', variants: [{ name: 'debug', buildType: 'debug', flavors: [] }] } },
    { path: ':weird', android: { type: 'unknown', variants: [] } }
  ]
});

test('normaliza módulos Android, variantes, flavors e build types', () => {
  const modules = normalizeDiscovery(raw('/r'), '/fallback');
  assert.deepEqual(modules.map(module => module.path), [':app', ':lib']);
  const app = modules[0];
  assert.equal(app.runnable, true);
  assert.equal(app.namespace, 'com.example');
  assert.deepEqual(app.variants.map(variant => variant.name), ['freeDebug', 'paidRelease']);
  assert.deepEqual(app.buildTypes, ['debug', 'release']);
  assert.deepEqual(app.flavorDimensions, ['tier']);
  assert.deepEqual(app.flavors, [{ dimension: 'tier', name: 'free' }, { dimension: 'tier', name: 'paid' }]);
  assert.equal(app.variants[1].applicationId, 'com.example.paid');
  assert.deepEqual(app.variants[0].projectDependencies, [':lib']);
  assert.deepEqual(app.variants[0].javaSourceDirs, ['/r/app/custom/free']);
  assert.deepEqual(app.variants[0].kotlinSourceDirs, []);
  assert.equal(modules[1].runnable, false);
});

test('rejeita resposta malformada', () => {
  assert.throws(() => normalizeDiscovery({ nope: 1 }, '/r'), /inválida/);
  assert.throws(() => normalizeDiscovery(null, '/r'), /inválida/);
});

test('nomes de tasks Gradle por variant', () => {
  assert.equal(variantTask({ path: ':app' }, 'freeDebug', 'install'), ':app:installFreeDebug');
  assert.equal(variantTask({ path: ':feature:x' }, 'debug', 'assemble'), ':feature:x:assembleDebug');
  assert.equal(variantTask({ path: ':' }, 'debug', 'assemble'), ':assembleDebug');
});

test('encontra raízes Gradle sem ler arquivos e ignora diretórios de build', () => {
  const base = mkdtempSync(join(tmpdir(), 'agy-roots-'));
  for (const dir of ['a', 'a/app', 'b/nested', 'node_modules/x', 'build/y', 'c/d/e/f']) { mkdirSync(join(base, dir), { recursive: true }); }
  writeFileSync(join(base, 'a', 'settings.gradle.kts'), '');
  writeFileSync(join(base, 'a', 'app', 'settings.gradle'), '');
  writeFileSync(join(base, 'b', 'nested', 'settings.gradle'), '');
  writeFileSync(join(base, 'node_modules', 'x', 'settings.gradle'), '');
  writeFileSync(join(base, 'build', 'y', 'settings.gradle'), '');
  writeFileSync(join(base, 'c', 'd', 'e', 'f', 'settings.gradle'), '');
  assert.deepEqual(findGradleRoots(base), [join(base, 'a'), join(base, 'b', 'nested')]);
  assert.deepEqual(findGradleRoots(base, 4), [join(base, 'a'), join(base, 'b', 'nested'), join(base, 'c', 'd', 'e', 'f')]);
});

test('descobre workspace coletando falhas por raiz e propagando cancelamento', async () => {
  const base = mkdtempSync(join(tmpdir(), 'agy-ws-'));
  for (const dir of ['good', 'bad']) { mkdirSync(join(base, dir)); writeFileSync(join(base, dir, 'settings.gradle'), ''); }
  const calls: string[] = [];
  const bridge = {
    async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      assert.equal(method, 'gradle.discoverProjects');
      const dir = String(params?.projectDir);
      calls.push(dir);
      if (dir.endsWith('bad')) { throw new Error('GradleConnectionException: falhou'); }
      return raw(dir) as T;
    }
  };
  const catalog = await discoverAndroidWorkspace(bridge, [base, base]);
  assert.deepEqual(calls, [join(base, 'bad'), join(base, 'good')]);
  assert.equal(catalog.modules.length, 2);
  assert.deepEqual(catalog.failures, [{ root: join(base, 'bad'), message: 'GradleConnectionException: falhou' }]);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(discoverAndroidWorkspace(bridge, [base], controller.signal), /cancelada/);
});

test('integração: Kotlin bridge + Tooling API descobrem um build Gradle real', async () => {
  const { join: j } = await import('node:path');
  const { copyFileSync } = await import('node:fs');
  const { BridgeClient } = await import('../bridgeClient');
  const base = mkdtempSync(j(tmpdir(), 'agy-e2e-'));
  mkdirSync(j(base, 'gradle', 'wrapper'), { recursive: true });
  copyFileSync(j(process.cwd(), 'gradle', 'wrapper', 'gradle-wrapper.properties'), j(base, 'gradle', 'wrapper', 'gradle-wrapper.properties'));
  writeFileSync(j(base, 'settings.gradle'), "rootProject.name = 'e2e'");
  const client = await BridgeClient.start(
    process.env.JAVA_HOME ? j(process.env.JAVA_HOME, 'bin', 'java') : 'java',
    j(process.cwd(), 'bridge', 'build', 'install', 'bridge', 'lib'), '127.0.0.1', 5037, () => undefined
  );
  try {
    const catalog = await discoverAndroidWorkspace(client, [base]);
    assert.deepEqual(catalog.failures, []);
    assert.deepEqual(catalog.roots, [base]);
    assert.deepEqual(catalog.modules, []); // build sem plugins Android
  } finally { client.dispose(); }
});
