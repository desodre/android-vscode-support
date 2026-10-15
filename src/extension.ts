import * as vscode from 'vscode';
import { resolve } from 'node:path';
import { apkCandidates, applicationIdToStop, installApk, launchApp, launcherActivities, stopApp } from './appRunner';
import { BridgeClient, DeviceInfo } from './bridgeClient';
import { createVscodeDeviceSelectionUi, DeviceSelectionStore } from './deviceSelection';
import { AndroidDebugAttacher, AttachOptions, waitForProcess } from './debug/attach';
import { listAvds, startAvd } from './emulator';
import { formatEnvironment, inspectEnvironment } from './environment';
import { BuiltArtifact, findBuiltArtifacts } from './gradle/artifacts';
import { BuildDiagnosticCoordinator, buildTargetKey } from './gradle/diagnosticCoordinator';
import { BuildIssue } from './gradle/diagnostics';
import { createGradleTask, registerGradleTaskProvider } from './gradle/taskProvider';
import { GradleAction, GradleSelection, toGradleSelection } from './gradle/runner';
import { discoverAndroidWorkspace } from './projectDiscovery';
import { createVscodeSelectionUi, SelectionStore } from './selection';
import { classifySourceFile, resolveSourceSets } from './sourceSets';
import { resourceDependencyModules } from './resourceDependencies';
import { registerAndroidXmlResourceSupport } from './xmlResources';

let bridge: Promise<BridgeClient> | undefined;
let output: vscode.OutputChannel | undefined;
let extensionPath: string;
let selection: SelectionStore;
let lastArtifacts: BuiltArtifact[] = [];
let refreshInFlight: Promise<void> | undefined;
let syncBuildDiagnostics: (() => void) | undefined;
let deviceSelection: DeviceSelectionStore;
let deviceTracking: ReturnType<BridgeClient['startStream']> | undefined;
let logcatStream: ReturnType<BridgeClient['startStream']> | undefined;
let logcatOutput: vscode.OutputChannel | undefined;
let activeLogcatSerial: string | undefined;
let debugAttacher: AndroidDebugAttacher | undefined;
const installedApplicationIds = new Map<string, string>();

function installedKey(target: GradleSelection, serial: string): string {
  return JSON.stringify([target.rootPath, target.modulePath, target.variant, serial]);
}

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

function stopLogcat(): void {
  logcatStream?.stop();
  logcatStream = undefined;
  activeLogcatSerial = undefined;
}

