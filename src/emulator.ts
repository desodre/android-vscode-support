import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { sleep } from './util/abort';

const execFileAsync = promisify(execFile);
const FIRST_CONSOLE_PORT = 5554;
const LAST_CONSOLE_PORT = 5682;

function emulatorBinary(sdk: string, override?: string): string {
  if (override && !isAbsolute(override)) {
    throw new Error('androidSupport.emulatorPath deve ser um caminho absoluto para o executável do emulador.');
  }
  return override || join(sdk, 'emulator', process.platform === 'win32' ? 'emulator.exe' : 'emulator');
}

export async function listAvds(sdk: string, signal?: AbortSignal, emulatorPath?: string): Promise<string[]> {
  const binary = emulatorBinary(sdk, emulatorPath);
  if (!existsSync(binary)) { throw new Error(`Emulador não encontrado em ${binary}. Instale o pacote Android Emulator no SDK.`); }
  const { stdout } = await execFileAsync(binary, ['-list-avds'], { signal, timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 });
  return stdout.split(/\r?\n/).map(name => name.trim()).filter(Boolean);
}

async function portIsFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

export async function chooseEmulatorPort(
  activeSerials: readonly string[],
  isFree: (port: number) => Promise<boolean> = portIsFree,
): Promise<number> {
  const active = new Set(activeSerials);
  for (let port = FIRST_CONSOLE_PORT; port <= LAST_CONSOLE_PORT; port += 2) {
    if (active.has(`emulator-${port}`)) { continue; }
    if (await isFree(port) && await isFree(port + 1)) { return port; }
  }
  throw new Error('Nenhuma porta livre para iniciar o emulador Android.');
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return sleep(ms, signal, 'Inicialização do emulador cancelada.');
}

async function runAdb(adb: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync(adb, args, {
    signal, timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

export async function startAvd(
  sdk: string,
  adb: string,
  name: string,
  activeSerials: readonly string[],
  signal?: AbortSignal,
  emulatorPath?: string,
  timing: { bootTimeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<string> {
  const available = await listAvds(sdk, signal, emulatorPath);
  if (!available.includes(name)) { throw new Error(`AVD não encontrado: ${name}.`); }
  const port = await chooseEmulatorPort(activeSerials);
  const serial = `emulator-${port}`;
  const logDirectory = mkdtempSync(join(tmpdir(), 'android-vscode-emulator-'));
  const logFile = join(logDirectory, 'stderr.log');
  const logFd = openSync(logFile, 'w');
  let child: ChildProcess;
  try {
    child = spawn(emulatorBinary(sdk, emulatorPath), ['-avd', name, '-port', String(port)], {
      detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', logFd], windowsHide: true,
    });
  } catch (error) {
    closeSync(logFd);
    rmSync(logDirectory, { recursive: true, force: true });
    throw error;
  }
  closeSync(logFd);
  let exited: string | undefined;
  child.once('error', error => { exited = error.message; });
  child.once('exit', (code, sig) => { exited = `código ${code ?? sig ?? 'desconhecido'}`; });
  const logTail = () => {
    try { return readFileSync(logFile, 'utf8').slice(-4096).trim(); }
    catch { return ''; }
  };
  const kill = (force: boolean) => {
    if (!child.pid) { return; }
    try {
      if (process.platform === 'win32') { child.kill(force ? 'SIGKILL' : 'SIGTERM'); }
      else { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
    } catch { if (!exited) { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } }
  };
  const groupAlive = () => {
    if (!child.pid) { return false; }
    if (process.platform === 'win32') { return !exited; }
    try { process.kill(-child.pid, 0); return true; }
    catch { return false; }
  };
  const stop = async (): Promise<boolean> => {
    if (!child.pid) { return true; }
    kill(false);
    const deadline = Date.now() + 3_000;
    while (groupAlive() && Date.now() < deadline) { await delay(100); }
    if (groupAlive()) {
      kill(true);
      const forceDeadline = Date.now() + 1_000;
      while (groupAlive() && Date.now() < forceDeadline) { await delay(50); }
    }
    return !groupAlive();
  };
  try {
    try { await runAdb(adb, ['start-server'], signal); }
    catch (error) {
      if (signal?.aborted) { throw new Error('Inicialização do emulador cancelada.'); }
      throw new Error(`Falha ao iniciar o servidor ADB: ${String(error)}`);
    }
    const deadline = Date.now() + (timing.bootTimeoutMs ?? 180_000);
    let lastAdbError = '';
    while (Date.now() < deadline) {
      if (signal?.aborted) { throw new Error('Inicialização do emulador cancelada.'); }
      if (exited) { throw new Error(`Emulador encerrou (${exited}). ${logTail()}`); }
      try {
        const state = await runAdb(adb, ['-s', serial, 'get-state'], signal);
        if (state === 'device') {
          const boot = await runAdb(adb, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], signal);
          if (boot === '1') {
            // A port taken after our availability check must not be mistaken for this process.
            await delay(150, signal);
            if (exited || !groupAlive()) {
              throw new Error(`Emulador encerrou (${exited ?? 'processo ausente'}). ${logTail()}`);
            }
            child.unref();
            return serial;
          }
        }
      } catch (error) {
        if (signal?.aborted) { throw error; }
        if (error instanceof Error && error.message.startsWith('Emulador encerrou (')) { throw error; }
        lastAdbError = String(error);
      }
      await delay(timing.pollIntervalMs ?? 1_000, signal);
    }
    throw new Error(`Tempo esgotado ao iniciar ${name}. ${lastAdbError} ${logTail()}`.trim());
  } catch (error) {
    const stopped = await stop();
    if (!stopped) {
      throw new Error(`Não foi possível encerrar o emulador iniciado em ${serial} após a falha: ${String(error)}`);
    }
    if (signal?.aborted) { throw new Error('Inicialização do emulador cancelada.'); }
    throw error;
  } finally {
    try { rmSync(logDirectory, { recursive: true, force: true }); }
    catch { /* Windows may retain the log until the emulator exits. */ }
  }
}
