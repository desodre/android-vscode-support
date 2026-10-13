import * as vscode from 'vscode';
import { BridgeClient, DeviceInfo } from './bridgeClient';
import { formatEnvironment, inspectEnvironment } from './environment';

let bridge: Promise<BridgeClient> | undefined;
let output: vscode.OutputChannel | undefined;
let extensionPath: string;

async function getBridge(): Promise<BridgeClient> {
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
}

export function deactivate(): void {
  void bridge?.then(client => client.dispose(), () => undefined);
  bridge = undefined;
}
