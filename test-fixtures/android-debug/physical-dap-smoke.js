// Run as VS Code's --extensionTestsPath with this fixture as the workspace.
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const vscode = require('vscode');

const repo = path.resolve(__dirname, '../..');
const fixture = __dirname;
const applicationId = 'io.github.desodre.debugfixture';
const sourceRoot = path.join(fixture, 'app/src/main/java');
const sourceFile = path.join(sourceRoot, 'io/github/desodre/debugfixture/JavaProbe.java');
const apk = path.join(fixture, 'app/build/outputs/apk/debug/app-debug.apk');
const bridgeLib = path.join(repo, 'bridge/build/install/bridge/lib');
const adb = process.env.ANDROID_ADB || 'adb';
const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin/java') : 'java';
const runFile = promisify(execFile);
const { BridgeClient } = require(path.join(repo, 'out/bridgeClient.js'));
const { AndroidDebugAttacher, waitForProcess } = require(path.join(repo, 'out/debug/attach.js'));

async function adbCommand(serial, ...args) {
  return runFile(adb, ['-s', serial, ...args], { timeout: 30_000 });
}

function waitForStop(queue, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tempo esgotado aguardando ${label}.`)), timeoutMs);
    queue.next().then(message => { clearTimeout(timer); resolve(message); }, reject);
  });
}

function stoppedQueue() {
  const events = [];
  let resolveNext;
  return {
    push(message) {
      if (resolveNext) { const resolve = resolveNext; resolveNext = undefined; resolve(message); }
      else { events.push(message); }
    },
    next() {
      if (events.length) { return Promise.resolve(events.shift()); }
      return new Promise(resolve => { resolveNext = resolve; });
    },
  };
}

async function tapCenter(serial) {
  const { stdout } = await adbCommand(serial, 'shell', 'wm', 'size');
  const sizes = [...stdout.matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/g)];
  const size = sizes.at(-1);
  if (!size) { throw new Error('Não foi possível obter o tamanho da tela para tocar o botão.'); }
  await adbCommand(serial, 'shell', 'input', 'tap', String(Math.floor(Number(size[1]) / 2)),
    String(Math.floor(Number(size[2]) / 2)));
}

module.exports.run = async () => {
  const serial = process.env.ANDROID_SERIAL;
  assert.ok(serial, 'Defina ANDROID_SERIAL para executar o teste físico.');
  assert.ok(existsSync(apk), 'Compile o APK da fixture antes do teste.');
  assert.ok(existsSync(bridgeLib), 'Compile a distribuição da ponte Kotlin antes do teste.');
  const folder = vscode.workspace.workspaceFolders?.find(item => path.resolve(item.uri.fsPath) === fixture);
  assert.ok(folder, 'Abra test-fixtures/android-debug como workspace do Extension Development Host.');

  let client;
  let session;
  let tracker;
  let breakpoint;
  let localPort;
  let attacher;
  let debugConfiguration;
  let tapTimer;
  let result;
  const failures = [];
  const stops = stoppedQueue();
  try {
    await adbCommand(serial, 'install', '-r', apk);
    await adbCommand(serial, 'shell', 'am', 'start', '-n', `${applicationId}/.MainActivity`);
    client = await BridgeClient.start(java, bridgeLib, '127.0.0.1', 5037, () => {});
    const pids = await waitForProcess(client, serial, applicationId);

    breakpoint = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(sourceFile), new vscode.Position(6, 0)));
    vscode.debug.addBreakpoints([breakpoint]);
    tracker = vscode.debug.registerDebugAdapterTrackerFactory('java', {
      createDebugAdapterTracker: () => ({
        onDidSendMessage: message => {
          if (message.type === 'event' && message.event === 'stopped') { stops.push(message); }
        },
      }),
    });
    attacher = new AndroidDebugAttacher(async configuration => {
      debugConfiguration = configuration;
      localPort = configuration.port;
      return vscode.debug.startDebugging(folder, configuration);
    });
    const started = await attacher.attach(client, {
      serial, pid: pids[0], applicationId, adapter: 'java', rootPath: fixture,
      projectName: 'app', sourcePaths: [sourceRoot],
    });
    assert.equal(started, true, 'O adaptador Java não iniciou.');
    session = vscode.debug.activeDebugSession;
    assert.ok(session, 'Sessão DAP ausente.');

    await tapCenter(serial);
    tapTimer = setInterval(() => { void tapCenter(serial).catch(() => {}); }, 2_000);
    const hit = await waitForStop(stops, 90_000, 'breakpoint Java');
    assert.equal(hit.body?.reason, 'breakpoint');
    clearInterval(tapTimer);
    tapTimer = undefined;

    const threads = await session.customRequest('threads');
    const thread = threads.threads?.find(item => item.id === hit.body?.threadId)
      ?? threads.threads?.find(item => item.name === 'main') ?? threads.threads?.[0];
    assert.ok(thread, 'Nenhuma thread DAP.');
    const stack = await session.customRequest('stackTrace', { threadId: thread.id, startFrame: 0, levels: 10 });
    const frame = stack.stackFrames?.[0];
    assert.ok(frame?.name.includes('doublePlusOne'), 'A pilha não aponta para JavaProbe.doublePlusOne.');
    assert.equal(path.basename(frame.source?.path ?? ''), 'JavaProbe.java');
    const scopes = await session.customRequest('scopes', { frameId: frame.id });
    let input;
    for (const scope of scopes.scopes ?? []) {
      if (!scope.variablesReference) { continue; }
      const variables = await session.customRequest('variables', { variablesReference: scope.variablesReference });
      input = variables.variables?.find(variable => variable.name === 'input');
      if (input) { break; }
    }
    assert.ok(input, 'Variável Java input não encontrada.');
    const evaluated = await session.customRequest('evaluate', { expression: 'input', frameId: frame.id, context: 'watch' });
    assert.ok(Number.isFinite(Number(input.value)) && Number.isFinite(Number(evaluated.result)),
      'A avaliação de input não retornou um número.');
    assert.equal(Number(evaluated.result), Number(input.value), 'Avaliação de input divergiu da variável.');

    const nextStop = waitForStop(stops, 10_000, 'passo Java');
    await session.customRequest('next', { threadId: thread.id });
    const step = await nextStop;
    assert.equal(step.body?.reason, 'step', 'O depurador não parou após o passo.');
    const afterStep = await session.customRequest('stackTrace', { threadId: thread.id, startFrame: 0, levels: 1 });
    assert.ok(afterStep.stackFrames?.length, 'Pilha ausente após o passo.');
    result = `Java: breakpoint ${frame.line}, passo ${afterStep.stackFrames[0].line}, input=${input.value}`;
  } catch (error) {
    failures.push(error);
  } finally {
    if (tapTimer) { clearInterval(tapTimer); }
    if (session) { await vscode.debug.stopDebugging(session).catch(error => failures.push(error)); }
    if (breakpoint) { vscode.debug.removeBreakpoints([breakpoint]); }
    tracker?.dispose();
    if (attacher) {
      try {
        if (debugConfiguration) { await attacher.onDidTerminate(debugConfiguration); }
        await attacher.dispose();
        if (localPort) {
          const { stdout } = await adbCommand(serial, 'forward', '--list');
          assert.ok(!stdout.split('\n').some(line => line.split(/\s+/).includes(`tcp:${localPort}`)),
            `O forward tcp:${localPort} permaneceu no dispositivo.`);
        }
      } catch (error) { failures.push(error); }
    }
    client?.dispose();
    await adbCommand(serial, 'shell', 'am', 'force-stop', applicationId).catch(error => failures.push(error));
  }
  if (failures.length) { throw new Error(failures.map(error => error.message ?? String(error)).join('; ')); }
  console.log(`PASS physical DAP ${serial}: ${result}; forward removido.`);
};
