import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedSelection } from '../selection';

export type GradleAction = 'assemble' | 'bundle' | 'install' | 'clean' | 'lint' | 'unitTest';

export interface GradleSelection {
  rootPath: string;
  modulePath: string;
  moduleDirectory?: string;
  variant: string;
  applicationId?: string | null;
  runnable?: boolean;
}

export interface GradleRunResult {
  exitCode: number;
  cancelled: boolean;
}

export function toGradleSelection(resolved: ResolvedSelection): GradleSelection {
  return {
    rootPath: resolved.module.root,
    modulePath: resolved.module.path,
    moduleDirectory: resolved.module.projectDir,
    variant: resolved.variant.name,
    applicationId: resolved.variant.applicationId,
    runnable: resolved.module.runnable,
  };
}

const MODULE_PATH = /^(?::|:[A-Za-z_][A-Za-z0-9_-]*(?::[A-Za-z_][A-Za-z0-9_-]*)*)$/;
const VARIANT_NAME = /^[a-z][A-Za-z0-9]*$/;

export function gradleTaskName(selection: GradleSelection, action: GradleAction): string {
  if (!MODULE_PATH.test(selection.modulePath)) { throw new Error(`Módulo Gradle inválido: ${selection.modulePath}`); }
  if (!VARIANT_NAME.test(selection.variant)) { throw new Error(`Variante Android inválida: ${selection.variant}`); }
  const base = selection.modulePath === ':' ? '' : selection.modulePath;
  if (action === 'clean') { return `${base}:clean`; }
  const variant = `${selection.variant[0].toUpperCase()}${selection.variant.slice(1)}`;
  if (action === 'unitTest') { return `${base}:test${variant}UnitTest`; }
  return `${base}:${action}${variant}`;
}

function stopProcess(pid: number | undefined, force: boolean): void {
  if (!pid) { return; }
  try {
    if (process.platform === 'win32') {
      const args = ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])];
      spawn('taskkill', args, { windowsHide: true });
    } else {
      process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { throw error; }
  }
}

export function runGradle(
  selection: GradleSelection,
  action: GradleAction,
  onOutput: (chunk: string, stream: 'stdout' | 'stderr') => void,
  signal?: AbortSignal,
  extraArgs: readonly string[] = [],
): Promise<GradleRunResult> {
  const task = gradleTaskName(selection, action);
  const wrapper = join(selection.rootPath, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  if (!existsSync(wrapper)) { return Promise.reject(new Error(`Wrapper Gradle não encontrado: ${wrapper}`)); }
  if (signal?.aborted) { return Promise.resolve({ exitCode: 130, cancelled: true }); }

  return new Promise((resolve, reject) => {
    const child = spawn(wrapper, ['--console=plain', task, ...extraArgs], {
      cwd: selection.rootPath,
      env: process.env,
      detached: process.platform !== 'win32',
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let cancelled = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (result?: GradleRunResult, error?: Error) => {
      if (settled) { return; }
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (killTimer) { clearTimeout(killTimer); }
      if (error) { reject(error); } else { resolve(result!); }
    };
    const abort = () => {
      if (settled) { return; }
      cancelled = true;
      stopProcess(child.pid, false);
      killTimer = setTimeout(() => stopProcess(child.pid, true), 3000);
      killTimer.unref();
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => onOutput(chunk, 'stdout'));
    child.stderr.on('data', (chunk: string) => onOutput(chunk, 'stderr'));
    child.once('error', error => finish(undefined, error));
    child.once('close', code => finish({ exitCode: cancelled ? 130 : code ?? 1, cancelled }));
    if (signal?.aborted) { abort(); }
  });
}
