// Opt-in VS Code host proof for Android XML/resource navigation and local diagnostics.
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const fixture = __dirname;
const app = path.join(fixture, 'app');
const main = path.join(app, 'src/main');
const manifestPath = path.join(main, 'AndroidManifest.xml');
const kotlinPath = path.join(main, 'java/io/github/desodre/editingfixture/MainActivity.kt');
const javaPath = path.join(main, 'java/io/github/desodre/editingfixture/JavaReceiver.java');
const appStrings = path.join(main, 'res/values/strings.xml');
const layoutPath = path.join(main, 'res/layout/screen.xml');
const libraryStrings = path.join(fixture, 'fixture/src/main/res/values/strings.xml');
const flavorFile = name => path.join(app, `src/${name}/res/values/flavor.xml`);

async function definition(document, needle, expected, occurrence = 0) {
  const source = document.getText();
  let offset = -1;
  for (let index = 0; index <= occurrence; index++) {
    offset = source.indexOf(needle, offset + 1);
    assert.ok(offset >= 0, `Não encontrou ${needle} no documento ${document.uri.fsPath}.`);
  }
  const locations = await vscode.commands.executeCommand('vscode.executeDefinitionProvider',
    document.uri, document.positionAt(offset + Math.floor(needle.length / 2)));
  const paths = locations.map(location => (location.targetUri || location.uri).fsPath);
  assert.ok(paths.includes(expected), `${needle}: definição ${expected} ausente em ${JSON.stringify(paths)}.`);
}

async function waitForDiagnostic(uri, expected) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const found = vscode.languages.getDiagnostics(uri).find(item => item.code === 'android-resource-missing');
    if (Boolean(found) === expected) { return found; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Diagnóstico de recurso não atingiu o estado ${expected} em ${uri.fsPath}.`);
}

module.exports.run = async () => {
  assert.ok(vscode.workspace.workspaceFolders?.some(folder => path.resolve(folder.uri.fsPath) === fixture));
  const extension = vscode.extensions.getExtension('desodre.android-vscode-support');
  assert.ok(extension);
  await extension.activate();
  const originalPick = vscode.window.showQuickPick;
  const originalError = vscode.window.showErrorMessage;
  const errors = [];
  let variant = 'freeDebug';
  vscode.window.showErrorMessage = async message => { errors.push(String(message)); return undefined; };
  vscode.window.showQuickPick = async (items, options) => {
    const list = await Promise.resolve(items);
    if (options?.placeHolder === 'Selecione o módulo Android') {
      return list.find(item => item.value?.path === ':app');
    }
    if (options?.placeHolder?.startsWith('Selecione o variant de')) {
      return list.find(item => item.value === variant);
    }
    throw new Error(`Escolha inesperada: ${options?.placeHolder}`);
  };
  const config = vscode.workspace.getConfiguration('androidSupport');
  const previousDiagnostics = config.get('xmlLocalResourceDiagnostics', false);
  let layout;
  let originalLayout;
  try {
    await vscode.commands.executeCommand('androidSupport.selectModule');
    assert.deepEqual(errors, []);
    await config.update('xmlLocalResourceDiagnostics', true, vscode.ConfigurationTarget.Global);
    const manifest = await vscode.workspace.openTextDocument(manifestPath);
    let kotlin = await vscode.workspace.openTextDocument(kotlinPath);
    kotlin = await vscode.languages.setTextDocumentLanguage(kotlin, 'kotlin');
    const java = await vscode.workspace.openTextDocument(javaPath);
    layout = await vscode.workspace.openTextDocument(layoutPath);
    originalLayout = layout.getText();

    await definition(manifest, '.MainActivity', kotlinPath);
    await definition(manifest, '.JavaReceiver', javaPath);
    await definition(manifest, '@string/app_label', appStrings);
    await definition(kotlin, 'R.string.app_label', appStrings);
    await definition(kotlin, 'R.string.shared_label', libraryStrings);
    await definition(java, 'R.string.app_label', appStrings);
    await definition(layout, '@string/flavor_label', flavorFile('free'));
    assert.equal(await waitForDiagnostic(layout.uri, false), undefined);

    variant = 'paidDebug';
    await vscode.commands.executeCommand('androidSupport.selectVariant');
    assert.deepEqual(errors, []);
    await definition(layout, '@string/flavor_label', flavorFile('paid'));
    assert.equal(await waitForDiagnostic(layout.uri, false), undefined);

    const changed = layout.getText().replace('@string/flavor_label', '@string/missing_probe');
    const edit = new vscode.WorkspaceEdit();
    edit.replace(layout.uri, new vscode.Range(layout.positionAt(0), layout.positionAt(layout.getText().length)), changed);
    assert.ok(await vscode.workspace.applyEdit(edit));
    const diagnostic = await waitForDiagnostic(layout.uri, true);
    assert.equal(layout.getText(diagnostic.range), '@string/missing_probe');
    assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Warning);
    const restore = new vscode.WorkspaceEdit();
    restore.replace(layout.uri, new vscode.Range(layout.positionAt(0), layout.positionAt(layout.getText().length)), originalLayout);
    assert.ok(await vscode.workspace.applyEdit(restore));
    assert.equal(await waitForDiagnostic(layout.uri, false), undefined);
  } finally {
    if (layout && originalLayout !== undefined && layout.getText() !== originalLayout) {
      const restore = new vscode.WorkspaceEdit();
      restore.replace(layout.uri, new vscode.Range(layout.positionAt(0), layout.positionAt(layout.getText().length)), originalLayout);
      await vscode.workspace.applyEdit(restore);
    }
    await config.update('xmlLocalResourceDiagnostics', previousDiagnostics, vscode.ConfigurationTarget.Global);
    vscode.window.showQuickPick = originalPick;
    vscode.window.showErrorMessage = originalError;
  }
  if (process.env.ANDROID_XML_RESULT) { writeFileSync(process.env.ANDROID_XML_RESULT, 'PASS\n'); }
  console.log('PASS: navegação manifest, Kotlin, Java, XML, dependência, flavors e diagnóstico na origem.');
};
