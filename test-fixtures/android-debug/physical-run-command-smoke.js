// Opt-in end-to-end test of the published Android: Compilar, instalar e executar command.
// Run with VS Code --extensionTestsPath and this fixture as the workspace.
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { existsSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const vscode = require('vscode');

const fixture = __dirname;
const repo = path.resolve(fixture, '../..');
const applicationId = 'io.github.desodre.debugfixture';
const apk = path.join(fixture, 'app/build/outputs/apk/debug/app-debug.apk');
const runFile = promisify(execFile);
const adb = process.env.ANDROID_ADB || 'adb';

async function adbCommand(serial, ...args) {
  return runFile(adb, ['-s', serial, ...args], { timeout: 30_000 });
}

async function pidOf(serial) {
  try {
    const { stdout } = await adbCommand(serial, 'shell', 'pidof', applicationId);
    return Number(stdout.trim().split(/\s+/)[0]) || undefined;
  } catch { return undefined; }
}

async function waitForPid(serial, expected) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const pid = await pidOf(serial);
    if (expected(pid)) { return pid; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('O processo do app não atingiu o estado esperado.');
}

module.exports.run = async () => {
  const serial = process.env.ANDROID_SERIAL;
  assert.ok(serial, 'Defina ANDROID_SERIAL para executar a prova física.');
  assert.ok(existsSync(path.join(repo, 'out/extension.js')), 'Compile a extensão antes da prova.');
  assert.ok(existsSync(path.join(repo, 'bridge/build/install/bridge/lib')), 'Compile a ponte Kotlin antes da prova.');
  assert.ok(existsSync(apk), 'Compile o APK da fixture antes da prova.');
  assert.ok(vscode.workspace.workspaceFolders?.some(folder => path.resolve(folder.uri.fsPath) === fixture),
    'Abra test-fixtures/android-debug como workspace do Extension Development Host.');

  const extension = vscode.extensions.getExtension('desodre.android-vscode-support');
  assert.ok(extension, 'A extensão Android não foi carregada pelo VS Code.');
  await extension.activate();

  const originalQuickPick = vscode.window.showQuickPick;
  const originalErrorMessage = vscode.window.showErrorMessage;
  const errors = [];
  const picks = [];
  const builds = [];
  let cancelDestination = false;
  const buildListener = vscode.tasks.onDidEndTaskProcess(event => {
    if (event.execution.task.definition.type === 'androidGradle') {
      builds.push({ action: event.execution.task.definition.action, exitCode: event.exitCode });
    }
  });

  vscode.window.showErrorMessage = async message => { errors.push(String(message)); return undefined; };
  vscode.window.showQuickPick = async (items, options) => {
    const list = await Promise.resolve(items);
    const placeHolder = options?.placeHolder;
    picks.push(placeHolder);
    if (placeHolder === 'Selecione o módulo Android') {
      return list.find(item => item.value?.path === ':app');
    }
    if (placeHolder === 'Escolha onde executar o aplicativo Android') {
      if (cancelDestination) { return undefined; }
      return list.find(item => item.value === 'device');
    }
    if (placeHolder === 'Selecione explicitamente um dispositivo Android') {
      return list.find(item => item.value === serial);
    }
    throw new Error(`Escolha inesperada no fluxo Executar: ${placeHolder ?? '<sem descrição>'}`);
  };

  try {
    await adbCommand(serial, 'shell', 'am', 'force-stop', applicationId);
    await waitForPid(serial, pid => !pid);
    await vscode.commands.executeCommand('androidSupport.run');
    assert.deepEqual(errors, [], 'O comando Executar mostrou uma falha.');
    assert.ok(picks.includes('Escolha onde executar o aplicativo Android'), 'Destino de execução não foi escolhido.');
    assert.ok(builds.some(event => event.action === 'assemble' && event.exitCode === 0),
      'O comando não concluiu uma tarefa Gradle assemble.');
    const { stdout: packagePath } = await adbCommand(serial, 'shell', 'pm', 'path', applicationId);
    assert.match(packagePath, /^package:/m, 'O APK não foi instalado.');
    assert.ok(await waitForPid(serial, pid => Boolean(pid)), 'O app não iniciou.');

    await vscode.commands.executeCommand('androidSupport.stop');
    assert.deepEqual(errors, [], 'O comando Parar mostrou uma falha.');
    await waitForPid(serial, pid => !pid);

    const successfulBuilds = builds.length;
    cancelDestination = true;
    await vscode.commands.executeCommand('androidSupport.run');
    cancelDestination = false;
    assert.equal(builds.length, successfulBuilds, 'Cancelar o destino iniciou um build.');
    assert.deepEqual(errors, [], 'Cancelar o destino mostrou uma falha.');
    assert.equal(await pidOf(serial), undefined, 'Cancelar o destino iniciou o app.');

    const originalJavaHome = process.env.JAVA_HOME;
    try {
      process.env.JAVA_HOME = path.join(fixture, 'missing-jdk-for-failure-test');
      await vscode.commands.executeCommand('androidSupport.run');
    } finally {
      if (originalJavaHome === undefined) { delete process.env.JAVA_HOME; }
      else { process.env.JAVA_HOME = originalJavaHome; }
    }
    assert.ok(builds.slice(successfulBuilds).some(event => event.action === 'assemble' && event.exitCode !== 0),
      'A falha do Gradle não foi detectada.');
    assert.ok(errors.some(message => /Build Android falhou/.test(message)),
      'A falha do Gradle não foi mostrada ao usuário.');
    assert.equal(await pidOf(serial), undefined, 'Um build com falha iniciou o app.');

    if (process.env.ANDROID_RUN_RESULT) { writeFileSync(process.env.ANDROID_RUN_RESULT, 'PASS\n'); }
    console.log('PASS: Executar instalou e abriu o app; Parar, cancelamento e falha de build foram verificados.');
  } finally {
    vscode.window.showQuickPick = originalQuickPick;
    vscode.window.showErrorMessage = originalErrorMessage;
    buildListener.dispose();
    await adbCommand(serial, 'shell', 'am', 'force-stop', applicationId).catch(() => {});
  }
};
