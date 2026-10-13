import * as vscode from 'vscode';
import { BridgeClient, DeviceInfo } from './bridgeClient';
import { formatEnvironment, inspectEnvironment } from './environment';
import { BuiltArtifact } from './gradle/artifacts';
import { createGradleTask, registerGradleTaskProvider } from './gradle/taskProvider';
import { GradleAction, GradleSelection, toGradleSelection } from './gradle/runner';
import { discoverAndroidWorkspace } from './projectDiscovery';
import { createVscodeSelectionUi, SelectionStore } from './selection';

let bridge: Promise<BridgeClient> | undefined;
let output: vscode.OutputChannel | undefined;
let extensionPath: string;
let selection: SelectionStore;
let lastArtifacts: BuiltArtifact[] = [];
let refreshInFlight: Promise<void> | undefined;

function selectedGradleTarget(): GradleSelection | undefined {
  const resolved = selection.resolve();
  return resolved ? toGradleSelection(resolved) : undefined;
}

function refreshProjects(): Promise<void> {
  if (!refreshInFlight) {
    refreshInFlight = performRefreshProjects().finally(() => { refreshInFlight = undefined; });
  }
  return refreshInFlight;
}

async function performRefreshProjects(): Promise<void> {
  if (!vscode.workspace.isTrusted) { throw new Error('Confie na pasta de trabalho antes de consultar o Gradle.'); }
  const folders = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
  if (folders.length === 0) { throw new Error('Abra uma pasta com um projeto Android Gradle.'); }
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Android: descobrindo módulos e variantes', cancellable: true }, async (_progress, token) => {
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    try {
      const catalog = await discoverAndroidWorkspace(await getBridge(), folders, controller.signal);
      const invalidated = await selection.refresh(catalog);
      for (const failure of catalog.failures) { output?.appendLine(`Falha ao descobrir ${failure.root}: ${failure.message}`); }
      if (invalidated.length) { output?.appendLine(`Seleção Android atualizada: ${invalidated.join(', ')}.`); }
      if (catalog.modules.length === 0) {
        const cause = catalog.failures.length ? ` ${catalog.failures[0].message}` : '';
        throw new Error(`Nenhum módulo Android encontrado.${cause}`);
      }
    } finally {
      subscription.dispose();
    }
  });
}

async function runSelectedTask(action: GradleAction, diagnostics: vscode.DiagnosticCollection): Promise<void> {
  if (!vscode.workspace.isTrusted) { throw new Error('Confie na pasta de trabalho antes de executar o Gradle.'); }
  await refreshProjects();
  if (!selectedGradleTarget()) { await selection.pickModule(createVscodeSelectionUi()); }
  const target = selectedGradleTarget();
  if (!target) { return; }
  const selectedModule = selection.resolve()?.module;
  if ((action === 'install' || action === 'bundle') && !selectedModule?.runnable) {
    throw new Error('Esta tarefa exige um módulo de aplicativo Android.');
  }
  const task = createGradleTask(target, action, diagnostics, artifacts => {
    lastArtifacts = artifacts;
    output?.appendLine(`Artefatos de ${target.modulePath} [${target.variant}]: ${artifacts.map(item => item.file).join(', ') || 'nenhum'}`);
  });
  await vscode.tasks.executeTask(task);
}

async function getBridge(): Promise<BridgeClient> {
  const previous = bridge;
  if (previous) {
    const client = await previous;
    if (!client.isClosed) { return client; }
    if (bridge === previous) { bridge = undefined; }
  }
  if (!bridge) {
    bridge = (async () => {
      const environment = await inspectEnvironment(extensionPath);
      if (!environment.java || !environment.javaVersion || environment.javaVersion < 17 || !environment.bridgeLib) {
        throw new Error(`Serviço Kotlin indisponível. Execute “Android: Diagnosticar ambiente”.`);
      }
      const config = vscode.workspace.getConfiguration('androidSupport');
      return BridgeClient.start(
        environment.java,
        environment.bridgeLib,
        config.get<string>('adbHost') || '127.0.0.1',
        config.get<number>('adbPort') || 5037,
        message => output?.appendLine(message)
      );
    })().catch(error => {
      bridge = undefined;
      throw error;
    });
  }
  return bridge;
}

async function runCommand(action: () => Promise<void>): Promise<void> {
  try { await action(); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output?.appendLine(message);
    void vscode.window.showErrorMessage(`Android: ${message}`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  extensionPath = context.extensionPath;
  output = vscode.window.createOutputChannel('Android');
  context.subscriptions.push(output);
  selection = new SelectionStore(context.workspaceState);
  const diagnostics = vscode.languages.createDiagnosticCollection('Android Gradle');
  context.subscriptions.push(diagnostics);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  status.command = 'androidSupport.selectVariant';
  const updateStatus = () => { status.text = `$(device-mobile) ${selection.statusText()}`; };
  updateStatus();
  status.show();
  context.subscriptions.push(status, selection.onDidChange(updateStatus));
  context.subscriptions.push(registerGradleTaskProvider(async refresh => {
    if (refresh || selection.modules.length === 0) {
      try { await refreshProjects(); } catch (error) { output?.appendLine(String(error)); }
    }
    return selectedGradleTarget();
  }, diagnostics, artifacts => { lastArtifacts = artifacts; }));

  context.subscriptions.push(vscode.commands.registerCommand('androidSupport.diagnose', () => runCommand(async () => {
    const environment = await inspectEnvironment(extensionPath);
    output?.clear();
    output?.appendLine(formatEnvironment(environment));
    output?.show(true);
  })));

  context.subscriptions.push(vscode.commands.registerCommand('androidSupport.adbVersion', () => runCommand(async () => {
    const client = await getBridge();
    const result = await client.request<{ version: number }>('server.version');
    void vscode.window.showInformationMessage(`Versão do protocolo do servidor ADB: ${result.version}`);
  })));

  context.subscriptions.push(vscode.commands.registerCommand('androidSupport.listDevices', () => runCommand(async () => {
    const client = await getBridge();
    const devices = await client.request<DeviceInfo[]>('devices.list');
    output?.appendLine(devices.length ? `Dispositivos ADB (${devices.length}):` : 'Nenhum dispositivo ADB encontrado.');
    for (const device of devices) {
      output?.appendLine(`- ${device.serial}: ${device.state}${device.model ? ` (${device.model})` : ''}`);
    }
    output?.show(true);
  })));

  context.subscriptions.push(vscode.commands.registerCommand('androidSupport.selectModule', () => runCommand(async () => {
    await refreshProjects();
    await selection.pickModule(createVscodeSelectionUi());
  })));
  context.subscriptions.push(vscode.commands.registerCommand('androidSupport.selectVariant', () => runCommand(async () => {
    await refreshProjects();
    if (!selection.resolve()) { await selection.pickModule(createVscodeSelectionUi()); }
    if (selection.resolve()) { await selection.pickVariant(createVscodeSelectionUi()); }
  })));
  for (const [command, action] of [
    ['androidSupport.build', 'assemble'], ['androidSupport.bundle', 'bundle'],
    ['androidSupport.install', 'install'], ['androidSupport.clean', 'clean']
  ] as const) {
    context.subscriptions.push(vscode.commands.registerCommand(command, () => runCommand(() => runSelectedTask(action, diagnostics))));
  }
}

export function deactivate(): void {
  void bridge?.then(client => client.dispose(), () => undefined);
  bridge = undefined;
}
