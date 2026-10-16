import * as vscode from 'vscode';
import { resolve } from 'node:path';
import { AppFlows, createVscodeAppFlowUi, DebugAdapterChoice } from './appFlows';
import { BridgeClient, DeviceInfo } from './bridgeClient';
import { BridgeManager } from './bridgeManager';
import { createVscodeDeviceSelectionUi, DeviceSelectionStore } from './deviceSelection';
import { AndroidDebugAttacher } from './debug/attach';
import { listAvds, startAvd } from './emulator';
import { LogcatSession, pickLogcatFilter } from './logcat';
import { formatEnvironment, inspectEnvironment } from './environment';
import { BuiltArtifact } from './gradle/artifacts';
import { BuildDiagnosticCoordinator, buildTargetKey, dedupedDiagnosticPublisher } from './gradle/diagnosticCoordinator';
import { BuildIssue } from './gradle/diagnostics';
import { createGradleTask, executeTaskAndWait, registerGradleTaskProvider } from './gradle/taskProvider';
import { GradleAction, GradleSelection, toGradleSelection } from './gradle/runner';
import { discoverAndroidWorkspace } from './projectDiscovery';
import { createVscodeSelectionUi, SelectionStore } from './selection';
import { classifySourceFile, resolveSourceSets } from './sourceSets';
import { resourceDependencyModules, resourceVariant } from './resourceDependencies';
import { requireTrust, withCancellableProgress } from './ui/vscodeHelpers';
import { registerAndroidXmlResourceSupport } from './xmlResources';

let bridges: BridgeManager<BridgeClient> | undefined;
let output: vscode.OutputChannel | undefined;
let extensionPath: string;
let selection: SelectionStore;
let refreshInFlight: Promise<void> | undefined;
let syncBuildDiagnostics: (() => void) | undefined;
let deviceSelection: DeviceSelectionStore;
let logcat: LogcatSession | undefined;
let debugAttacher: AndroidDebugAttacher | undefined;
let appFlows: AppFlows;

/** All device operations must call this; no implicit selection of a sole connected device. */
export async function requireSelectedDevice(): Promise<string | undefined> {
  await refreshDevices();
  return deviceSelection.selectedSerial ?? deviceSelection.pick(createVscodeDeviceSelectionUi());
}

/** Selects a known online device after an explicit AVD choice by the user. */
export async function selectDeviceSerial(serial: string): Promise<void> {
  await refreshDevices();
  await deviceSelection.select(serial);
}

async function refreshDevices(): Promise<void> {
  const devices = await (await getBridge()).request<DeviceInfo[]>('devices.list');
  await deviceSelection.updateDevices(devices);
}

async function startLogcat(): Promise<void> {
  const serial = await requireSelectedDevice();
  if (!serial) { return; }
  const filter = await pickLogcatFilter();
  if (filter) { await logcat?.start(serial, filter); }
}

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
  requireTrust('consultar o Gradle');
  const folders = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
  if (folders.length === 0) { throw new Error('Abra uma pasta com um projeto Android Gradle.'); }
  await withCancellableProgress('Android: descobrindo módulos e variantes', async signal => {
    const catalog = await discoverAndroidWorkspace(await getBridge(), folders, signal);
    const invalidated = await selection.refresh(catalog);
    syncBuildDiagnostics?.();
    for (const failure of catalog.failures) { output?.appendLine(`Falha ao descobrir ${failure.root}: ${failure.message}`); }
    if (invalidated.length) { output?.appendLine(`Seleção Android atualizada: ${invalidated.join(', ')}.`); }
    if (catalog.modules.length === 0) {
      const cause = catalog.failures.length ? ` ${catalog.failures[0].message}` : '';
      throw new Error(`Nenhum módulo Android encontrado.${cause}`);
    }
  });
}

async function runSelectedTask(action: GradleAction, diagnostics: BuildDiagnosticCoordinator): Promise<void> {
  requireTrust('executar o Gradle');
  await refreshProjects();
  if (!selectedGradleTarget()) { await selection.pickModule(createVscodeSelectionUi()); }
  const target = selectedGradleTarget();
  if (!target) { return; }
  const selectedModule = selection.resolve()?.module;
  if (action === 'bundle' && !selectedModule?.runnable) {
    throw new Error('Esta tarefa exige um módulo de aplicativo Android.');
  }
  const task = createGradleTask(target, action, diagnostics, artifacts => {
    output?.appendLine(`Artefatos de ${target.modulePath} [${target.variant}]: ${artifacts.map(item => item.file).join(', ') || 'nenhum'}`);
  });
  await vscode.tasks.executeTask(task);
}

