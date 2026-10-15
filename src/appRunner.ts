import { BuiltArtifact } from './gradle/artifacts';
import { GradleSelection } from './gradle/runner';

export interface DeviceActionBridge {
  request<T>(method: string, params?: Record<string, unknown>, signal?: AbortSignal, device?: string, timeoutMs?: number): Promise<T>;
}

const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

export function apkCandidates(artifacts: readonly BuiltArtifact[], selection: GradleSelection): BuiltArtifact[] {
  return artifacts.filter(artifact =>
    artifact.type === 'APK' &&
    artifact.variant === selection.variant &&
    (!selection.applicationId || !artifact.applicationId || artifact.applicationId === selection.applicationId)
  );
}

export function applicationIdFor(artifact: BuiltArtifact, selection: GradleSelection): string {
  const applicationId = artifact.applicationId ?? selection.applicationId;
  if (!applicationId || !PACKAGE_NAME.test(applicationId)) {
    throw new Error('applicationId da variante não encontrado. Verifique o build e selecione um APK com metadados válidos.');
  }
  if (artifact.applicationId && selection.applicationId && artifact.applicationId !== selection.applicationId) {
    throw new Error('O APK pertence a um applicationId diferente da variante selecionada.');
  }
  return applicationId;
}

export function applicationIdToStop(selection: GradleSelection, artifacts: readonly BuiltArtifact[], installedId?: string): string {
  const known = installedId ?? selection.applicationId;
  if (known && PACKAGE_NAME.test(known)) { return known; }
  const candidates = new Set(apkCandidates(artifacts, selection).map(artifact => artifact.applicationId).filter(
    (value): value is string => typeof value === 'string' && PACKAGE_NAME.test(value)
  ));
  if (candidates.size === 1) { return [...candidates][0]; }
  throw new Error('applicationId do aplicativo não encontrado ou ambíguo. Instale a variante antes de pará-la.');
}

function requireSerial(serial: string): string {
  if (!serial.trim()) { throw new Error('Selecione um dispositivo Android antes de instalar ou executar.'); }
  return serial;
}

export async function installApk(
  bridge: DeviceActionBridge, serial: string, artifact: BuiltArtifact, selection: GradleSelection, signal?: AbortSignal,
): Promise<string> {
  if (artifact.type !== 'APK' || artifact.variant !== selection.variant) {
    throw new Error('O APK escolhido não pertence à variante selecionada.');
  }
  const applicationId = applicationIdFor(artifact, selection);
  await bridge.request('app.install', { apkPath: artifact.file }, signal, requireSerial(serial), 180_000);
  return applicationId;
}

export async function launcherActivities(
  bridge: DeviceActionBridge, serial: string, applicationId: string, signal?: AbortSignal,
): Promise<string[]> {
  if (!PACKAGE_NAME.test(applicationId)) { throw new Error('applicationId inválido.'); }
  const components = await bridge.request<unknown>('app.launchers', { applicationId }, signal, requireSerial(serial));
  if (!Array.isArray(components) || !components.every(value => typeof value === 'string' && value.startsWith(`${applicationId}/`))) {
    throw new Error('Resposta inválida ao consultar atividades iniciais.');
  }
  return components;
}

export async function launchApp(
  bridge: DeviceActionBridge, serial: string, applicationId: string, component: string, signal?: AbortSignal,
  waitForDebugger = false,
): Promise<void> {
  if (!PACKAGE_NAME.test(applicationId) || !component.startsWith(`${applicationId}/`)) {
    throw new Error('Atividade inicial inválida para o aplicativo selecionado.');
  }
  await bridge.request('app.launch', waitForDebugger
    ? { applicationId, component, waitForDebugger: true } : { applicationId, component }, signal, requireSerial(serial));
}

export async function stopApp(
  bridge: DeviceActionBridge, serial: string, applicationId: string, signal?: AbortSignal,
): Promise<void> {
  if (!PACKAGE_NAME.test(applicationId)) { throw new Error('applicationId inválido.'); }
  await bridge.request('app.stop', { applicationId }, signal, requireSerial(serial));
}