async function startLogcat(): Promise<void> {
  const serial = await requireSelectedDevice();
  if (!serial) { return; }
  const filter = await vscode.window.showQuickPick([
    { label: 'Todos os processos', value: 'all' },
    { label: 'Aplicativo (ID do pacote)', value: 'package' },
    { label: 'Processo (PID)', value: 'pid' }
  ], { placeHolder: 'Filtrar o Logcat' });
  if (!filter) { return; }
  const params: Record<string, unknown> = {};
  if (filter.value === 'package') {
    const packageName = await vscode.window.showInputBox({ prompt: 'ID do pacote Android em execução', placeHolder: 'com.exemplo.app', validateInput: value =>
      /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(value) ? undefined : 'Informe um ID de pacote válido.' });
    if (!packageName) { return; }
    params.packageName = packageName;
  } else if (filter.value === 'pid') {
    const processId = await vscode.window.showInputBox({ prompt: 'PID do processo Android', validateInput: value =>
      /^[1-9]\d*$/.test(value) ? undefined : 'Informe um PID positivo.' });
    if (!processId) { return; }
    params.processId = Number(processId);
  }
  stopLogcat();
  const channel = logcatOutput;
  channel?.clear();
  channel?.appendLine(`Logcat: ${serial} · ${filter.label}`);
  channel?.show(true);
  const stream = (await getBridge()).startStream('logcat.stream', params, serial, (event, data) => {
    if (event === 'logcat.entry') {
      const entry = data as { rawLine?: string };
      if (entry.rawLine) { channel?.appendLine(entry.rawLine); }
    } else if (event === 'logcat.started') {
      const started = data as { processIds?: number[] };
      if (started.processIds?.length) { channel?.appendLine(`PIDs filtrados: ${started.processIds.join(', ')}`); }
    } else if (event === 'logcat.filterChanged') {
      const changed = data as { processIds?: number[] };
      channel?.appendLine(changed.processIds?.length
        ? `Filtro atualizado para PIDs: ${changed.processIds.join(', ')}` : 'Aguardando o aplicativo iniciar…');
    }
  });
  logcatStream = stream;
  activeLogcatSerial = serial;
  void stream.done.catch(error => {
    if (logcatStream === stream) {
      output?.appendLine(`Logcat encerrado: ${error instanceof Error ? error.message : String(error)}`);
      void vscode.window.showErrorMessage(`Android Logcat: ${error instanceof Error ? error.message : String(error)}`);
    }
  }).finally(() => { if (logcatStream === stream) { logcatStream = undefined; } });
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
  if (!vscode.workspace.isTrusted) { throw new Error('Confie na pasta de trabalho antes de consultar o Gradle.'); }
  const folders = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
  if (folders.length === 0) { throw new Error('Abra uma pasta com um projeto Android Gradle.'); }
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Android: descobrindo módulos e variantes', cancellable: true }, async (_progress, token) => {
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    try {
      const catalog = await discoverAndroidWorkspace(await getBridge(), folders, controller.signal);
      const invalidated = await selection.refresh(catalog);
      syncBuildDiagnostics?.();
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

async function runSelectedTask(action: GradleAction, diagnostics: BuildDiagnosticCoordinator): Promise<void> {
  if (!vscode.workspace.isTrusted) { throw new Error('Confie na pasta de trabalho antes de executar o Gradle.'); }
  await refreshProjects();
  if (!selectedGradleTarget()) { await selection.pickModule(createVscodeSelectionUi()); }
  const target = selectedGradleTarget();
  if (!target) { return; }
  const selectedModule = selection.resolve()?.module;
  if (action === 'bundle' && !selectedModule?.runnable) {
    throw new Error('Esta tarefa exige um módulo de aplicativo Android.');
  }
  const task = createGradleTask(target, action, diagnostics, artifacts => {
    lastArtifacts = artifacts;
    output?.appendLine(`Artefatos de ${target.modulePath} [${target.variant}]: ${artifacts.map(item => item.file).join(', ') || 'nenhum'}`);
  });
  await vscode.tasks.executeTask(task);
}

async function selectedApplication(): Promise<GradleSelection | undefined> {
  if (!vscode.workspace.isTrusted) { throw new Error('Confie na pasta de trabalho antes de compilar ou instalar um aplicativo.'); }
  await refreshProjects();
  if (!selectedGradleTarget()) { await selection.pickModule(createVscodeSelectionUi()); }
  const target = selectedGradleTarget();
  if (target && !target.runnable) { throw new Error('Selecione um módulo de aplicativo Android.'); }
  return target;
}

async function executeAndWait(task: vscode.Task): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let execution: vscode.TaskExecution | undefined;
    const earlyEvents: vscode.TaskProcessEndEvent[] = [];
    const finish = (event: vscode.TaskProcessEndEvent) => {
      listener.dispose();
      if (event.exitCode === 0) { resolve(); }
      else { reject(new Error(`Build Android falhou ou foi cancelado (código ${event.exitCode ?? 'desconhecido'}). Veja a saída da tarefa.`)); }
    };
    const listener = vscode.tasks.onDidEndTaskProcess(event => {
      if (!execution) { earlyEvents.push(event); return; }
      if (event.execution === execution) { finish(event); }
    });
    void vscode.tasks.executeTask(task).then(started => {
      execution = started;
      const ended = earlyEvents.find(event => event.execution === started);
      if (ended) { finish(ended); }
    }, error => { listener.dispose(); reject(error); });
  });
}

