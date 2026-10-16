import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppFlowDependencies, AppFlows, AppFlowUi, DebugAdapterChoice } from '../appFlows';
import type { AttachOptions } from '../debug/attach';
import type { BuiltArtifact } from '../gradle/artifacts';
import type { GradleSelection } from '../gradle/runner';

const target: GradleSelection = { rootPath: '/workspace', modulePath: ':app', variant: 'debug', applicationId: 'com.example.app', runnable: true };
const apk = (file: string, filters: BuiltArtifact['filters'] = []): BuiltArtifact =>
  ({ type: 'APK', file, variant: 'debug', applicationId: 'com.example.app', filters });

interface Options {
  artifacts?: BuiltArtifact[];
  pids?: number[];
  adapters?: DebugAdapterChoice[];
  attach?: (options: AttachOptions) => Promise<boolean>;
  ui?: Partial<AppFlowUi>;
}

function harness(options: Options = {}) {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const logs: string[] = [];
  const attached: AttachOptions[] = [];
  const bridge = {
    async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push([method, params]);
      if (method === 'app.launchers') { return ['com.example.app/.MainActivity'] as T; }
      if (method === 'debug.findProcess') { return { pids: options.pids ?? [4321] } as T; }
      return {} as T;
    },
  };
  const ui: AppFlowUi = {
    pickApk: async () => { throw new Error('pickApk inesperado'); },
    pickActivity: async () => { throw new Error('pickActivity inesperado'); },
    pickPid: async () => { throw new Error('pickPid inesperado'); },
    pickAdapter: async () => { throw new Error('pickAdapter inesperado'); },
    withProgress: (_title, task) => task(new AbortController().signal),
    ...options.ui,
  };
  const deps: AppFlowDependencies = {
    bridge: async () => bridge,
    ui,
    assemble: async () => options.artifacts ?? [apk('/out/app-debug.apk')],
    attacher: { attach: async (_bridge, attachOptions) => {
      attached.push(attachOptions);
      return options.attach ? options.attach(attachOptions) : true;
    } },
    debugAdapters: () => options.adapters ?? [{ label: 'Kotlin', value: 'intellij_jvm' }],
    javaDebugContext: () => ({ projectName: 'app', sourcePaths: ['/workspace/app/src/main/java'] }),
    log: message => logs.push(message),
    findArtifacts: () => [],
  };
  return { flows: new AppFlows(deps), calls, logs, attached };
}

test('APK único é instalado sem abrir seletor e registra o applicationId', async () => {
  const { flows, calls, logs } = harness();
  assert.equal(await flows.buildAndInstall(target, 'serial-1'), 'com.example.app');
  assert.deepEqual(calls, [['app.install', { apkPath: '/out/app-debug.apk' }]]);
  assert.equal(flows.installedApplicationId(target, 'serial-1'), 'com.example.app');
  assert.equal(flows.installedApplicationId(target, 'serial-2'), undefined);
  assert.deepEqual(logs, ['Instalado com.example.app em serial-1.']);
});

test('cancelar a escolha entre vários APKs não instala nada', async () => {
  let offered: readonly BuiltArtifact[] = [];
  const { flows, calls } = harness({
    artifacts: [apk('/out/arm.apk', [{ filterType: 'ABI', value: 'arm64-v8a' }]), apk('/out/x86.apk', [{ filterType: 'ABI', value: 'x86_64' }])],
    ui: { pickApk: async artifacts => { offered = artifacts; return undefined; } },
  });
  assert.equal(await flows.buildAndInstall(target, 'serial-1'), undefined);
  assert.equal(offered.length, 2);
  assert.deepEqual(calls, []);
});

test('build sem APK da variante falha com mensagem clara', async () => {
  const { flows } = harness({ artifacts: [{ ...apk('/out/x.aab'), type: 'AAB' }] });
  await assert.rejects(flows.buildAndInstall(target, 'serial-1'), /Nenhum APK da variante/);
});

test('depuração reutiliza os PIDs da espera e não consulta o processo de novo', async () => {
  const { flows, calls, attached, logs } = harness();
  assert.equal(await flows.debug(target, 'serial-1'), 'com.example.app');
  assert.deepEqual(calls.map(([method]) => method), [
    'app.install', 'debug.setWaitForDebugger', 'app.stop', 'app.launchers', 'app.launch',
    'debug.findProcess', 'debug.clearWaitForDebugger',
  ]);
  assert.equal(attached[0].pid, 4321);
  assert.equal(attached[0].projectName, undefined, 'contexto Java só para o adaptador Java');
  assert.match(logs.at(-1) ?? '', /Depurador conectado a com.example.app em serial-1 \(PID 4321\)/);
});

test('falha no attach durante a depuração limpa a espera e para o app', async () => {
  const { flows, calls } = harness({ attach: async () => { throw new Error('handshake falhou'); } });
  await assert.rejects(flows.debug(target, 'serial-1'), /handshake falhou/);
  assert.deepEqual(calls.slice(-2).map(([method]) => method), ['debug.clearWaitForDebugger', 'app.stop']);
});

test('adaptador Java recebe projeto e fontes da variante', async () => {
  const { flows, attached } = harness({
    adapters: [{ label: 'Kotlin', value: 'intellij_jvm' }, { label: 'Java', value: 'java' }],
    ui: { pickAdapter: async () => 'java' },
  });
  assert.equal(await flows.attach(target, 'serial-1', 'com.example.app'), true);
  assert.equal(attached[0].adapter, 'java');
  assert.equal(attached[0].projectName, 'app');
  assert.deepEqual(attached[0].sourcePaths, ['/workspace/app/src/main/java']);
});

test('attach exige processo em execução e um depurador instalado', async () => {
  await assert.rejects(harness({ pids: [] }).flows.attach(target, 'serial-1', 'com.example.app'), /não está em execução/);
  await assert.rejects(harness({ adapters: [] }).flows.attach(target, 'serial-1', 'com.example.app'), /Instale/);
  let offered: readonly number[] = [];
  const { flows, attached } = harness({ pids: [7, 7, -1, 8], ui: { pickPid: async (_id, pids) => { offered = pids; return undefined; } } });
  assert.equal(await flows.attach(target, 'serial-1', 'com.example.app'), false);
  assert.deepEqual(offered, [7, 8]);
  assert.deepEqual(attached, []);
});

test('parar usa o applicationId instalado nesta sessão', async () => {
  const { flows, calls, logs } = harness();
  await flows.buildAndInstall({ ...target, applicationId: null }, 'serial-1');
  calls.length = 0;
  await flows.stop({ ...target, applicationId: null }, 'serial-1');
  assert.deepEqual(calls, [['app.stop', { applicationId: 'com.example.app' }]]);
  assert.equal(logs.at(-1), 'Aplicativo com.example.app parado em serial-1.');
});
