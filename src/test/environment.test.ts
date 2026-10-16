import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

interface Settings { [key: string]: string | number | undefined }
const settings: Settings = {};
let workspaces: string[] = [];
const vscodeStub = {
  workspace: {
    getConfiguration: () => ({ get: (name: string) => settings[name] }),
    get workspaceFolders() { return workspaces.length ? workspaces.map(fsPath => ({ uri: { fsPath } })) : undefined; },
  },
};

const runtimeModule = require('node:module') as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = runtimeModule._load;
let environment: typeof import('../environment');
try {
  runtimeModule._load = (request, parent, isMain) => request === 'vscode'
    ? vscodeStub : originalLoad.call(runtimeModule, request, parent, isMain);
  environment = require('../environment') as typeof import('../environment');
} finally {
  runtimeModule._load = originalLoad;
}

/** The optional counter file receives one line per `java -version` invocation. */
function fakeJava(file: string, version: number, counter?: string): void {
  const count = counter ? `echo run >> '${counter}'\n` : '';
  writeFileSync(file, `#!/bin/sh\n${count}echo 'openjdk version "${version}.0.1"' >&2\n`);
  chmodSync(file, 0o755);
}

async function serverReply(reply: (socket: import('node:net').Socket) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(socket => {
    let request = '';
    socket.on('data', chunk => {
      request += chunk.toString('ascii');
      if (request.length >= 16) {
        assert.equal(request, '000Chost:version');
        reply(socket);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, port: address.port };
}

test('diagnóstico aponta requisitos ausentes e reconhece um servidor ADB válido', async t => {
  if (process.platform === 'win32') { t.skip('O JDK simulado usa um script POSIX'); return; }
  const root = mkdtempSync(join(tmpdir(), 'android-environment-'));
  const previousEnv = { ...process.env };
  const sdk = join(root, 'sdk');
  const javaHome = join(root, 'jdk');
  const java = join(javaHome, 'bin', 'java');
  const adb = join(sdk, 'platform-tools', 'adb');
  const wrapper = join(root, 'project', 'gradlew');
  const bridgeJar = join(root, 'extension', 'bridge', 'build', 'install', 'bridge', 'lib', 'bridge.jar');
  mkdirSync(join(javaHome, 'bin'), { recursive: true });
  mkdirSync(join(sdk, 'platform-tools'), { recursive: true });
  mkdirSync(join(root, 'project'), { recursive: true });
  mkdirSync(join(root, 'extension', 'bridge', 'build', 'install', 'bridge', 'lib'), { recursive: true });
  fakeJava(java, 21);
  writeFileSync(adb, '');
  writeFileSync(wrapper, '');
  writeFileSync(bridgeJar, '');
  workspaces = [join(root, 'project')];
  Object.assign(settings, { javaHome, sdkPath: sdk, adbHost: '127.0.0.1' });
  process.env.PATH = join(root, 'empty');
  delete process.env.JAVA_HOME;
  delete process.env.ANDROID_HOME;
  delete process.env.ANDROID_SDK_ROOT;
  t.after(() => {
    for (const key of Object.keys(process.env)) { if (!(key in previousEnv)) { delete process.env[key]; } }
    Object.assign(process.env, previousEnv);
    for (const key of Object.keys(settings)) { delete settings[key]; }
    workspaces = [];
    rmSync(root, { recursive: true, force: true });
  });

  const adbServer = await serverReply(socket => {
    socket.write('OK');
    setTimeout(() => socket.end('AY00040029'), 5);
  });
  settings.adbPort = adbServer.port;
  t.after(() => adbServer.server.listening
    ? new Promise<void>(resolve => adbServer.server.close(() => resolve())) : undefined);

  const ready = await environment.inspectEnvironment(join(root, 'extension'));
  assert.deepEqual(ready.problems, []);
  assert.equal(ready.adbServer, true);
  assert.match(environment.formatEnvironment(ready), /Ambiente pronto/);
  assert.equal(ready.emulator, join(sdk, 'emulator', 'emulator'));
  const customEmulator = join(root, 'other-sdk', 'emulator');
  settings.emulatorPath = customEmulator;
  const missingEmulator = await environment.inspectEnvironment(join(root, 'extension'));
  assert.equal(missingEmulator.emulator, undefined);
  assert.match(missingEmulator.problems.join(' '), /Emulador não encontrado.*androidSupport.emulatorPath/);
  mkdirSync(join(root, 'other-sdk'));
  writeFileSync(customEmulator, '');
  const custom = await environment.inspectEnvironment(join(root, 'extension'));
  assert.equal(custom.emulator, customEmulator);
  assert.deepEqual(custom.problems, []);
  settings.emulatorPath = join('other-sdk', 'emulator');
  const relative = await environment.inspectEnvironment(join(root, 'extension'));
  assert.equal(relative.emulator, undefined);
  assert.match(relative.problems.join(' '), /emulatorPath deve ser um caminho absoluto/);
  delete settings.emulatorPath;

  unlinkSync(java);
  assert.match((await environment.inspectEnvironment(join(root, 'extension'))).problems.join(' '), /JDK não encontrado.*JDK 17\+/);
  fakeJava(java, 11);
  assert.match((await environment.inspectEnvironment(join(root, 'extension'))).problems.join(' '), /JDK 17\+ necessário.*11/);
  fakeJava(java, 21);

  settings.sdkPath = join(root, 'sdk-inválido');
  assert.match((await environment.inspectEnvironment(join(root, 'extension'))).problems.join(' '), /Android SDK não encontrado.*androidSupport.sdkPath/);
  settings.sdkPath = sdk;

  unlinkSync(adb);
  assert.match((await environment.inspectEnvironment(join(root, 'extension'))).problems.join(' '), /adb não encontrado.*Platform-Tools/);
  writeFileSync(adb, '');

  const otherProject = join(root, 'other-project');
  mkdirSync(otherProject);
  workspaces = [otherProject, join(root, 'project')];
  const multiRoot = await environment.inspectEnvironment(join(root, 'extension'));
  assert.equal(multiRoot.wrapper, wrapper);
  assert.doesNotMatch(multiRoot.problems.join(' '), /Wrapper Gradle/);
  unlinkSync(wrapper);
  assert.match((await environment.inspectEnvironment(join(root, 'extension'))).problems.join(' '), /Wrapper Gradle não encontrado.*gradlew/);
  writeFileSync(wrapper, '');
  workspaces = [join(root, 'project')];

  unlinkSync(bridgeJar);
  assert.match((await environment.inspectEnvironment(join(root, 'extension'))).problems.join(' '), /Serviço Kotlin não compilado.*build:bridge/);
  writeFileSync(bridgeJar, '');

  await new Promise<void>(resolve => adbServer.server.close(() => resolve()));
  const absent = await environment.inspectEnvironment(join(root, 'extension'));
  assert.equal(absent.adbServer, false);
  assert.match(absent.problems.join(' '), /Servidor ADB indisponível ou inválido/);

  const impostor = await serverReply(socket => socket.end('HTTP/1.1 200 OK\r\n'));
  t.after(() => new Promise<void>(resolve => impostor.server.close(() => resolve())));
  settings.adbPort = impostor.port;
  const invalid = await environment.inspectEnvironment(join(root, 'extension'));
  assert.equal(invalid.adbServer, false);
  assert.match(invalid.problems.join(' '), /Servidor ADB indisponível ou inválido/);
  assert.doesNotMatch(environment.formatEnvironment(invalid), /Ambiente pronto/);
});

test('reutiliza a versão do JDK até o executável mudar', async t => {
  if (process.platform === 'win32') { t.skip('O JDK simulado usa um script POSIX'); return; }
  const root = mkdtempSync(join(tmpdir(), 'android-environment-cache-'));
  const javaHome = join(root, 'jdk');
  const java = join(javaHome, 'bin', 'java');
  const counter = join(root, 'calls');
  mkdirSync(join(javaHome, 'bin'), { recursive: true });
  fakeJava(java, 17, counter);
  Object.assign(settings, { javaHome, sdkPath: join(root, 'missing-sdk'), adbHost: '127.0.0.1', adbPort: 1 });
  t.after(() => {
    for (const key of Object.keys(settings)) { delete settings[key]; }
    rmSync(root, { recursive: true, force: true });
  });
  const calls = () => readFileSync(counter, 'utf8').trim().split('\n').length;

  assert.equal((await environment.inspectEnvironment(root)).javaVersion, 17);
  assert.equal((await environment.inspectEnvironment(root)).javaVersion, 17);
  assert.equal(calls(), 1);

  fakeJava(java, 21, counter);
  utimesSync(java, new Date(), new Date(Date.now() + 5_000));
  assert.equal((await environment.inspectEnvironment(root)).javaVersion, 21);
  assert.equal(calls(), 2);
});
