// Opt-in VS Code proof: AVD startup failure and cancellation never start a build.
const assert = require('node:assert/strict');
const { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const fixture = __dirname;
const root = mkdtempSync(path.join(tmpdir(), 'android-avd-failure-'));

function fakeEmulator(mode) {
  const pidFile = path.join(root, `${mode}.pid`);
  const binary = path.join(root, `${mode}-emulator`);
  writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('-list-avds')) {
  console.log('FakeAVD');
} else {
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  ${mode === 'fail' ? "console.error('falha simulada no AVD'); process.exit(17);" : 'setInterval(() => {}, 1000);'}
}
`);
  chmodSync(binary, 0o755);
  return { binary, pidFile };
}

function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; }
  catch { return false; }
}

module.exports.run = async () => {
  assert.equal(process.platform === 'win32', false, 'A fixture usa executáveis POSIX.');
  assert.ok(vscode.workspace.workspaceFolders?.some(folder => path.resolve(folder.uri.fsPath) === fixture));
  const extension = vscode.extensions.getExtension('desodre.android-vscode-support');
  assert.ok(extension);
  await extension.activate();

  const config = vscode.workspace.getConfiguration('androidSupport');
  const originalPath = config.get('emulatorPath');
  const originalQuickPick = vscode.window.showQuickPick;
  const originalErrorMessage = vscode.window.showErrorMessage;
  const originalWithProgress = vscode.window.withProgress;
  const errors = [];
  const builds = [];
  const created = [];
  const listener = vscode.tasks.onDidEndTaskProcess(event => {
    if (event.execution.task.definition.type === 'androidGradle') { builds.push(event.exitCode); }
  });
  vscode.window.showErrorMessage = async message => { errors.push(String(message)); return undefined; };
  vscode.window.showQuickPick = async (items, options) => {
    const list = await Promise.resolve(items);
    switch (options?.placeHolder) {
      case 'Selecione o módulo Android': return list.find(item => item.value?.path === ':app');
      case 'Escolha onde executar o aplicativo Android': return list.find(item => item.value === 'avd');
      case 'Selecione o AVD que deseja iniciar': return list.find(item => item === 'FakeAVD');
      default: throw new Error(`Escolha inesperada: ${options?.placeHolder}`);
    }
  };

  try {
    const failed = fakeEmulator('fail');
    created.push(failed.pidFile);
    await config.update('emulatorPath', failed.binary, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('androidSupport.run');
    assert.ok(errors.some(message => /falha simulada no AVD/.test(message)),
      'A falha do emulador não apareceu ao usuário.');
    assert.equal(builds.length, 0, 'Falha do AVD iniciou um build.');
    assert.equal(groupAlive(Number(readFileSync(failed.pidFile, 'utf8'))), false);

    const waiting = fakeEmulator('wait');
    created.push(waiting.pidFile);
    errors.length = 0;
    await config.update('emulatorPath', waiting.binary, vscode.ConfigurationTarget.Global);
    vscode.window.withProgress = async (options, task) => {
      if (options.title !== 'Android: iniciando FakeAVD') {
        return originalWithProgress.call(vscode.window, options, task);
      }
      const events = new vscode.EventEmitter();
      let canceled = false;
      const token = {
        get isCancellationRequested() { return canceled; },
        onCancellationRequested: events.event,
      };
      const pending = task({ report() {} }, token);
      for (let attempt = 0; attempt < 100 && !existsSync(waiting.pidFile); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(existsSync(waiting.pidFile), 'O AVD falso não iniciou.');
      canceled = true;
      events.fire();
      try { return await pending; }
      finally { events.dispose(); }
    };
    await vscode.commands.executeCommand('androidSupport.run');
    assert.ok(errors.some(message => /cancelada/.test(message)),
      'O cancelamento do AVD não apareceu ao usuário.');
    assert.equal(builds.length, 0, 'Cancelar o AVD iniciou um build.');
    assert.equal(groupAlive(Number(readFileSync(waiting.pidFile, 'utf8'))), false);

    if (process.env.ANDROID_AVD_FAILURE_RESULT) {
      writeFileSync(process.env.ANDROID_AVD_FAILURE_RESULT, 'PASS\n');
    }
    console.log('PASS: falha e cancelamento do AVD não iniciaram build nem deixaram processo.');
  } finally {
    listener.dispose();
    vscode.window.showQuickPick = originalQuickPick;
    vscode.window.showErrorMessage = originalErrorMessage;
    vscode.window.withProgress = originalWithProgress;
    for (const file of created) {
      if (existsSync(file)) {
        const pid = Number(readFileSync(file, 'utf8'));
        if (groupAlive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
      }
    }
    rmSync(root, { recursive: true, force: true });
    await config.update('emulatorPath', originalPath, vscode.ConfigurationTarget.Global);
  }
};
