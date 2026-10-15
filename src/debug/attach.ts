import { randomUUID } from 'node:crypto';
import { createConnection, createServer } from 'node:net';

const HANDSHAKE = Buffer.from('JDWP-Handshake', 'ascii');
const SESSION_KEY = '__androidSupportDebugSession';

export interface DebugBridge {
  request<T>(method: string, params?: Record<string, unknown>, signal?: AbortSignal, serial?: string): Promise<T>;
}

export interface AttachOptions {
  serial: string;
  pid: number;
  applicationId: string;
  adapter: 'intellij_jvm' | 'java';
  rootPath: string;
  /** Nome do projeto importado pelo Java Language Server para o módulo Gradle selecionado. */
  projectName?: string;
  /** Diretórios de código da variante selecionada, usados pelo Debugger for Java. */
  sourcePaths?: string[];
}

export type DebugConfiguration = Record<string, unknown>;

/** Obtains an unused local port; adb-utils creates the forward with noRebind. */
export function chooseLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => error ? reject(error) : port > 0 ? resolve(port) : reject(new Error('Porta local inválida.')));
    });
  });
}

/** Confirms that the forwarded endpoint speaks JDWP before invoking a DAP adapter. */
export function verifyJdwp(port: number, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    let received = Buffer.alloc(0);
    const finish = (error?: Error) => {
      if (settled) { return; }
      settled = true;
      socket.destroy();
      error ? reject(error) : resolve();
    };
    socket.setTimeout(timeoutMs, () => finish(new Error('O processo não respondeu ao handshake JDWP.')));
    socket.once('error', error => finish(error));
    socket.once('close', () => finish(new Error('O processo fechou a conexão JDWP.')));
    socket.once('connect', () => socket.write(HANDSHAKE));
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= HANDSHAKE.length) {
        finish(received.subarray(0, HANDSHAKE.length).equals(HANDSHAKE)
          ? undefined : new Error('Resposta JDWP inválida para o PID selecionado.'));
      }
    });
  });
}

/** Waits for a freshly launched package to acquire a PID before attaching. */
export async function waitForProcess(
  bridge: DebugBridge, serial: string, applicationId: string, signal?: AbortSignal,
  timeoutMs = 30_000, pollMs = 500,
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (signal?.aborted) { throw new Error('Espera pelo processo Android cancelada.'); }
    const response = await bridge.request<{ pids: number[] }>(
      'debug.findProcess', { packageName: applicationId }, signal, serial,
    );
    const pids = [...new Set(response.pids)].filter(pid => Number.isSafeInteger(pid) && pid > 0);
    if (pids.length > 0) { return pids; }
    const remaining = deadline - Date.now();
    if (remaining <= 0) { throw new Error(`Tempo esgotado aguardando ${applicationId} iniciar em ${serial}.`); }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, Math.min(pollMs, remaining));
      const cancel = () => { clearTimeout(timer); reject(new Error('Espera pelo processo Android cancelada.')); };
      signal?.addEventListener('abort', cancel, { once: true });
    });
  }
}

interface Forward { bridge: DebugBridge; serial: string; localPort: number }

/** Owns only forwards created for Android debug sessions started by this extension. */
export class AndroidDebugAttacher {
  private readonly forwards = new Map<string, Forward>();
  private readonly cleanups = new Map<string, Promise<void>>();

  constructor(
    private readonly startDebugging: (configuration: DebugConfiguration, options: AttachOptions) => Promise<boolean>,
    private readonly allocatePort = chooseLocalPort,
    private readonly probe = verifyJdwp,
  ) {}

  async attach(bridge: DebugBridge, options: AttachOptions): Promise<boolean> {
    if (!Number.isSafeInteger(options.pid) || options.pid <= 0) { throw new Error('PID Android inválido.'); }
    if (!options.serial || !options.applicationId) { throw new Error('Dispositivo e aplicativo são obrigatórios.'); }
    const localPort = await this.allocatePort();
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) { throw new Error('Porta local inválida.'); }
    await bridge.request('debug.forwardJdwp', { pid: options.pid, localPort }, undefined, options.serial);
    const sessionId = randomUUID();
    this.forwards.set(sessionId, { bridge, serial: options.serial, localPort });
    try {
      await this.probe(localPort);
      const started = await this.startDebugging({
        type: options.adapter, request: 'attach', hostName: '127.0.0.1', port: localPort,
        name: `Android: ${options.applicationId} (${options.serial}, PID ${options.pid})`,
        ...(options.adapter === 'java' ? {
          projectName: options.projectName,
          sourcePaths: options.sourcePaths,
        } : {}),
        [SESSION_KEY]: sessionId,
      }, options);
      if (!started) { await this.cleanup(sessionId); }
      return started;
    } catch (error) {
      await this.cleanup(sessionId).catch(() => undefined);
      throw error;
    }
  }

  async onDidTerminate(configuration: DebugConfiguration): Promise<void> {
    const id = configuration[SESSION_KEY];
    if (typeof id === 'string') { await this.cleanup(id); }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.forwards.keys()].map(id => this.cleanup(id)));
  }

  private async cleanup(id: string): Promise<void> {
    const pending = this.cleanups.get(id);
    if (pending) { return pending; }
    const forward = this.forwards.get(id);
    if (!forward) { return; }
    const operation = forward.bridge.request('debug.removeForward', { localPort: forward.localPort }, undefined, forward.serial)
      .then(() => { this.forwards.delete(id); })
      .finally(() => { this.cleanups.delete(id); });
    this.cleanups.set(id, operation);
    await operation;
  }
}
