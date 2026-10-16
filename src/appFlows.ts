import { apkCandidates, applicationIdToStop, DeviceActionBridge, installApk, launchApp, launcherActivities, stopApp } from './appRunner';
import { AttachOptions, DebugBridge, normalizePids, waitForProcess } from './debug/attach';
import { BuiltArtifact, findBuiltArtifacts } from './gradle/artifacts';
import { GradleSelection } from './gradle/runner';

export type DebugAdapterKind = AttachOptions['adapter'];

export interface DebugAdapterChoice {
  label: string;
  value: DebugAdapterKind;
}

/** User choices made during the flows; `createVscodeAppFlowUi` is the VS Code implementation. */
export interface AppFlowUi {
  pickApk(artifacts: readonly BuiltArtifact[]): Promise<BuiltArtifact | undefined>;
  pickActivity(activities: readonly string[]): Promise<string | undefined>;
  pickPid(applicationId: string, pids: readonly number[]): Promise<number | undefined>;
  pickAdapter(adapters: readonly DebugAdapterChoice[]): Promise<DebugAdapterKind | undefined>;
  withProgress<T>(title: string, task: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

export interface AppFlowDependencies {
  bridge(): Promise<DeviceActionBridge & DebugBridge>;
  ui: AppFlowUi;
  /** Runs the assemble task to completion and returns the artifacts it reported. */
  assemble(target: GradleSelection): Promise<BuiltArtifact[]>;
  attacher: { attach(bridge: DebugBridge, options: AttachOptions): Promise<boolean> };
  /** Debug adapters whose VS Code extensions are installed. */
  debugAdapters(): DebugAdapterChoice[];
  /** Project name and source roots for the Java adapter; throws if the selection no longer matches `target`. */
  javaDebugContext(target: GradleSelection): { projectName: string; sourcePaths: string[] };
  log(message: string): void;
  findArtifacts?: typeof findBuiltArtifacts;
}

const fileName = (file: string) => file.split(/[\\/]/).pop() ?? file;

/** Build, install, launch, stop and debug flows for the selected application module. */
export class AppFlows {
  private readonly installed = new Map<string, string>();

  constructor(private readonly deps: AppFlowDependencies) {}

  /** applicationId installed by this session for the variant on the device, if any. */
  installedApplicationId(target: GradleSelection, serial: string): string | undefined {
    return this.installed.get(installedKey(target, serial));
  }

  async buildAndInstall(target: GradleSelection, serial: string): Promise<string | undefined> {
    const built = await this.deps.assemble(target);
    const findArtifacts = this.deps.findArtifacts ?? findBuiltArtifacts;
    const artifacts = apkCandidates(built.length ? built : findArtifacts(target, target.applicationId ?? null), target);
    if (artifacts.length === 0) { throw new Error('Nenhum APK da variante selecionada foi encontrado após o build.'); }
    const artifact = artifacts.length === 1 ? artifacts[0] : await this.deps.ui.pickApk(artifacts);
    if (!artifact) { return undefined; }
    const client = await this.deps.bridge();
    const applicationId = await this.deps.ui.withProgress(`Android: instalando ${fileName(artifact.file)} em ${serial}`,
      signal => installApk(client, serial, artifact, target, signal));
    this.installed.set(installedKey(target, serial), applicationId);
    this.deps.log(`Instalado ${applicationId} em ${serial}.`);
    return applicationId;
  }

  async launch(applicationId: string, serial: string, waitForDebugger = false): Promise<boolean> {
    const client = await this.deps.bridge();
    const activities = await launcherActivities(client, serial, applicationId);
    if (activities.length === 0) { throw new Error(`Nenhuma Activity MAIN/LAUNCHER encontrada para ${applicationId}.`); }
    const component = activities.length === 1 ? activities[0] : await this.deps.ui.pickActivity(activities);
    if (!component) { return false; }
    await launchApp(client, serial, applicationId, component, undefined, waitForDebugger);
    this.deps.log(`Executando ${applicationId} em ${serial}: ${component}.`);
    return true;
  }

  async stop(target: GradleSelection, serial: string): Promise<void> {
    const findArtifacts = this.deps.findArtifacts ?? findBuiltArtifacts;
    const applicationId = applicationIdToStop(target,
      findArtifacts(target, target.applicationId ?? null), this.installedApplicationId(target, serial));
    await stopApp(await this.deps.bridge(), serial, applicationId);
    this.deps.log(`Aplicativo ${applicationId} parado em ${serial}.`);
  }

  /** Attaches to an already running process; `knownPids` skips the process lookup. */
  async attach(target: GradleSelection, serial: string, applicationId: string, knownPids?: readonly number[]): Promise<boolean> {
    const client = await this.deps.bridge();
    const pids = knownPids ? normalizePids(knownPids) : normalizePids((await client.request<{ pids: number[] }>(
      'debug.findProcess', { packageName: applicationId }, undefined, serial)).pids);
    if (pids.length === 0) { throw new Error(`O aplicativo ${applicationId} não está em execução em ${serial}.`); }
    const pid = pids.length === 1 ? pids[0] : await this.deps.ui.pickPid(applicationId, pids);
    if (!pid) { return false; }
    const adapters = this.deps.debugAdapters();
    if (adapters.length === 0) {
      throw new Error('Instale “Kotlin by JetBrains” ou “Debugger for Java” para conectar ao processo Android.');
    }
    const adapter = adapters.length === 1 ? adapters[0].value : await this.deps.ui.pickAdapter(adapters);
    if (!adapter) { return false; }
    const javaContext = adapter === 'java' ? this.deps.javaDebugContext(target) : undefined;
    const started = await this.deps.attacher.attach(client, {
      serial, pid, applicationId, adapter, rootPath: target.rootPath, ...javaContext,
    });
    if (started) { this.deps.log(`Depurador conectado a ${applicationId} em ${serial} (PID ${pid}).`); }
    return started;
  }

  async attachRunning(target: GradleSelection, serial: string): Promise<boolean> {
    const applicationId = this.installedApplicationId(target, serial) ?? target.applicationId;
    if (!applicationId) { throw new Error('O applicationId da variante não foi encontrado. Compile e instale o aplicativo primeiro.'); }
    return this.attach(target, serial, applicationId);
  }

  /** Builds, installs and starts the app waiting for a debugger, then attaches. A failed attach stops the app. */
  async debug(target: GradleSelection, serial: string): Promise<string | undefined> {
    const applicationId = await this.buildAndInstall(target, serial);
    if (!applicationId) { return undefined; }
    const client = await this.deps.bridge();
    await client.request('debug.setWaitForDebugger', { packageName: applicationId }, undefined, serial);
    let attached = false;
    try {
      await stopApp(client, serial, applicationId);
      if (!await this.launch(applicationId, serial, true)) { return undefined; }
      const pids = await this.deps.ui.withProgress(`Android: aguardando ${applicationId} iniciar em ${serial}`,
        signal => waitForProcess(client, serial, applicationId, signal));
      attached = await this.attach(target, serial, applicationId, pids);
    } finally {
      try {
        await client.request('debug.clearWaitForDebugger', { packageName: applicationId }, undefined, serial);
      } finally {
        if (!attached) { await stopApp(client, serial, applicationId).catch(error => this.deps.log(String(error))); }
      }
    }
    return attached ? applicationId : undefined;
  }
}

function installedKey(target: GradleSelection, serial: string): string {
  return JSON.stringify([target.rootPath, target.modulePath, target.variant, serial]);
}

/** Quick picks for `AppFlowUi`; the `vscode` module is loaded only when invoked. */
export function createVscodeAppFlowUi(
  withProgress: <T>(title: string, task: (signal: AbortSignal) => Promise<T>) => Promise<T>,
): AppFlowUi {
  const vscode = () => require('vscode') as typeof import('vscode');
  return {
    async pickApk(artifacts) {
      const chosen = await vscode().window.showQuickPick(artifacts.map(item => ({
        label: fileName(item.file),
        description: item.filters.map(filter => `${filter.filterType}: ${filter.value}`).join(', ') || item.file,
        detail: item.file,
        artifact: item,
      })), { placeHolder: 'Escolha o APK compatível com o dispositivo selecionado', matchOnDescription: true });
      return chosen?.artifact;
    },
    async pickActivity(activities) {
      return vscode().window.showQuickPick([...activities], { placeHolder: 'Escolha a Activity inicial do aplicativo' });
    },
    async pickPid(applicationId, pids) {
      return (await vscode().window.showQuickPick(pids.map(value => ({ label: `PID ${value}`, value })),
        { placeHolder: `Selecione o processo de ${applicationId}` }))?.value;
    },
    async pickAdapter(adapters) {
      return (await vscode().window.showQuickPick([...adapters], { placeHolder: 'Escolha o depurador para este processo' }))?.value;
    },
    withProgress,
  };
}