async function buildAndInstall(target: GradleSelection, serial: string, diagnostics: BuildDiagnosticCoordinator): Promise<string | undefined> {
  let built: BuiltArtifact[] = [];
  const task = createGradleTask(target, 'assemble', diagnostics, artifacts => { built = artifacts; lastArtifacts = artifacts; });
  await executeAndWait(task);
  const artifacts = apkCandidates(built.length ? built : findBuiltArtifacts(target, target.applicationId ?? null), target);
  if (artifacts.length === 0) { throw new Error('Nenhum APK da variante selecionada foi encontrado após o build.'); }
  let artifact = artifacts[0];
  if (artifacts.length > 1) {
    const chosen = await vscode.window.showQuickPick(artifacts.map(item => ({
      label: item.file.split(/[\\/]/).pop() ?? item.file,
      description: item.filters.map(filter => `${filter.filterType}: ${filter.value}`).join(', ') || item.file,
      detail: item.file,
      artifact: item,
    })), { placeHolder: 'Escolha o APK compatível com o dispositivo selecionado', matchOnDescription: true });
    if (!chosen) { return undefined; }
    artifact = chosen.artifact;
  }
  const client = await getBridge();
  const applicationId = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification, title: `Android: instalando ${artifact.file.split(/[\\/]/).pop()} em ${serial}`, cancellable: true,
  }, async (_progress, token) => {
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    try { return await installApk(client, serial, artifact, target, controller.signal); }
    finally { subscription.dispose(); }
  });
  installedApplicationIds.set(installedKey(target, serial), applicationId);
  output?.appendLine(`Instalado ${applicationId} em ${serial}.`);
  return applicationId;
}

async function startChosenAvd(): Promise<string | undefined> {
  if (!vscode.workspace.isTrusted) { throw new Error('Confie na pasta de trabalho antes de iniciar um emulador.'); }
  const config = vscode.workspace.getConfiguration('androidSupport');
  if ((config.get<string>('adbHost') || '127.0.0.1') !== '127.0.0.1' ||
      (config.get<number>('adbPort') || 5037) !== 5037) {
    throw new Error('Iniciar AVD exige o servidor ADB local em 127.0.0.1:5037.');
  }
  const environment = await inspectEnvironment(extensionPath);
  if (!environment.sdk || !environment.adb) { throw new Error('Android SDK ou adb ausente. Execute “Android: Diagnosticar ambiente”.'); }
  const avds = await listAvds(environment.sdk);
  if (avds.length === 0) { throw new Error('Nenhum AVD existente foi encontrado no Android SDK.'); }
  const name = await vscode.window.showQuickPick(avds, { placeHolder: 'Selecione o AVD que deseja iniciar' });
  if (!name) { return undefined; }
  const client = await getBridge();
  const devices = await client.request<DeviceInfo[]>('devices.list').catch(() => [] as DeviceInfo[]);
  const serial = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification, title: `Android: iniciando ${name}`, cancellable: true,
  }, async (_progress, token) => {
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    try {
      return await startAvd(environment.sdk!, environment.adb!, name, devices.map(device => device.serial),
        controller.signal);
    } finally { subscription.dispose(); }
  });
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

async function launchInstalled(applicationId: string, serial: string, waitForDebugger = false): Promise<boolean> {
  const client = await getBridge();
  const activities = await launcherActivities(client, serial, applicationId);
  if (activities.length === 0) { throw new Error(`Nenhuma Activity MAIN/LAUNCHER encontrada para ${applicationId}.`); }
  const component = activities.length === 1 ? activities[0] :
    await vscode.window.showQuickPick(activities, { placeHolder: 'Escolha a Activity inicial do aplicativo' });
  if (!component) { return false; }
  await launchApp(client, serial, applicationId, component, undefined, waitForDebugger);
  output?.appendLine(`Executando ${applicationId} em ${serial}: ${component}.`);
  return true;
}

