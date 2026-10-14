import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import * as vscode from 'vscode';

export interface Environment {
  java: string | undefined;
  javaVersion: number | undefined;
  sdk: string | undefined;
  adb: string | undefined;
  wrapper: string | undefined;
  bridgeLib: string | undefined;
  adbServer: boolean;
  problems: string[];
}

function expandPath(value: string): string {
  if (value === '~') { return homedir(); }
  if (value.startsWith('~/')) { return join(homedir(), value.slice(2)); }
  return resolve(value);
}

function firstSdkDirectory(candidates: (string | undefined)[]): string | undefined {
  return candidates.filter((item): item is string => !!item).map(expandPath).find(item =>
    existsSync(item) && statSync(item).isDirectory() &&
    (existsSync(join(item, 'platform-tools')) || existsSync(join(item, 'cmdline-tools')) || existsSync(join(item, 'platforms')))
  );
}

function executableOnPath(name: string): string | undefined {
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    for (const candidate of names) {
      const file = join(directory, candidate);
      if (existsSync(file)) { return file; }
    }
  }
  return undefined;
}

function javaExecutable(home: string | undefined): string | undefined {
  const binary = process.platform === 'win32' ? 'java.exe' : 'java';
  if (home) {
    const file = join(expandPath(home), 'bin', binary);
    return existsSync(file) ? file : undefined;
  }
  return executableOnPath('java');
}

function javaMajor(java: string): number | undefined {
  const output = spawnSync(java, ['-version'], { encoding: 'utf8', timeout: 3000 });
  const match = `${output.stderr ?? ''}\n${output.stdout ?? ''}`.match(/version\s+"(?:1\.)?(\d+)/);
  return match ? Number(match[1]) : undefined;
}

function adbServerReachable(host: string, port: number): Promise<boolean> {
  return new Promise(resolveResult => {
    const socket = createConnection({ host, port });
    let settled = false;
    let response = Buffer.alloc(0);
    const finish = (reachable: boolean) => {
      if (settled) { return; }
      settled = true;
      socket.destroy();
      resolveResult(reachable);
    };
    socket.setTimeout(1500);
    socket.once('connect', () => socket.write('000Chost:version'));
    socket.on('data', chunk => {
      response = Buffer.concat([response, chunk]);
      if (response.length < 4) { return; }
      if (response.toString('ascii', 0, 4) !== 'OKAY') { finish(false); return; }
      if (response.length < 8) { return; }
      const lengthText = response.toString('ascii', 4, 8);
      if (!/^[0-9a-fA-F]{4}$/.test(lengthText)) { finish(false); return; }
      const length = parseInt(lengthText, 16);
      if (length < 1 || length > 16) { finish(false); return; }
      if (response.length < 8 + length) { return; }
      finish(/^[0-9a-fA-F]+$/.test(response.toString('ascii', 8, 8 + length)));
    });
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
    socket.once('end', () => finish(false));
  });
}

export async function inspectEnvironment(extensionPath: string): Promise<Environment> {
  const config = vscode.workspace.getConfiguration('androidSupport');
  const javaHome = config.get<string>('javaHome')?.trim() || process.env.JAVA_HOME;
  const java = javaExecutable(javaHome);
  const javaVersion = java ? javaMajor(java) : undefined;
  const configuredSdk = config.get<string>('sdkPath')?.trim();
  const sdk = firstSdkDirectory(configuredSdk ? [configuredSdk] : [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), 'Android', 'Sdk'),
    join(homedir(), 'Library', 'Android', 'sdk')
  ]);
  const adbName = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const adbInSdk = sdk ? join(sdk, 'platform-tools', adbName) : undefined;
  const adb = adbInSdk && existsSync(adbInSdk) ? adbInSdk : executableOnPath('adb');
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const wrapperName = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
  const wrapperPath = workspace ? join(workspace, wrapperName) : undefined;
  const wrapper = wrapperPath && existsSync(wrapperPath) ? wrapperPath : undefined;
  const configuredBridge = config.get<string>('bridgeLibDirectory')?.trim();
  const bridgeLib = configuredBridge ? expandPath(configuredBridge) : join(extensionPath, 'bridge', 'build', 'install', 'bridge', 'lib');
  const bridgeReady = existsSync(bridgeLib) && readdirSync(bridgeLib).some(file => /^bridge(?:-.*)?\.jar$/.test(file));
  const host = config.get<string>('adbHost') || '127.0.0.1';
  const port = config.get<number>('adbPort') || 5037;
  const adbServer = await adbServerReachable(host, port);
  const problems: string[] = [];
  if (!java) { problems.push('JDK não encontrado. Instale JDK 17+ e configure androidSupport.javaHome ou JAVA_HOME.'); }
  else if (!javaVersion || javaVersion < 17) { problems.push(`JDK 17+ necessário; versão detectada: ${javaVersion ?? 'desconhecida'}. Configure androidSupport.javaHome.`); }
  if (!sdk) {
    problems.push(configuredSdk
      ? `Android SDK não encontrado em ${expandPath(configuredSdk)}. Corrija androidSupport.sdkPath.`
      : 'Android SDK não encontrado. Configure androidSupport.sdkPath ou ANDROID_HOME.');
  }
  if (!adb) { problems.push('adb não encontrado. Instale Android SDK Platform-Tools.'); }
  if (!wrapper) { problems.push('Wrapper Gradle não encontrado na pasta aberta. Abra a raiz do projeto Android que contém gradlew.'); }
  if (!bridgeReady) { problems.push('Serviço Kotlin não compilado. Na raiz da extensão, execute npm run build:bridge.'); }
  if (!adbServer) { problems.push(`Servidor ADB indisponível ou inválido em ${host}:${port}. Verifique androidSupport.adbHost/androidSupport.adbPort; para um servidor local, execute adb start-server.`); }
  return { java, javaVersion, sdk, adb, wrapper, bridgeLib: bridgeReady ? bridgeLib : undefined, adbServer, problems };
}

export function formatEnvironment(environment: Environment): string {
  const label = (value: string | undefined) => value ?? 'não encontrado';
  return [
    'Diagnóstico Android VS Code Support',
    `JDK: ${label(environment.java)}${environment.javaVersion ? ` (versão ${environment.javaVersion})` : ''}`,
    `Android SDK: ${label(environment.sdk)}`,
    `adb: ${label(environment.adb)}`,
    `Wrapper Gradle: ${label(environment.wrapper)}`,
    `Serviço Kotlin: ${label(environment.bridgeLib)}`,
    `Servidor ADB: ${environment.adbServer ? 'disponível' : 'indisponível'}`,
    '',
    environment.problems.length ? `Ações necessárias:\n- ${environment.problems.join('\n- ')}` : 'Ambiente pronto para as operações ADB iniciais.'
  ].join('\n');
}
