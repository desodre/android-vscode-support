import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findManifestClassDefinitions, manifestClassReferenceAt } from '../manifestNavigation';

test('navega de componentes do manifest para classes Kotlin e Java da variante ativa', t => {
  const root = mkdtempSync(join(tmpdir(), 'android-manifest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (relative: string, source: string) => {
    const file = join(root, relative);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, source);
    return file;
  };
  const kotlin = write('src/main/java/com/example/app/MainActivity.kt',
    'package com.example.app\nclass MainActivity : Activity()');
  const java = write('src/free/java/com/example/app/SyncService.java',
    'package com.example.app; public class SyncService extends Service {}');
  write('src/paid/java/com/example/app/SyncService.java',
    'package com.example.app; public class SyncService extends Service {}');
  const manifest = '<manifest><application android:name=".MainActivity">\n' +
    '<service android:name="com.example.app.SyncService" />\n' +
    '<intent-filter><action android:name="android.intent.action.MAIN" /></intent-filter>' +
    '</application></manifest>';
  const activity = manifestClassReferenceAt(manifest, manifest.indexOf('.MainActivity') + 2);
  const service = manifestClassReferenceAt(manifest, manifest.indexOf('SyncService') + 2);
  assert.equal(activity?.name, '.MainActivity');
  assert.equal(service?.name, 'com.example.app.SyncService');
  assert.deepEqual(activity && findManifestClassDefinitions(root, manifest, activity, ['main', 'free'], 'com.example.app'),
    [{ file: kotlin, offset: 'package com.example.app\nclass '.length }]);
  assert.deepEqual(service && findManifestClassDefinitions(root, manifest, service, ['main', 'free'], 'com.example.app'),
    [{ file: java, offset: 'package com.example.app; public class '.length }]);
  assert.equal(manifestClassReferenceAt(manifest, manifest.indexOf('android.intent.action.MAIN')), undefined);
});

test('usa package do manifest quando o modelo Gradle não fornece namespace', t => {
  const root = mkdtempSync(join(tmpdir(), 'android-manifest-package-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'src/main/java/com/example/Receiver.java');
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, 'package com.example; public class Receiver {}');
  const manifest = '<manifest package="com.example"><application><receiver android:name=".Receiver"/></application></manifest>';
  const reference = manifestClassReferenceAt(manifest, manifest.indexOf('.Receiver') + 2);
  assert.deepEqual(reference && findManifestClassDefinitions(root, manifest, reference, ['main']),
    [{ file, offset: 'package com.example; public class '.length }]);
});

test('ignora comentários, atributos alheios e nomes que escapariam do módulo', () => {
  const manifest = '<!-- <activity android:name=".Fake"/> -->\n' +
    '<application android:label=".Other"><activity android:name="../Outside"/>' +
    '<activity-alias android:name=".Shortcut" android:targetActivity=".MainActivity"/></application>';
  assert.equal(manifestClassReferenceAt(manifest, manifest.indexOf('.Fake')), undefined);
  assert.equal(manifestClassReferenceAt(manifest, manifest.indexOf('.Other')), undefined);
  assert.equal(manifestClassReferenceAt(manifest, manifest.indexOf('../Outside')), undefined);
  assert.equal(manifestClassReferenceAt(manifest, manifest.indexOf('.Shortcut')), undefined);
  assert.equal(manifestClassReferenceAt(manifest, manifest.indexOf('.MainActivity'))?.name, '.MainActivity');
});
