// Opt-in VS Code host proof: AndroidManifest component names navigate to local Kotlin sources.
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

module.exports.run = async () => {
  const fixture = __dirname;
  const manifestPath = path.join(fixture, 'app/src/main/AndroidManifest.xml');
  const activityPath = path.join(fixture, 'app/src/main/java/io/github/desodre/debugfixture/MainActivity.kt');
  const receiverPath = path.join(fixture, 'app/src/main/java/io/github/desodre/debugfixture/Stage3ProbeReceiver.kt');
  assert.ok(vscode.workspace.workspaceFolders?.some(folder => path.resolve(folder.uri.fsPath) === fixture));
  const extension = vscode.extensions.getExtension('desodre.android-vscode-support');
  assert.ok(extension);
  await extension.activate();

  const originalQuickPick = vscode.window.showQuickPick;
  const originalErrorMessage = vscode.window.showErrorMessage;
  const errors = [];
  vscode.window.showErrorMessage = async message => { errors.push(String(message)); return undefined; };
  vscode.window.showQuickPick = async (items, options) => {
    if (options?.placeHolder === 'Selecione o módulo Android') {
      return (await Promise.resolve(items)).find(item => item.value?.path === ':app');
    }
    throw new Error(`Escolha inesperada: ${options?.placeHolder}`);
  };
  try {
    await vscode.commands.executeCommand('androidSupport.selectModule');
    assert.deepEqual(errors, [], 'A descoberta de módulos falhou.');
    const document = await vscode.workspace.openTextDocument(manifestPath);
    for (const [name, expected] of [['.MainActivity', activityPath], ['.Stage3ProbeReceiver', receiverPath]]) {
      const offset = document.getText().indexOf(`android:name="${name}"`) + 'android:name="'.length + 2;
      assert.ok(offset > 2, `Componente ${name} não está no manifest.`);
      const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider',
        document.uri, document.positionAt(offset));
      assert.ok(definitions.some(location => location.uri.fsPath === expected),
        `Ir à definição de ${name} não encontrou ${expected}.`);
    }
    if (process.env.ANDROID_MANIFEST_RESULT) { writeFileSync(process.env.ANDROID_MANIFEST_RESULT, 'PASS\n'); }
    console.log('PASS: componentes do AndroidManifest navegam para fontes Kotlin na variante selecionada.');
  } finally {
    vscode.window.showQuickPick = originalQuickPick;
    vscode.window.showErrorMessage = originalErrorMessage;
  }
};
