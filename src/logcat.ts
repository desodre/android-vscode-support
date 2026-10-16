import type { BridgeStream } from './bridgeManager';

const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

export type LogcatFilterKind = 'all' | 'package' | 'pid';

export interface LogcatFilter {
  label: string;
  params: Record<string, unknown>;
}

export const LOGCAT_FILTER_LABELS: Record<LogcatFilterKind, string> = {
  all: 'Todos os processos',
  package: 'Aplicativo (ID do pacote)',
  pid: 'Processo (PID)',
};

export function validatePackageName(value: string): string | undefined {
  return PACKAGE_NAME.test(value) ? undefined : 'Informe um ID de pacote válido.';
}

export function validateProcessId(value: string): string | undefined {
  return /^[1-9]\d*$/.test(value) ? undefined : 'Informe um PID positivo.';
}

/** Builds the `logcat.stream` parameters; `value` is the package name or PID for the filtered kinds. */
export function logcatFilter(kind: LogcatFilterKind, value?: string): LogcatFilter {
  const label = LOGCAT_FILTER_LABELS[kind];
  if (kind === 'all') { return { label, params: {} }; }
  const text = value ?? '';
  const problem = kind === 'package' ? validatePackageName(text) : validateProcessId(text);
  if (problem) { throw new Error(problem); }
  return { label, params: kind === 'package' ? { packageName: text } : { processId: Number(text) } };
}

/** Text for a `logcat.stream` event, or undefined when the event shows nothing. */
export function formatLogcatEvent(event: string, data: unknown): string | undefined {
  if (event === 'logcat.entry') {
    return (data as { rawLine?: string }).rawLine || undefined;
  }
  if (event === 'logcat.started') {
    const ids = (data as { processIds?: number[] }).processIds;
    return ids?.length ? `PIDs filtrados: ${ids.join(', ')}` : undefined;
  }
  if (event === 'logcat.filterChanged') {
    const ids = (data as { processIds?: number[] }).processIds;
    return ids?.length ? `Filtro atualizado para PIDs: ${ids.join(', ')}` : 'Aguardando o aplicativo iniciar…';
  }
  return undefined;
}

export type LogcatLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/** Maps the adb-utils priority (`verbose`, `debug`, …, or its letter) to an output channel level. */
export function logcatLevel(priority: unknown): LogcatLevel {
  const first = typeof priority === 'string' ? priority.trim().charAt(0).toLowerCase() : '';
  switch (first) {
    case 'v': return 'trace';
    case 'd': return 'debug';
    case 'w': return 'warn';
    case 'e': case 'f': case 'a': return 'error';
    default: return 'info';
  }
}

export interface LogcatSink {
  clear(): void;
  /** Session messages: header, PID filter changes. */
  appendLine(line: string): void;
  /** A device log entry at the level of its priority. */
  entry(level: LogcatLevel, line: string): void;
  show(preserveFocus: boolean): void;
  /** Optional note printed after the header, e.g. levels hidden by the channel. */
  hint?(): string | undefined;
}

export type LogcatOnRun = 'ask' | 'always' | 'never';
export type LogcatOnRunAnswer = 'open' | 'always' | 'never' | undefined;

/**
 * Whether to open the app's Logcat after Run/Debug. `ask` prompts; answering `always` or `never`
 * is remembered through `remember`.
 */
export async function shouldOpenLogcatOnRun(
  setting: unknown, ask: () => Promise<LogcatOnRunAnswer>, remember: (value: LogcatOnRun) => Promise<void>,
): Promise<boolean> {
  if (setting === 'always') { return true; }
  if (setting === 'never') { return false; }
  const answer = await ask();
  if (answer === 'always' || answer === 'never') { await remember(answer); }
  return answer === 'open' || answer === 'always';
}

export type LogcatStreamStarter = (params: Record<string, unknown>, serial: string,
  listener: (event: string, data: unknown) => void) => Promise<BridgeStream>;

/** One logcat stream at a time; output of a replaced stream never reaches the sink. */
export class LogcatSession {
  private stream: BridgeStream | undefined;
  private serial: string | undefined;

  constructor(
    private readonly startStream: LogcatStreamStarter,
    private readonly sink: LogcatSink,
    private readonly onFailure: (message: string) => void,
  ) {}

  get activeSerial(): string | undefined { return this.serial; }

  async start(serial: string, filter: LogcatFilter): Promise<void> {
    this.stop();
    this.sink.clear();
    this.sink.appendLine(`Logcat: ${serial} · ${filter.label}`);
    const hint = this.sink.hint?.();
    if (hint) { this.sink.appendLine(hint); }
    this.sink.show(true);
    // Stopping a stream unsubscribes its listener, so a replaced stream writes nothing further.
    const current = await this.startStream(filter.params, serial, (event, data) => {
      const line = formatLogcatEvent(event, data);
      if (line === undefined) { return; }
      if (event === 'logcat.entry') { this.sink.entry(logcatLevel((data as { priority?: unknown }).priority), line); }
      else { this.sink.appendLine(line); }
    });
    this.stream = current;
    this.serial = serial;
    void current.done.catch(error => {
      if (this.stream === current) { this.onFailure(error instanceof Error ? error.message : String(error)); }
    }).finally(() => {
      if (this.stream === current) { this.stream = undefined; this.serial = undefined; }
    });
  }

  stop(): void {
    this.stream?.stop();
    this.stream = undefined;
    this.serial = undefined;
  }

  /** The stream belongs to one device; selecting another device ends it. */
  stopIfSerialChanged(serial: string | undefined): void {
    if (this.serial && this.serial !== serial) { this.stop(); }
  }
}

/**
 * Asks for the filter with VS Code pickers; `defaultPackage` (the selected app) prefills the package filter.
 * The `vscode` module is loaded only when invoked.
 */
export async function pickLogcatFilter(defaultPackage?: string): Promise<LogcatFilter | undefined> {
  const vscode = require('vscode') as typeof import('vscode');
  const kinds: LogcatFilterKind[] = ['all', 'package', 'pid'];
  const suggested = defaultPackage && !validatePackageName(defaultPackage) ? defaultPackage : undefined;
  const choice = await vscode.window.showQuickPick(kinds.map(kind => ({
    label: LOGCAT_FILTER_LABELS[kind], value: kind,
    description: kind === 'package' ? suggested : undefined,
  })), { placeHolder: 'Filtrar o Logcat' });
  if (!choice) { return undefined; }
  if (choice.value === 'all') { return logcatFilter('all'); }
  const value = choice.value === 'package'
    ? await vscode.window.showInputBox({ prompt: 'ID do pacote Android em execução', placeHolder: 'com.exemplo.app',
      value: suggested, validateInput: validatePackageName })
    : await vscode.window.showInputBox({ prompt: 'PID do processo Android', validateInput: validateProcessId });
  return value ? logcatFilter(choice.value, value) : undefined;
}