async function selectedApplication(): Promise<GradleSelection | undefined> {
  requireTrust('compilar ou instalar um aplicativo');
  await refreshProjects();
  if (!selectedGradleTarget()) { await selection.pickModule(createVscodeSelectionUi()); }
  const target = selectedGradleTarget();
  if (target && !target.runnable) { throw new Error('Selecione um módulo de aplicativo Android.'); }
  return target;
}

async function startChosenAvd(): Promise<string | undefined> {
  requireTrust('iniciar um emulador');
  const config = vscode.workspace.getConfiguration('androidSupport');
  if ((config.get<string>('adbHost') || '127.0.0.1') !== '127.0.0.1' ||
      (config.get<number>('adbPort') || 5037) !== 5037) {
    throw new Error('Iniciar AVD exige o servidor ADB local em 127.0.0.1:5037.');
  }
  const environment = await inspectEnvironment(extensionPath);
  if (!environment.sdk || !environment.adb) { throw new Error('Android SDK ou adb ausente. Execute “Android: Diagnosticar ambiente”.'); }
  const emulatorPath = environment.emulator;
  if (!emulatorPath) { throw new Error('Emulador Android inválido. Execute “Android: Diagnosticar ambiente”.'); }
  const avds = await listAvds(environment.sdk, undefined, emulatorPath);
  if (avds.length === 0) { throw new Error('Nenhum AVD existente foi encontrado no Android SDK.'); }
  const name = await vscode.window.showQuickPick(avds, { placeHolder: 'Selecione o AVD que deseja iniciar' });
  if (!name) { return undefined; }
  const client = await getBridge();
  const devices = await client.request<DeviceInfo[]>('devices.list');
  const serial = await withCancellableProgress(`Android: iniciando ${name}`, signal =>
    startAvd(environment.sdk!, environment.adb!, name, devices.map(device => device.serial), signal, emulatorPath));
  await selectDeviceSerial(serial);
  output?.appendLine(`AVD ${name} pronto: ${serial}.`);
  return serial;
}

async function chooseRunDevice(): Promise<string | undefined> {
  const choice = await vscode.window.showQuickPick([
    { label: 'Usar dispositivo conectado', value: 'device' },
    { label: 'Iniciar AVD existente', value: 'avd' },
  ], { placeHolder: 'Escolha onde executar o aplicativo Android' });
  if (!choice) { return undefined; }
  return choice.value === 'avd' ? startChosenAvd() : requireSelectedDevice();
}

async function attachDebugger(): Promise<void> {
  const target = await selectedApplication();
  if (!target) { return; }
  const serial = await requireSelectedDevice();
  if (!serial) { return; }
  await appFlows.attachRunning(target, serial);
}

async function debugSelected(): Promise<void> {
  if (installedDebugAdapters().length === 0) {
    throw new Error('Instale “Kotlin by JetBrains” ou “Debugger for Java” antes de depurar o aplicativo.');
  }
  const target = await selectedApplication();
  if (!target) { return; }
  const serial = await chooseRunDevice();
  if (!serial) { return; }
  await appFlows.debug(target, serial);
}

function installedDebugAdapters(): DebugAdapterChoice[] {
  const adapters: DebugAdapterChoice[] = [];
  if (vscode.extensions.getExtension('JetBrains.kotlin-server')) {
    adapters.push({ label: 'Kotlin e Java (JetBrains)', value: 'intellij_jvm' });
  }
  if (vscode.extensions.getExtension('vscjava.vscode-java-debug')) {
    adapters.push({ label: 'Java (Debugger for Java)', value: 'java' });
  }
  return adapters;
}

/** The Java adapter needs the Gradle project and source roots of the variant being debugged. */
function javaDebugContext(target: GradleSelection): { projectName: string; sourcePaths: string[] } {
  const resolved = selection.resolve();
  if (!resolved || resolved.module.root !== target.rootPath ||
      resolved.module.path !== target.modulePath || resolved.variant.name !== target.variant) {
    throw new Error('A seleção do módulo mudou. Selecione novamente o aplicativo para depurar.');
  }
  return {
    projectName: resolved.module.name,
    sourcePaths: resolveSourceSets(resolved.module, resolved.variant).sourceRoots.filter(root => root.exists).map(root => root.path),
  };
}

