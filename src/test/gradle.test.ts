import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { findBuiltArtifacts } from '../gradle/artifacts';
import { BuildIssueCollector, parseBuildIssue } from '../gradle/diagnostics';
import { GradleSelection, gradleTaskName, runGradle } from '../gradle/runner';

const roots: string[] = [];
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'android-gradle-test-'));
  roots.push(root);
  return root;
}
after(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })));

test('forma tarefas para o módulo e a variante selecionados', () => {
  const selection = { rootPath: '/project', modulePath: ':feature:demo', variant: 'freeDebug' };
  assert.equal(gradleTaskName(selection, 'assemble'), ':feature:demo:assembleFreeDebug');
  assert.equal(gradleTaskName(selection, 'install'), ':feature:demo:installFreeDebug');
  assert.equal(gradleTaskName(selection, 'clean'), ':feature:demo:clean');
  assert.throws(() => gradleTaskName({ ...selection, modulePath: ':feature;rm' }, 'assemble'));
});

test('executa o wrapper da raiz sem shell e preserva argumentos', async () => {
  if (process.platform === 'win32') { return; }
  const root = temporaryRoot();
  const wrapper = join(root, 'gradlew');
  writeFileSync(wrapper, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  chmodSync(wrapper, 0o755);
  const selection: GradleSelection = { rootPath: root, modulePath: ':app', variant: 'demoDebug' };
  let output = '';
  const result = await runGradle(selection, 'assemble', chunk => { output += chunk; });
  assert.deepEqual(result, { exitCode: 0, cancelled: false });
  assert.equal(output, '--console=plain\n:app:assembleDemoDebug\n');
});

test('cancela um build em andamento', async () => {
  if (process.platform === 'win32') { return; }
  const root = temporaryRoot();
  const wrapper = join(root, 'gradlew');
  writeFileSync(wrapper, '#!/bin/sh\necho started\nsleep 30 &\nwait\n');
  chmodSync(wrapper, 0o755);
  const controller = new AbortController();
  const result = await runGradle({ rootPath: root, modulePath: ':app', variant: 'debug' }, 'assemble', chunk => {
    if (chunk.includes('started')) { controller.abort(); }
  }, controller.signal);
  assert.deepEqual(result, { exitCode: 130, cancelled: true });
});

test('converte mensagens Kotlin e Java em localização clicável', () => {
  const root = temporaryRoot();
  const kotlin = parseBuildIssue(root, `e: file://${root}/app/src/main/Foo.kt: (12, 3): Unresolved reference`);
  assert.deepEqual(kotlin, { file: join(root, 'app/src/main/Foo.kt'), line: 12, column: 3,
    message: 'Unresolved reference', severity: 'error' });
  const java = parseBuildIssue(root, `${root}/app/src/main/Bar.java:7: error: cannot find symbol`);
  assert.deepEqual(java, { file: join(root, 'app/src/main/Bar.java'), line: 7, column: 1,
    message: 'cannot find symbol', severity: 'error' });
  const found: string[] = [];
  const collector = new BuildIssueCollector(root, issue => found.push(issue.message));
  collector.write(`${root}/app/src/main/Bar.java:7: error: cannot`);
  collector.write(' find symbol\n');
  collector.write(`${root}/app/src/main/Bar.java:7: error: cannot find symbol\n`);
  assert.deepEqual(found, ['cannot find symbol']);
});

test('usa metadados da variante correta para localizar APK e applicationId', () => {
  const root = temporaryRoot();
  const apkDir = join(root, 'app', 'build', 'outputs', 'apk', 'free', 'debug');
  mkdirSync(apkDir, { recursive: true });
  writeFileSync(join(apkDir, 'app-free-debug.apk'), 'apk');
  writeFileSync(join(apkDir, 'output-metadata.json'), JSON.stringify({
    artifactType: { type: 'APK' }, variantName: 'freeDebug', applicationId: 'example.free',
    elements: [{ outputFile: 'app-free-debug.apk', filters: [] }, { outputFile: '../other.apk', filters: [] }]
  }));
  const bundleDir = join(root, 'app', 'build', 'outputs', 'bundle', 'freeDebug');
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(join(bundleDir, 'app-free-debug.aab'), 'bundle');
  const found = findBuiltArtifacts({ rootPath: root, modulePath: ':app', variant: 'freeDebug' }, 'example.free');
  assert.equal(found.length, 2);
  assert.deepEqual(found.map(item => [item.type, item.applicationId]), [['APK', 'example.free'], ['AAB', 'example.free']]);
  assert.deepEqual(findBuiltArtifacts({ rootPath: root, modulePath: ':app', variant: 'paidDebug' }), []);
});
