import { resolve } from 'node:path';
import { BuildIssue } from './diagnostics';
import type { GradleSelection } from './runner';

export function buildTargetKey(target: Pick<GradleSelection, 'rootPath' | 'modulePath' | 'variant'>): string {
  return JSON.stringify([resolve(target.rootPath), target.modulePath, target.variant]);
}

export function normalizeDiagnosticMessage(message: string): string {
  return message.trim().replace(/\s+/g, ' ');
}

/** A diagnostic from another source, with zero-based position as VS Code reports it. */
export interface ExternalDiagnostic {
  line: number;
  character: number;
  message: string;
}

/** Drops build issues that a language server already reports at the same position with the same text. */
export function hideDuplicatedIssues(issues: readonly BuildIssue[], external: readonly ExternalDiagnostic[]): BuildIssue[] {
  return issues.filter(issue => !external.some(item =>
    item.line === issue.line - 1 && item.character === issue.column - 1 &&
    normalizeDiagnosticMessage(item.message) === normalizeDiagnosticMessage(issue.message)));
}

export interface BuildDiagnosticSink {
  clear(): void;
  set(file: string, issues: readonly BuildIssue[]): void;
}

/** Publishes build issues not already reported by other sources, skipping writes that would change nothing. */
export function dedupedDiagnosticPublisher(
  sink: BuildDiagnosticSink, externalFor: (file: string) => readonly ExternalDiagnostic[],
): BuildDiagnosticPublisher {
  const published = new Map<string, string>();
  return {
    clear: () => { published.clear(); sink.clear(); },
    replace: (file, issues) => {
      const visible = hideDuplicatedIssues(issues, externalFor(file));
      const fingerprint = JSON.stringify(visible.map(issue => [issue.line, issue.column, issue.severity, issue.message]));
      if (published.get(file) === fingerprint) { return; }
      published.set(file, fingerprint);
      sink.set(file, visible);
    },
  };
}

export interface BuildDiagnosticPublisher {
  clear(): void;
  replace(file: string, issues: readonly BuildIssue[]): void;
}

export interface BuildDiagnosticSession {
  add(issue: BuildIssue): void;
  finish(cancelled: boolean): void;
}

/** Owns only Gradle diagnostics. Language servers and XML keep their own collections. */
export class BuildDiagnosticCoordinator {
  private target: string | undefined;
  private generation = 0;
  private readonly byFile = new Map<string, BuildIssue[]>();
  private readonly seen = new Set<string>();
  private readonly edited = new Set<string>();
  private acceptsFile: (file: string) => boolean = () => true;

  constructor(private readonly publisher: BuildDiagnosticPublisher) {}

  selectTarget(target: string | undefined, acceptsFile: (file: string) => boolean = () => true): void {
    this.acceptsFile = acceptsFile;
    if (target === this.target) { return; }
    this.target = target;
    this.reset();
  }

  begin(target: string): BuildDiagnosticSession {
    if (target !== this.target) { return { add() {}, finish() {} }; }
    this.reset();
    const generation = this.generation;
    const current = () => generation === this.generation && target === this.target;
    return {
      add: issue => {
        if (!current()) { return; }
        const file = resolve(issue.file);
        if (this.edited.has(file) || !this.acceptsFile(file)) { return; }
        const key = JSON.stringify([process.platform === 'win32' ? file.toLowerCase() : file,
          issue.line, issue.column, issue.severity, normalizeDiagnosticMessage(issue.message)]);
        if (this.seen.has(key)) { return; }
        this.seen.add(key);
        const issues = this.byFile.get(file) ?? [];
        issues.push({ ...issue, file });
        this.byFile.set(file, issues);
        this.publisher.replace(file, issues);
      },
      finish: cancelled => { if (cancelled && current()) { this.reset(); } },
    };
  }

  /** A build result for an edited document is stale, including late output from the same build. */
  invalidateFile(file: string): void {
    const normalized = resolve(file);
    this.edited.add(normalized);
    if (this.byFile.delete(normalized)) { this.publisher.replace(normalized, []); }
  }

  republish(file: string): void {
    const normalized = resolve(file);
    const issues = this.byFile.get(normalized);
    if (issues) { this.publisher.replace(normalized, issues); }
  }

  private reset(): void {
    this.generation++;
    this.byFile.clear();
    this.seen.clear();
    this.edited.clear();
    this.publisher.clear();
  }
}
