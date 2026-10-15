// Opt-in host proof for issue #22. Starts an existing AVD through the VS Code command.
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const vscode = require('vscode');

const fixture = __dirname;
const repo = path.resolve(fixture, '../..');
const applicationId = 'io.github.desodre.debugfixture';
const adb = process.env.ANDROID_ADB || 'adb';
const runFile = promisify(execFile);

async function adbCommand(...args) {
  return runFile(adb, args, { timeout: 30_000 });
}

async function emulatorSerials() {
  const { stdout } = await adbCommand('devices');
  return stdout.split(/\r?\n/).map(line => line.match(/^(emulator-\d+)\s+\S+/)?.[1]).filter(Boolean);
}

async function waitForPid(serial, expected) {
  for (let attempt = 0; attempt < 40; attempt++) {
    let pid;
    try {
      const { stdout } = await adbCommand('-s', serial, 'shell', 'pidof', applicationId);
      pid = Number(stdout.trim().split(/\s+/)[0]) || undefined;
    } catch {
      const { stdout: state } = await adbCommand('-s', serial, 'get-state');
      assert.equal(state.trim(), 'device', 'O emulador deixou de estar disponível no ADB.');
    }
    if (expected(pid)) { return pid; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('O aplicativo não atingiu o estado esperado no AVD.');
}

module.exports.run = async () => {
  const avdName = process.env.ANDROID_AVD_NAME;
  assert.ok(avdName, 'Defina ANDROID_AVD_NAME para um AVD existente.');
  assert.ok(existsSync(path.join(repo, 'out/extension.js')), 'Compile a extensão antes da prova.');
  assert.ok(existsSync(path.join(repo, 'bridge/build/install/bridge/lib')), 'Compile a ponte Kotlin antes da prova.');
  assert.ok(vscode.workspace.workspaceFolders?.some(folder => path.resolve(folder.uri.fsPath) === fixture));
  if (process.platform === 'linux') {
    const availableKb = Number(readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m)?.[1]);
    const minimumMb = Number(process.env.ANDROID_AVD_MIN_AVAILABLE_MB || 8192);
    assert.ok(availableKb >= minimumMb * 1024,
      `Memória disponível insuficiente para a prova AVD: libere pelo menos ${minimumMb} MiB.`);
  }

  const initialSerials = new Set(await emulatorSerials());
  assert.equal(initialSerials.size, 0, 'Encerre os emuladores existentes antes da prova AVD.');
  const extension = vscode.extensions.getExtension('desodre.android-vscode-support');
  assert.ok(extension, 'A extensão Android não foi carregada.');
  await extension.activate();

  const originalQuickPick = vscode.window.showQuickPick;
  const originalErrorMessage = vscode.window.showErrorMessage;
  const errors = [];
  const builds = [];
  let serial;
  const buildListener = vscode.tasks.onDidEndTaskProcess(event => {
    if (event.execution.task.definition.type === 'androidGradle') {
      builds.push({ action: event.execution.task.definition.action, exitCode: event.exitCode });
    }
  });

  vscode.window.showErrorMessage = async message => { errors.push(String(message)); return undefined; };
  vscode.window.showQuickPick = async (items, options) => {
    const list = await Promise.resolve(items);
    switch (options?.placeHolder) {
      case 'Selecione o módulo Android': return list.find(item => item.value?.path === ':app');
      case 'Escolha onde executar o aplicativo Android': return list.find(item => item.value === 'avd');
      case 'Selecione o AVD que deseja iniciar': return list.find(item => item === avdName);
      default: throw new Error(`Escolha inesperada: ${options?.placeHolder ?? '<sem descrição>'}`);
    }
  };

  try {
    await vscode.commands.executeCommand('androidSupport.run');
    assert.deepEqual(errors, [], 'O comando Executar mostrou uma falha.');
    assert.ok(builds.some(event => event.action === 'assemble' && event.exitCode === 0),
      'O build Android não terminou com sucesso.');
    const newSerials = (await emulatorSerials()).filter(value => !initialSerials.has(value));
    assert.equal(newSerials.length, 1, 'O comando deve iniciar exatamente um novo AVD.');
    serial = newSerials[0];
    const { stdout: boot } = await adbCommand('-s', serial, 'shell', 'getprop', 'sys.boot_completed');
    assert.equal(boot.trim(), '1', 'O AVD não concluiu o boot.');
    const { stdout: packagePath } = await adbCommand('-s', serial, 'shell', 'pm', 'path', applicationId);
    assert.match(packagePath, /^package:/m, 'O aplicativo não foi instalado.');
    assert.ok(await waitForPid(serial, pid => Boolean(pid)), 'O aplicativo não iniciou.');

    await vscode.commands.executeCommand('androidSupport.stop');
    assert.deepEqual(errors, [], 'O comando Parar mostrou uma falha.');
    await waitForPid(serial, pid => !pid);
    if (process.env.ANDROID_AVD_RESULT) { writeFileSync(process.env.ANDROID_AVD_RESULT, 'PASS\n'); }
    console.log('PASS: AVD iniciou, aplicativo compilou, instalou, abriu e parou.');
  } finally {
    vscode.window.showQuickPick = originalQuickPick;
    vscode.window.showErrorMessage = originalErrorMessage;
    buildListener.dispose();
    const newSerials = (await emulatorSerials().catch(() => []))
      .filter(value => !initialSerials.has(value));
    for (const value of newSerials) {
      await adbCommand('-s', value, 'shell', 'am', 'force-stop', applicationId).catch(() => {});
      await adbCommand('-s', value, 'emu', 'kill').catch(() => {});
    }
  }
};
