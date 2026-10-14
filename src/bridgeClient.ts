import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const PROTOCOL_VERSION = 1;

export interface DeviceInfo {
  serial: string;
  state: string;
  product: string | null;
  model: string | null;
  device: string | null;
  transportId: number | null;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
  removeAbort?: () => void;
}

interface WireMessage {
  version?: number;
  type?: string;
  id?: string;
  event?: string;
  result?: unknown;
  error?: { code?: string; message?: string };
}

export class BridgeClient {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 0;
  private stdoutBuffer = '';
  private closed = false;
  private readonly eventListeners = new Set<(name: string, data: unknown, id?: string) => void>();
  private killTimer: NodeJS.Timeout | undefined;

  get isClosed(): boolean { return this.closed; }

  private constructor(java: string, libDirectory: string, host: string, port: number, private readonly log: (message: string) => void) {
    const jars = readdirSync(libDirectory).filter(name => name.endsWith('.jar'));
    if (!jars.some(name => /^bridge(?:-.*)?\.jar$/.test(name))) {
      throw new Error(`Serviço Kotlin não compilado em ${libDirectory}. Execute npm run build:bridge.`);
    }
    this.process = spawn(java, ['-cp', join(libDirectory, '*'), 'io.github.desodre.androidvscodesupport.MainKt', host, String(port)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', (chunk: string) => this.readStdout(chunk));
    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', (chunk: string) => this.log(chunk.trimEnd()));
    this.process.on('error', error => this.fail(error));
    this.process.on('exit', (code, signal) => {
      if (this.killTimer) { clearTimeout(this.killTimer); }
      this.fail(new Error(`Serviço Kotlin encerrado (${signal ?? code ?? 'desconhecido'}). Consulte a saída Android.`));
    });
  }

  static async start(java: string, libDirectory: string, host: string, port: number, log: (message: string) => void): Promise<BridgeClient> {
    const client = new BridgeClient(java, libDirectory, host, port, log);
    try {
      const hello = await client.request<{ protocolVersion: number }>('bridge.hello');
      if (hello.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`Versão incompatível do serviço Kotlin: ${hello.protocolVersion}.`);
      }
      return client;
    } catch (error) {
      client.dispose();
      throw error;
    }
  }

  onEvent(listener: (name: string, data: unknown, id?: string) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  request<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal, device?: string, timeoutMs = 15000, onRequestId?: (id: string) => void): Promise<T> {
    if (this.closed) { return Promise.reject(new Error('Serviço Kotlin encerrado.')); }
    if (signal?.aborted) { return Promise.reject(new Error('Operação cancelada.')); }
    const id = String(++this.nextId);
    onRequestId?.(id);
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.cancel(id);
        reject(new Error(`Tempo esgotado: ${method}.`));
      }, timeoutMs) : undefined;
      const onAbort = () => {
        this.cancel(id);
        reject(new Error('Operação cancelada.'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer, removeAbort: () => signal?.removeEventListener('abort', onAbort) });
      this.send({ version: PROTOCOL_VERSION, type: 'request', id, method, device, params });
    });
  }

  /** A long running request; stopping it cancels the Kotlin coroutine and closes its ADB connection. */
  startStream(method: string, params: Record<string, unknown>, device: string | undefined,
    listener: (name: string, data: unknown) => void): { stop(): void; done: Promise<void> } {
    const controller = new AbortController();
    let requestId: string | undefined;
    const unsubscribe = this.onEvent((name, data, id) => {
      if (id === requestId) { listener(name, data); }
    });
    const done = this.request<void>(method, params, controller.signal, device, 0, id => { requestId = id; })
      .finally(unsubscribe);
    return { stop: () => { unsubscribe(); controller.abort(); }, done };
  }

  private cancel(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) { return; }
    this.pending.delete(id);
    if (pending.timer) { clearTimeout(pending.timer); }
    pending.removeAbort?.();
    this.send({ version: PROTOCOL_VERSION, type: 'cancel', id });
  }

  private send(message: object): void {
    if (!this.closed && this.process.stdin.writable) {
      this.process.stdin.write(`${JSON.stringify(message)}\n`);
    }
  }

  private readStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (this.stdoutBuffer.length > 1024 * 1024) {
      this.fail(new Error('Resposta do serviço Kotlin excedeu 1 MiB.'));
      this.dispose();
      return;
    }
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      try { this.receive(JSON.parse(line) as WireMessage); }
      catch (error) {
        this.fail(new Error(`Resposta inválida do serviço Kotlin: ${String(error)}`));
        this.dispose();
        return;
      }
    }
  }

  private receive(message: WireMessage): void {
    if (message.version !== PROTOCOL_VERSION) { throw new Error('Versão do protocolo incompatível.'); }
    if (message.type === 'event' && message.event) {
      for (const listener of this.eventListeners) { listener(message.event, message.result, message.id); }
      return;
    }
    if (message.type !== 'response' || !message.id) { throw new Error('Mensagem do serviço Kotlin desconhecida.'); }
    const pending = this.pending.get(message.id);
    if (!pending) { return; }
    this.pending.delete(message.id);
    if (pending.timer) { clearTimeout(pending.timer); }
    pending.removeAbort?.();
    if (message.error) {
      pending.reject(new Error(`${message.error.code ?? 'ERROR'}: ${message.error.message ?? 'Falha desconhecida.'}`));
    } else {
      pending.resolve(message.result);
    }
  }

  private fail(error: Error): void {
    if (this.closed) { return; }
    this.closed = true;
    this.log(error.message);
    for (const pending of this.pending.values()) {
      if (pending.timer) { clearTimeout(pending.timer); }
      pending.removeAbort?.();
      pending.reject(error);
    }
    this.pending.clear();
  }

  dispose(): void {
    this.fail(new Error('Serviço Kotlin encerrado pela extensão.'));
    this.process.stdin.end();
    if (this.process.exitCode === null) {
      this.process.kill('SIGTERM');
      this.killTimer = setTimeout(() => {
        if (this.process.exitCode === null) { this.process.kill('SIGKILL'); }
      }, 2000);
      this.killTimer.unref();
    }
  }
}
