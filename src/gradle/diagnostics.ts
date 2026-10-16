import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export interface BuildIssue {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: 'error' | 'warning' | 'information';
  /** Exclusive end column on `line`, when the tool reports a span. */
  endColumn?: number;
  /** Check identifier, e.g. a lint issue id, with its documentation URL. */
  code?: string;
  codeUrl?: string;
}

const SOURCE = String.raw`(.+?\.(?:kt|kts|java|xml))`;
const patterns = [
  new RegExp(`^e: ${SOURCE}:\\s*\\((\\d+),\\s*(\\d+)\\):\\s*(.+)$`),
  new RegExp(`^e: ${SOURCE}:(\\d+):(\\d+):\\s*(.+)$`),
  new RegExp(`^${SOURCE}:(\\d+):(\\d+):\\s*(error|warning):\\s*(.+)$`),
  new RegExp(`^${SOURCE}:(\\d+):\\s*(?:AAPT:\\s*)?(error|warning):\\s*(.+)$`),
];

function normalizeFile(root: string, value: string): string {
  let path = value;
  if (value.startsWith('file://')) {
    try { path = fileURLToPath(value); }
    catch { return resolve(root, value); }
  }
  // resolve also normalizes absolute paths, e.g. `C:\dir/sub/File.java` printed by Gradle on Windows.
  return resolve(root, path);
}

export function parseBuildIssue(root: string, rawLine: string): BuildIssue | undefined {
  const line = rawLine.replace(/\x1b\[[0-9;]*m/g, '').trim();
  let match = patterns[0].exec(line) ?? patterns[1].exec(line);
  if (match) {
    const file = match[1];
    const row = Number(match[2]);
    const column = Number(match[3]);
    if (!Number.isInteger(row) || row < 1 || !Number.isInteger(column) || column < 1) { return undefined; }
    return { file: normalizeFile(root, file), line: row, column, message: match[4], severity: 'error' };
  }
  match = patterns[2].exec(line);
  if (match) {
    const row = Number(match[2]);
    const column = Number(match[3]);
    if (row < 1 || column < 1) { return undefined; }
    return { file: normalizeFile(root, match[1]), line: row, column, severity: match[4] as 'error' | 'warning', message: match[5] };
  }
  match = patterns[3].exec(line);
  if (match) {
    const row = Number(match[2]);
    if (row < 1) { return undefined; }
    return { file: normalizeFile(root, match[1]), line: row, column: 1, severity: match[3] as 'error' | 'warning', message: match[4] };
  }
  return undefined;
}

export class BuildIssueCollector {
  private buffer = '';
  private readonly seen = new Set<string>();

  constructor(private readonly root: string, private readonly emit: (issue: BuildIssue) => void) {}

  write(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      this.parse(this.buffer.slice(0, newline).replace(/\r$/, ''));
      this.buffer = this.buffer.slice(newline + 1);
    }
    if (this.buffer.length > 64 * 1024) { this.buffer = this.buffer.slice(-64 * 1024); }
  }

  flush(): void {
    if (this.buffer) { this.parse(this.buffer); }
    this.buffer = '';
  }

  private parse(line: string): void {
    const issue = parseBuildIssue(this.root, line);
    if (!issue) { return; }
    const key = `${issue.file}:${issue.line}:${issue.column}:${issue.message}`;
    if (this.seen.has(key)) { return; }
    this.seen.add(key);
    this.emit(issue);
  }
}