async function attachToApplication(target: GradleSelection, serial: string, applicationId: string, client: BridgeClient): Promise<boolean> {
  const processes = await client.request<{ pids: number[] }>('debug.findProcess', { packageName: applicationId }, undefined, serial);
  const pids = [...new Set(processes.pids)].filter(pid => Number.isSafeInteger(pid) && pid > 0);
  if (pids.length === 0) { throw new Error(`O aplicativo ${applicationId} não está em execução em ${serial}.`); }
  const pid = pids.length === 1 ? pids[0] : (await vscode.window.showQuickPick(pids.map(value => ({
    label: `PID ${value}`, value
  })), { placeHolder: `Selecione o processo de ${applicationId}` }))?.value;
  if (!pid) { return false; }
  const adapters: Array<{ label: string; value: AttachOptions['adapter'] }> = [];
  if (vscode.extensions.getExtension('JetBrains.kotlin-server')) {
    adapters.push({ label: 'Kotlin e Java (JetBrains)', value: 'intellij_jvm' });
  }
  if (vscode.extensions.getExtension('vscjava.vscode-java-debug')) {
    adapters.push({ label: 'Java (Debugger for Java)', value: 'java' });
  }
  if (adapters.length === 0) {
    throw new Error('Instale “Kotlin by JetBrains” ou “Debugger for Java” para conectar ao processo Android.');
  }
  const adapter = adapters.length === 1 ? adapters[0].value
    : (await vscode.window.showQuickPick(adapters, { placeHolder: 'Escolha o depurador para este processo' }))?.value;
  if (!adapter) { return false; }
  const resolved = selection.resolve();
  if (adapter === 'java' && (!resolved || resolved.module.root !== target.rootPath ||
      resolved.module.path !== target.modulePath || resolved.variant.name !== target.variant)) {
    throw new Error('A seleção do módulo mudou. Selecione novamente o aplicativo para depurar.');
  }
  const javaSources = adapter === 'java' && resolved
    ? resolveSourceSets(resolved.module, resolved.variant).sourceRoots.filter(root => root.exists).map(root => root.path)
    : undefined;
  const started = await debugAttacher!.attach(client, {
    serial, pid, applicationId, adapter, rootPath: target.rootPath,
    ...(adapter === 'java' && resolved ? { projectName: resolved.module.name, sourcePaths: javaSources } : {}),
  });
  if (started) { output?.appendLine(`Depurador conectado a ${applicationId} em ${serial} (PID ${pid}).`); }
  return started;
}

async function attachDebugger(): Promise<void> {
  const target = await selectedApplication();
  if (!target) { return; }
  const serial = await requireSelectedDevice();
  if (!serial) { return; }
  const applicationId = installedApplicationIds.get(installedKey(target, serial)) ?? target.applicationId;
  if (!applicationId) { throw new Error('O applicationId da variante não foi encontrado. Compile e instale o aplicativo primeiro.'); }
  await attachToApplication(target, serial, applicationId, await getBridge());
}

