import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { classifySourceFile, resolveSourceSets } from '../sourceSets';

test('combina main, flavors, build type e variante na ordem de precedência', () => {
  const root = mkdtempSync(join(tmpdir(), 'android-source-sets-'));
  try {
    mkdirSync(join(root, 'src', 'main', 'java'), { recursive: true });
    mkdirSync(join(root, 'src', 'freeDemoDebug', 'kotlin'), { recursive: true });
    mkdirSync(join(root, 'build', 'generated', 'source', 'buildConfig', 'freeDemoDebug'), { recursive: true });
    const layout = resolveSourceSets({ projectDir: root, variants: [
      { name: 'paidDemoDebug', buildType: 'debug', flavors: [
        { dimension: 'tier', name: 'paid' }, { dimension: 'market', name: 'demo' },
      ], applicationId: null },
    ] }, {
      name: 'freeDemoDebug', buildType: 'debug',
      flavors: [{ dimension: 'tier', name: 'free' }, { dimension: 'market', name: 'demo' }],
    });
    assert.deepEqual(layout.sourceSetNames, ['main', 'free', 'demo', 'freeDemo', 'debug', 'freeDemoDebug']);
    assert.deepEqual(layout.sourceRoots.filter(item => item.exists).map(item => `${item.sourceSet}/${item.language}`),
      ['main/java', 'freeDemoDebug/kotlin']);
    assert.deepEqual(layout.generatedRoots.filter(item => item.exists).map(item => item.kind), ['BuildConfig']);
    assert.equal(classifySourceFile(join(root, 'src', 'freeDemoDebug', 'kotlin', 'Screen.kt'), layout), 'active');
    assert.equal(classifySourceFile(join(root, 'src', 'paidDemoDebug', 'kotlin', 'Screen.kt'), layout), 'inactive');
    assert.equal(classifySourceFile(join(root, 'src', 'custom', 'java', 'GeneratedByPlugin.java'), layout), 'unrelated');
    assert.equal(classifySourceFile(join(root, 'src', 'main', 'res', 'layout.xml'), layout), 'unrelated');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('troca de variante não atribui R, BuildConfig ou KSP antigos à variante nova', () => {
  const root = mkdtempSync(join(tmpdir(), 'android-source-sets-'));
  try {
    const debug = resolveSourceSets({ projectDir: root }, { name: 'debug', buildType: 'debug', flavors: [] });
    const release = resolveSourceSets({ projectDir: root, variants: [
      { name: 'debug', buildType: 'debug', flavors: [], applicationId: null },
    ] }, { name: 'release', buildType: 'release', flavors: [] });
    const generated = [
      join(root, 'build', 'generated', 'source', 'r', 'debug', 'com', 'sample', 'R.java'),
      join(root, 'build', 'generated', 'source', 'buildConfig', 'debug', 'com', 'sample', 'BuildConfig.java'),
      join(root, 'build', 'generated', 'ksp', 'debug', 'kotlin', 'Dao.kt'),
      join(root, 'build', 'generated', 'not_namespaced_r_class_sources', 'debug', 'processDebugResources', 'r', 'R.java'),
    ];
    for (const file of generated) {
      assert.equal(classifySourceFile(file, debug), 'active');
      assert.equal(classifySourceFile(file, release), 'inactive');
    }
    assert.equal(classifySourceFile(join(root, 'build', 'generated', 'unknown', 'debug', 'Thing.java'), release), 'unrelated');
    assert.equal(classifySourceFile(join(root, 'src', 'debug', 'java', 'OnlyDebug.java'), release), 'inactive');
    assert.equal(classifySourceFile(join(root, 'src', 'main', 'java', 'Shared.java'), release), 'active');
    assert.equal(classifySourceFile(join(root + '-other', 'src', 'debug', 'java', 'Other.java'), debug), 'unrelated');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('componentes inválidos do catálogo não criam diretórios fora do módulo', () => {
  const root = mkdtempSync(join(tmpdir(), 'android-source-sets-'));
  try {
    const layout = resolveSourceSets({ projectDir: root }, {
      name: '../debug', buildType: '..', flavors: [{ dimension: 'tier', name: '../../other' }],
    });
    assert.deepEqual(layout.sourceSetNames, ['main']);
    assert.equal(layout.generatedRoots.length, 0);
    assert.ok(layout.sourceRoots.every(item => item.path.startsWith(join(root, 'src') + sep)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
