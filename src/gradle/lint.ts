import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { BuildIssue } from './diagnostics';
import { GradleSelection, gradleTaskName } from './runner';

export interface LintIssue extends BuildIssue {
  category?: string;
}

export interface LintReport {
  /** Issues with a source location, ready for the Problems panel. */
  issues: LintIssue[];
  /** Issues lint reports without a file (project-level checks). */
  unlocated: Array<{ code: string; severity: BuildIssue['severity']; message: string }>;
}

export interface LintReportFiles {
  xml: string;
  html: string;
}

/** Where AGP writes the reports of `lint<Variant>` (verified with AGP 9.0.1). */
export function lintReportFiles(selection: GradleSelection): LintReportFiles {
  gradleTaskName(selection, 'lint');
  const moduleRoot = selection.moduleDirectory ?? join(selection.rootPath, ...selection.modulePath.slice(1).split(':'));
  const base = join(moduleRoot, 'build', 'reports', `lint-results-${selection.variant}`);
  return { xml: `${base}.xml`, html: `${base}.html` };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (entity, body: string) => {
    if (body.startsWith('#x')) { return String.fromCodePoint(parseInt(body.slice(2), 16)); }
    if (body.startsWith('#')) { return String.fromCodePoint(Number(body.slice(1))); }
    return ENTITIES[body] ?? entity;
  });
}

function attributes(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of text.matchAll(/([A-Za-z][\w-]*)="([^"]*)"/g)) { result[match[1]] = decode(match[2]); }
  return result;
}

function severityOf(value: string | undefined): BuildIssue['severity'] | undefined {
  switch (value) {
    case 'Fatal': case 'Error': return 'error';
    case 'Warning': return 'warning';
    case 'Information': return 'information';
    default: return undefined; // Ignore and unknown values are not shown.
  }
}

/** Parses the XML report (`<issues format="6">`); relative locations resolve against `moduleRoot`. */
export function parseLintReport(xml: string, moduleRoot: string): LintReport {
  const report: LintReport = { issues: [], unlocated: [] };
  for (const match of xml.matchAll(/<issue\b([^>]*?)(?:\/>|>([\s\S]*?)<\/issue>)/g)) {
    const issue = attributes(match[1]);
    const severity = severityOf(issue.severity);
    if (!severity || !issue.id || !issue.message) { continue; }
    const locationMatch = /<location\b([^>]*?)\/?>/.exec(match[2] ?? '');
    const location = locationMatch ? attributes(locationMatch[1]) : undefined;
    if (!location?.file) {
      report.unlocated.push({ code: issue.id, severity, message: issue.message });
      continue;
    }
    const line = Number(location.line ?? 1);
    const column = Number(location.column ?? 1);
    if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) { continue; }
    const marker = /~+/.exec(issue.errorLine2 ?? '');
    report.issues.push({
      file: isAbsolute(location.file) ? location.file : resolve(moduleRoot, location.file),
      line, column, severity, message: issue.message,
      ...(marker && marker.index === column - 1 ? { endColumn: column + marker[0].length } : {}),
      code: issue.id,
      ...(issue.url ? { codeUrl: issue.url } : {}),
      ...(issue.category ? { category: issue.category } : {}),
    });
  }
  return report;
}

/** Modification time of the XML report, or undefined if it does not exist. */
export function lintReportStamp(selection: GradleSelection): number | undefined {
  const { xml } = lintReportFiles(selection);
  return existsSync(xml) ? statSync(xml).mtimeMs : undefined;
}

/**
 * Reads the XML report when it reflects this run: the task succeeded (an up-to-date task keeps a valid report)
 * or the file changed since `stampBefore` (lint fails the task when it finds errors, after writing the report).
 */
export function readLintReport(selection: GradleSelection, stampBefore: number | undefined, succeeded: boolean): LintReport | undefined {
  const { xml } = lintReportFiles(selection);
  const stamp = lintReportStamp(selection);
  if (stamp === undefined || (!succeeded && stamp === stampBefore)) { return undefined; }
  const moduleRoot = selection.moduleDirectory ?? join(selection.rootPath, ...selection.modulePath.slice(1).split(':'));
  return parseLintReport(readFileSync(xml, 'utf8'), moduleRoot);
}

export function formatLintSummary(report: LintReport): string {
  const all = [...report.issues, ...report.unlocated];
  const count = (severity: BuildIssue['severity']) => all.filter(issue => issue.severity === severity).length;
  return `Lint: ${all.length} problema(s) — ${count('error')} erro(s), ${count('warning')} aviso(s), ${count('information')} informação(ões).`;
}