async function debugSelected(diagnostics: BuildDiagnosticCoordinator): Promise<void> {
  if (!vscode.extensions.getExtension('JetBrains.kotlin-server') &&
      !vscode.extensions.getExtension('vscjava.vscode-java-debug')) {
    throw new Error('Instale “Kotlin by JetBrains” ou “Debugger for Java” antes de depurar o aplicativo.');
  }
  const target = await selectedApplication();
  if (!target) { return; }
  const serial = await chooseRunDevice();
  if (!serial) { return; }
  const applicationId = await buildAndInstall(target, serial, diagnostics);
  if (!applicationId) { return; }
  const client = await getBridge();
  await client.request('debug.setWaitForDebugger', { packageName: applicationId }, undefined, serial);
  let attached = false;
  try {
    await stopApp(client, serial, applicationId);
    if (!await launchInstalled(applicationId, serial, true)) { return; }
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification, title: `Android: aguardando ${applicationId} iniciar em ${serial}`,
      cancellable: true,
    }, async (_progress, token) => {
      const controller = new AbortController();
      const subscription = token.onCancellationRequested(() => controller.abort());
      try { await waitForProcess(client, serial, applicationId, controller.signal); }
      finally { subscription.dispose(); }
    });
    attached = await attachToApplication(target, serial, applicationId, client);
  } finally {
    try {
      await client.request('debug.clearWaitForDebugger', { packageName: applicationId }, undefined, serial);
    } finally {
      if (!attached) { await stopApp(client, serial, applicationId).catch(error => output?.appendLine(String(error))); }
    }
  }
}

function ensureDeviceTracking(client: BridgeClient): void {
  if (deviceTracking) { return; }
  const tracking = client.startStream('devices.track', {}, undefined, (event, data) => {
    if (event === 'devices.changed') {
      void deviceSelection.updateDevices(data as DeviceInfo[]).catch(error => output?.appendLine(String(error)));
    }
  });
  deviceTracking = tracking;
  void tracking.done.catch(error => {
    if (deviceTracking === tracking && !client.isClosed) {
      output?.appendLine(`Monitor de dispositivos encerrado: ${String(error)}`);
    }
  }).finally(() => {
    if (deviceTracking === tracking) { deviceTracking = undefined; }
  });
}

