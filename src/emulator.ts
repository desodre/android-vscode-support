import { spawn, execFile } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

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
  if (signal?.aborted) { return Promise.reject(new Error('Inicialização do emulador cancelada.')); }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new Error('Inicialização do emulador cancelada.'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
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
): Promise<string> {
  const available = await listAvds(sdk, signal, emulatorPath);
  if (!available.includes(name)) { throw new Error(`AVD não encontrado: ${name}.`); }
  const port = await chooseEmulatorPort(activeSerials);
  const serial = `emulator-${port}`;
  const logDirectory = mkdtempSync(join(tmpdir(), 'android-vscode-emulator-'));
  const logFile = join(logDirectory, 'stderr.log');
  const logFd = openSync(logFile, 'w');
  const child = spawn(emulatorBinary(sdk, emulatorPath), ['-avd', name, '-port', String(port)], {
    detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', logFd], windowsHide: true,
  });
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
    } catch { child.kill(); }
  };
  const stop = async () => {
    if (!child.pid || exited) { return; }
    kill(false);
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 3_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    if (!exited) { kill(true); }
  };
  try {
    await runAdb(adb, ['start-server'], signal);
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (signal?.aborted) { throw new Error('Inicialização do emulador cancelada.'); }
      if (exited) { throw new Error(`Emulador encerrou (${exited}). ${logTail()}`); }
      try {
        const state = await runAdb(adb, ['-s', serial, 'get-state'], signal);
        if (state === 'device') {
          const boot = await runAdb(adb, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], signal);
          if (boot === '1') {
            child.unref();
            return serial;
          }
        }
      } catch (error) {
        if (signal?.aborted) { throw error; }
      }
      await delay(1_000, signal);
    }
    throw new Error(`Tempo esgotado ao iniciar ${name}. ${logTail()}`);
  } catch (error) {
    await stop();
    throw error;
  } finally {
    try { rmSync(logDirectory, { recursive: true, force: true }); }
    catch { /* Windows may retain the log until the emulator exits. */ }
  }
}
