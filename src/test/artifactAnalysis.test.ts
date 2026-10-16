import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findAapt2, formatArtifactReport, parseBadging, readZipEntries, summarizeEntries } from '../artifactAnalysis';

/** Central directory + end record only: enough for readZipEntries, which never reads entry data. */
function zipIndex(entries: Array<{ name: string; compressed: number; size: number }>): Buffer {
  const padding = Buffer.alloc(64);
  const records = entries.map(entry => {
    const name = Buffer.from(entry.name, 'utf8');
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt32LE(entry.compressed, 20);
    header.writeUInt32LE(entry.size, 24);
    header.writeUInt16LE(name.length, 28);
    return Buffer.concat([header, name]);
  });
  const directory = Buffer.concat(records);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(padding.length, 16);
  return Buffer.concat([padding, directory, end]);
}

test('lê o índice do ZIP e agrupa por categoria', t => {
  const root = mkdtempSync(join(tmpdir(), 'android-artifact-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const apk = join(root, 'app.apk');
  writeFileSync(apk, zipIndex([
    { name: 'classes.dex', compressed: 4000, size: 9000 },
    { name: 'classes2.dex', compressed: 1000, size: 2000 },
    { name: 'res/', compressed: 0, size: 0 },
    { name: 'res/layout/screen.xml', compressed: 300, size: 900 },
    { name: 'resources.arsc', compressed: 500, size: 500 },
    { name: 'lib/arm64-v8a/libnative.so', compressed: 2000, size: 5000 },
    { name: 'AndroidManifest.xml', compressed: 100, size: 300 },
    { name: 'META-INF/CERT.SF', compressed: 50, size: 120 },
    { name: 'kotlin/kotlin.kotlin_builtins', compressed: 10, size: 20 },
  ]));
  const entries = readZipEntries(apk);
  assert.equal(entries.length, 8, 'diretórios são ignorados');
  assert.deepEqual(summarizeEntries(entries).map(item => [item.category, item.files, item.compressedSize]), [
    ['Código (DEX)', 2, 5000], ['Bibliotecas nativas', 1, 2000], ['Tabela de recursos', 1, 500], ['Recursos', 1, 300],
    ['Manifesto', 1, 100], ['Assinatura e metadados', 1, 50], ['Outros', 1, 10],
  ]);
  writeFileSync(join(root, 'bad.apk'), 'não é zip');
  assert.throws(() => readZipEntries(join(root, 'bad.apk')), /não é um arquivo ZIP/);
});

test('reconhece a estrutura de módulos de um AAB', () => {
  const categories = summarizeEntries([
    { name: 'base/dex/classes.dex', compressedSize: 10, size: 10 },
    { name: 'base/manifest/AndroidManifest.xml', compressedSize: 5, size: 5 },
    { name: 'base/res/values/strings.xml', compressedSize: 4, size: 4 },
    { name: 'base/resources.pb', compressedSize: 3, size: 3 },
    { name: 'BUNDLE-METADATA/com.android.tools.build.libraries/dependencies.pb', compressedSize: 2, size: 2 },
    { name: 'BundleConfig.pb', compressedSize: 1, size: 1 },
  ]).map(item => item.category);
  assert.deepEqual(categories, ['Código (DEX)', 'Manifesto', 'Recursos', 'Tabela de recursos', 'Assinatura e metadados']);
});

const BADGING = `package: name='io.github.desodre.editingfixture' versionCode='1' versionName='1.0' platformBuildVersionName='15'
sdkVersion:'23'
targetSdkVersion:'35'
uses-permission: name='android.permission.INTERNET'
uses-permission: name='io.github.desodre.editingfixture.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'
application-label:'Editing'
application-debuggable
launchable-activity: name='io.github.desodre.editingfixture.MainActivity'  label='' icon=''
native-code: 'arm64-v8a' 'x86_64'
`;

test('lê metadados do aapt2 dump badging', () => {
  assert.deepEqual(parseBadging(BADGING), {
    packageName: 'io.github.desodre.editingfixture', versionCode: '1', versionName: '1.0',
    minSdk: '23', targetSdk: '35', label: 'Editing', debuggable: true,
    launchableActivity: 'io.github.desodre.editingfixture.MainActivity',
    permissions: ['android.permission.INTERNET', 'io.github.desodre.editingfixture.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'],
    nativeCode: ['arm64-v8a', 'x86_64'],
  });
  const report = formatArtifactReport({ type: 'APK', file: '/out/app.apk', variant: 'freeDebug', applicationId: null, filters: [] },
    3 * 1024 * 1024, [{ name: 'classes.dex', compressedSize: 2048, size: 4096 }], parseBadging(BADGING));
  assert.match(report, /Tamanho do arquivo: 3\.0 MiB · 1 arquivo/);
  assert.match(report, /- Código \(DEX\): 2\.0 KiB \/ 4\.0 KiB \(1\)/);
  assert.match(report, /minSdk: 23 · targetSdk: 35/);
  const unversioned = parseBadging("package: name='a.b' versionCode='' versionName=''");
  assert.equal(unversioned.versionCode, undefined);
  assert.equal(unversioned.versionName, undefined);
  assert.match(formatArtifactReport({ type: 'AAB', file: '/out/app.aab', variant: 'freeDebug', applicationId: null, filters: [] },
    10, [], undefined, 'exige bundletool'), /Manifesto: exige bundletool/);
});

test('escolhe o aapt2 da versão mais nova do build-tools', t => {
  const sdk = mkdtempSync(join(tmpdir(), 'android-sdk-'));
  t.after(() => rmSync(sdk, { recursive: true, force: true }));
  assert.equal(findAapt2(sdk), undefined);
  const binary = process.platform === 'win32' ? 'aapt2.exe' : 'aapt2';
  for (const version of ['9.0.0', '36.0.0', '37.0.0-rc1', '36.1.0']) { mkdirSync(join(sdk, 'build-tools', version), { recursive: true }); }
  for (const version of ['9.0.0', '36.0.0', '36.1.0']) {
    writeFileSync(join(sdk, 'build-tools', version, binary), '');
    chmodSync(join(sdk, 'build-tools', version, binary), 0o755);
  }
  assert.equal(findAapt2(sdk), join(sdk, 'build-tools', '36.1.0', binary), '37.0.0-rc1 não tem aapt2');
});