async function getBridge(): Promise<BridgeClient> {
  const previous = bridge;
  if (previous) {
    const client = await previous;
    if (!client.isClosed) { ensureDeviceTracking(client); return client; }
    if (bridge === previous) { bridge = undefined; }
  }
  if (!bridge) {
    bridge = (async () => {
      const environment = await inspectEnvironment(extensionPath);
      if (!environment.java || !environment.javaVersion || environment.javaVersion < 17 || !environment.bridgeLib) {
        throw new Error(`Serviço Kotlin indisponível. Execute “Android: Diagnosticar ambiente”.`);
      }
      const config = vscode.workspace.getConfiguration('androidSupport');
      const client = await BridgeClient.start(
        environment.java,
        environment.bridgeLib,
        config.get<string>('adbHost') || '127.0.0.1',
        config.get<number>('adbPort') || 5037,
        message => output?.appendLine(message)
      );
      deviceTracking?.stop();
      deviceTracking = undefined;
      ensureDeviceTracking(client);
      return client;
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

function createBuildDiagnostics(collection: vscode.DiagnosticCollection): BuildDiagnosticCoordinator {
  const published = new Map<string, string>();
  const normalizedMessage = (message: string) => message.trim().replace(/\s+/g, ' ');
  return new BuildDiagnosticCoordinator({
    clear: () => { published.clear(); collection.clear(); },
    replace: (file, issues) => {
      const uri = vscode.Uri.file(file);
      const external = vscode.languages.getDiagnostics(uri).filter(item => item.source !== 'Android Gradle');
      const visible = issues.filter(issue => !external.some(item =>
        item.range.start.line === issue.line - 1 && item.range.start.character === issue.column - 1 &&
        normalizedMessage(item.message) === normalizedMessage(issue.message)));
      const fingerprint = JSON.stringify(visible.map(issue => [issue.line, issue.column, issue.severity, issue.message]));
      if (published.get(uri.toString()) === fingerprint) { return; }
      published.set(uri.toString(), fingerprint);
      const converted = visible.map((issue: BuildIssue) => {
        const range = new vscode.Range(issue.line - 1, issue.column - 1, issue.line - 1, issue.column);
        const diagnostic = new vscode.Diagnostic(range, issue.message,
          issue.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
        diagnostic.source = 'Android Gradle';
        return diagnostic;
      });
      collection.set(uri, converted);
    },
  });
}

export function activate(context: vscode.ExtensionContext): void {
  extensionPath = context.extensionPath;
  output = vscode.window.createOutputChannel('Android');
  context.subscriptions.push(output);
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
  logcatOutput = vscode.window.createOutputChannel('Android Logcat');
  context.subscriptions.push(logcatOutput);
  const diagnostics = vscode.languages.createDiagnosticCollection('Android Gradle');
  context.subscriptions.push(diagnostics);
  const buildDiagnostics = createBuildDiagnostics(diagnostics);
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
    const resolved = selection.resolve();
    const compatible = resolved ? owner.variants.filter(candidate =>
      candidate.buildType === resolved.variant.buildType && candidate.flavors.every(flavor =>
        resolved.variant.flavors.some(selected => selected.dimension === flavor.dimension && selected.name === flavor.name))) : [];
    const variant = resolved?.module === owner ? resolved.variant
      : compatible.length === 1 ? compatible[0]
        : owner.variants.length === 1 ? owner.variants[0] : undefined;
    return { owner, variant };
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
    if (activeLogcatSerial && activeLogcatSerial !== serial) { stopLogcat(); }
  };
  updateDeviceStatus();
  deviceStatus.show();
  context.subscriptions.push(deviceStatus, deviceSelection.onDidChange(updateDeviceStatus));
  context.subscriptions.push(registerGradleTaskProvider(async refresh => {
    if (refresh || selection.modules.length === 0) {
      try { await refreshProjects(); } catch (error) { output?.appendLine(String(error)); }
    }
    return selectedGradleTarget();
  }, buildDiagnostics, artifacts => { lastArtifacts = artifacts; }));

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
  context.subscriptions.push(vscode.commands.registerCommand('androidSupport.stopLogcat', stopLogcat));
  context.subscriptions.push(vscode.commands.registerCommand('androidSupport.attachDebugger', () => runCommand(attachDebugger)));
  context.subscriptions.push(vscode.commands.registerCommand('androidSupport.debug', () => runCommand(() => debugSelected(buildDiagnostics))));

  context.subscriptions.push(vscode.commands.registerCommand('androidSupport.startAvd', () => runCommand(async () => {
    await startChosenAvd();
  })));
  context.subscriptions.push(vscode.commands.registerCommand('androidSupport.install', () => runCommand(async () => {
    const target = await selectedApplication();
    if (!target) { return; }
    const serial = await requireSelectedDevice();
    if (serial) { await buildAndInstall(target, serial, buildDiagnostics); }
  })));
  context.subscriptions.push(vscode.commands.registerCommand('androidSupport.run', () => runCommand(async () => {
    const target = await selectedApplication();
    if (!target) { return; }
    const serial = await chooseRunDevice();
    if (!serial) { return; }
    const applicationId = await buildAndInstall(target, serial, buildDiagnostics);
    if (applicationId) { await launchInstalled(applicationId, serial); }
  })));
  context.subscriptions.push(vscode.commands.registerCommand('androidSupport.stop', () => runCommand(async () => {
    const target = await selectedApplication();
    if (!target) { return; }
    const serial = await requireSelectedDevice();
    if (!serial) { return; }
    const applicationId = applicationIdToStop(target,
      findBuiltArtifacts(target, target.applicationId ?? null), installedApplicationIds.get(installedKey(target, serial)));
    await stopApp(await getBridge(), serial, applicationId);
    output?.appendLine(`Aplicativo ${applicationId} parado em ${serial}.`);
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
  stopLogcat();
  deviceTracking?.stop();
  deviceTracking = undefined;
  await debugAttacher?.dispose().catch(error => output?.appendLine(`Falha ao remover forward JDWP: ${String(error)}`));
  debugAttacher = undefined;
  await bridge?.then(client => client.dispose(), () => undefined);
  bridge = undefined;
}