function getBridge(): Promise<BridgeClient> {
  if (!bridges) { return Promise.reject(new Error('Extensão Android desativada.')); }
  return bridges.get();
}

async function startBridge(): Promise<BridgeClient> {
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
}

async function runCommand(action: () => Promise<void>): Promise<void> {
  try { await action(); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output?.appendLine(message);
    void vscode.window.showErrorMessage(`Android: ${message}`);
  }
}

function createBuildDiagnostics(collection: vscode.DiagnosticCollection): BuildDiagnosticCoordinator {
  return new BuildDiagnosticCoordinator(dedupedDiagnosticPublisher({
    clear: () => collection.clear(),
    set: (file, issues) => collection.set(vscode.Uri.file(file), issues.map((issue: BuildIssue) => {
      const range = new vscode.Range(issue.line - 1, issue.column - 1, issue.line - 1, issue.column);
      const diagnostic = new vscode.Diagnostic(range, issue.message,
        issue.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
      diagnostic.source = 'Android Gradle';
      return diagnostic;
    })),
  }, file => vscode.languages.getDiagnostics(vscode.Uri.file(file)).filter(item => item.source !== 'Android Gradle')
    .map(item => ({ line: item.range.start.line, character: item.range.start.character, message: item.message }))));
}

export function activate(context: vscode.ExtensionContext): void {
  extensionPath = context.extensionPath;
  output = vscode.window.createOutputChannel('Android');
  context.subscriptions.push(output);
  bridges = new BridgeManager(startBridge, devices => {
    void deviceSelection.updateDevices(devices).catch(error => output?.appendLine(String(error)));
  }, message => output?.appendLine(message));
  debugAttacher = new AndroidDebugAttacher((configuration, options) => {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(options.rootPath));
    return Promise.resolve(vscode.debug.startDebugging(folder, configuration as vscode.DebugConfiguration));
  });
  context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(session => {
    void debugAttacher?.onDidTerminate(session.configuration).catch(error =>
      output?.appendLine(`Falha ao remover forward JDWP: ${String(error)}`));
  }));
  selection = new SelectionStore(context.workspaceState);
  deviceSelection = new DeviceSelectionStore(context.workspaceState);
  const logcatOutput = vscode.window.createOutputChannel('Android Logcat');
  context.subscriptions.push(logcatOutput);
  logcat = new LogcatSession(async (params, serial, listener) =>
    (await getBridge()).startStream('logcat.stream', params, serial, listener), logcatOutput, message => {
    output?.appendLine(`Logcat encerrado: ${message}`);
    void vscode.window.showErrorMessage(`Android Logcat: ${message}`);
  });
  const diagnostics = vscode.languages.createDiagnosticCollection('Android Gradle');
  context.subscriptions.push(diagnostics);
  const buildDiagnostics = createBuildDiagnostics(diagnostics);
  appFlows = new AppFlows({
    bridge: getBridge,
    ui: createVscodeAppFlowUi(withCancellableProgress),
    assemble: async target => {
      let built: BuiltArtifact[] = [];
      await executeTaskAndWait(createGradleTask(target, 'assemble', buildDiagnostics, artifacts => { built = artifacts; }));
      return built;
    },
    attacher: debugAttacher,
    debugAdapters: installedDebugAdapters,
    javaDebugContext,
    log: message => output?.appendLine(message),
  });
  syncBuildDiagnostics = () => {
    const resolved = selection.resolve();
    const target = resolved ? toGradleSelection(resolved) : undefined;
    const layout = resolved ? resolveSourceSets(resolved.module, resolved.variant) : undefined;
    buildDiagnostics.selectTarget(target ? buildTargetKey(target) : undefined,
      file => !layout || classifySourceFile(file, layout) !== 'inactive');
  };
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
    if (event.document.uri.scheme === 'file') { buildDiagnostics.invalidateFile(event.document.uri.fsPath); }
  }));
  context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(event => {
    for (const uri of event.uris) { if (uri.scheme === 'file') { buildDiagnostics.republish(uri.fsPath); } }
  }));
  const resourceContext = (moduleRoot: string) => {
    const owner = selection.modules.find(module => resolve(module.projectDir) === resolve(moduleRoot));
    if (!owner) { return undefined; }
    return { owner, variant: resourceVariant(owner, selection.resolve()) };
  };
  const xmlSupport = registerAndroidXmlResourceSupport(moduleRoot => {
    const context = resourceContext(moduleRoot);
    return context?.variant ? resolveSourceSets(context.owner, context.variant).sourceSetNames : ['main'];
  }, moduleRoot => {
    const context = resourceContext(moduleRoot);
    return context?.variant ? resourceDependencyModules(selection.modules, context.owner, context.variant) : [];
  }, moduleRoot => {
    return resourceContext(moduleRoot)?.owner.namespace;
  });
  context.subscriptions.push(xmlSupport);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  status.command = 'androidSupport.selectVariant';
  const updateStatus = () => {
    status.text = `$(device-mobile) ${selection.statusText()}`;
    syncBuildDiagnostics?.();
    xmlSupport.refresh();
  };
  updateStatus();
  status.show();
  context.subscriptions.push(status, selection.onDidChange(updateStatus));
  const deviceStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 89);
  deviceStatus.command = 'androidSupport.selectDevice';
  const updateDeviceStatus = () => {
    const serial = deviceSelection.selectedSerial;
    deviceStatus.text = serial ? `$(device-mobile) ${serial}` : '$(device-mobile) Android: selecionar dispositivo';
    deviceStatus.tooltip = serial ? `Dispositivo ADB selecionado: ${serial}` : 'Selecione um dispositivo ADB para executar operações';
    logcat?.stopIfSerialChanged(serial);
  };
  updateDeviceStatus();
  deviceStatus.show();
  context.subscriptions.push(deviceStatus, deviceSelection.onDidChange(updateDeviceStatus));
  context.subscriptions.push(registerGradleTaskProvider(async refresh => {
    if (refresh || selection.modules.length === 0) {
      try { await refreshProjects(); } catch (error) { output?.appendLine(String(error)); }
    }
    return selectedGradleTarget();
  }, buildDiagnostics));

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
    await refreshDevices();
    const devices = deviceSelection.snapshot;
    output?.appendLine(devices.length ? `Dispositivos ADB (${devices.length}):` : 'Nenhum dispositivo ADB encontrado.');
    for (const device of devices) {
      output?.appendLine(`- ${device.serial}: ${device.state}${device.model ? ` (${device.model})` : ''}`);
    }
    output?.show(true);
  })));

  context.subscriptions.push(vscode.commands.registerCommand('androidSupport.selectDevice', () => runCommand(async () => {
    await refreshDevices();
    await deviceSelection.pick(createVscodeDeviceSelectionUi());
  })));
  context.subscriptions.push(vscode.commands.registerCommand('androidSupport.logcat', () => runCommand(startLogcat)));
  context.subscriptions.push(vscode.commands.registerCommand('androidSupport.stopLogcat', () => logcat?.stop()));
  context.subscriptions.push(vscode.commands.registerCommand('androidSupport.attachDebugger', () => runCommand(attachDebugger)));
  context.subscriptions.push(vscode.commands.registerCommand('androidSupport.debug', () => runCommand(debugSelected)));

  context.subscriptions.push(vscode.commands.registerCommand('androidSupport.startAvd', () => runCommand(async () => {
    await startChosenAvd();
  })));
  context.subscriptions.push(vscode.commands.registerCommand('androidSupport.install', () => runCommand(async () => {
    const target = await selectedApplication();
    if (!target) { return; }
    const serial = await requireSelectedDevice();
    if (serial) { await appFlows.buildAndInstall(target, serial); }
  })));
  context.subscriptions.push(vscode.commands.registerCommand('androidSupport.run', () => runCommand(async () => {
    const target = await selectedApplication();
    if (!target) { return; }
    const serial = await chooseRunDevice();
    if (!serial) { return; }
    const applicationId = await appFlows.buildAndInstall(target, serial);
    if (applicationId) { await appFlows.launch(applicationId, serial); }
  })));
  context.subscriptions.push(vscode.commands.registerCommand('androidSupport.stop', () => runCommand(async () => {
    const target = await selectedApplication();
    if (!target) { return; }
    const serial = await requireSelectedDevice();
    if (!serial) { return; }
    await appFlows.stop(target, serial);
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
    ['androidSupport.clean', 'clean']
  ] as const) {
    context.subscriptions.push(vscode.commands.registerCommand(command, () => runCommand(() => runSelectedTask(action, buildDiagnostics))));
  }
}

export async function deactivate(): Promise<void> {
  syncBuildDiagnostics = undefined;
  logcat?.stop();
  logcat = undefined;
  await debugAttacher?.dispose().catch(error => output?.appendLine(`Falha ao remover forward JDWP: ${String(error)}`));
  debugAttacher = undefined;
  await bridges?.dispose();
  bridges = undefined;
}
