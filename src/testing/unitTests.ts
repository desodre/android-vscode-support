import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { GradleSelection } from '../gradle/runner';
import type { SourceSetLayout } from '../sourceSets';

export interface DiscoveredMethod {
  name: string;
  /** Zero-based line of the declaration. */
  line: number;
}

export interface DiscoveredClass {
  /** Fully qualified name, as reported by JUnit. */
  name: string;
  file: string;
  line: number;
  methods: DiscoveredMethod[];
}

function upperFirst(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1); }

/** Unit test source roots of the variant: `test`, `test<Flavor>`, `test<BuildType>`, `test<Variant>`. */
export function unitTestSourceRoots(layout: Pick<SourceSetLayout, 'moduleDir' | 'sourceSetNames'>): string[] {
  return layout.sourceSetNames
    .map(name => name === 'main' ? 'test' : `test${upperFirst(name)}`)
    .flatMap(sourceSet => ['java', 'kotlin'].map(language => join(layout.moduleDir, 'src', sourceSet, language)))
    .filter(path => { try { return statSync(path).isDirectory(); } catch { return false; } });
}

const CLASS_DECLARATION = /^\s*(?:(?:public|internal|private|protected|abstract|open|final|static|data|sealed)\s+)*class\s+([A-Za-z_$][\w$]*)/;
const KOTLIN_FUNCTION = /\bfun\s+(?:`([^`]+)`|([A-Za-z_$][\w$]*))\s*\(/;
const JAVA_METHOD = /\b(?:void|[\w$<>[\],.?\s]+?)\s+([A-Za-z_$][\w$]*)\s*\(/;
const TEST_ANNOTATION = /@(?:org\.junit\.(?:jupiter\.api\.)?)?Test\b/;

/** Finds JUnit `@Test` methods and the class that declares them. Nested classes are not distinguished. */
export function discoverTests(text: string, file: string): DiscoveredClass[] {
  const kotlin = file.endsWith('.kt');
  const packageName = /^\s*package\s+([\w.]+)/m.exec(text)?.[1];
  const lines = text.split(/\r?\n/);
  const classes: DiscoveredClass[] = [];
  let current: DiscoveredClass | undefined;
  let pendingTest = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\/\/.*$/, '');
    const declared = CLASS_DECLARATION.exec(line);
    if (declared && !TEST_ANNOTATION.test(line)) {
      current = { name: packageName ? `${packageName}.${declared[1]}` : declared[1], file, line: index, methods: [] };
      classes.push(current);
      pendingTest = false;
      continue;
    }
    if (TEST_ANNOTATION.test(line)) { pendingTest = true; }
    if (!pendingTest || !current) { continue; }
    const afterAnnotations = line.replace(/@[\w.]+(?:\([^)]*\))?/g, '');
    const method = kotlin ? KOTLIN_FUNCTION.exec(afterAnnotations) : JAVA_METHOD.exec(afterAnnotations);
    if (method) {
      current.methods.push({ name: kotlin ? method[1] ?? method[2] : method[1], line: index });
      pendingTest = false;
    }
  }
  return classes.filter(item => item.methods.length > 0);
}

function sourceFiles(root: string, depth = 12): string[] {
  if (depth < 0) { return []; }
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) { files.push(...sourceFiles(path, depth - 1)); }
    else if (entry.isFile() && /\.(kt|java)$/.test(entry.name)) { files.push(path); }
  }
  return files;
}

export function discoverUnitTests(roots: readonly string[]): DiscoveredClass[] {
  return roots.flatMap(root => sourceFiles(root)).flatMap(file => discoverTests(readFileSync(file, 'utf8'), file));
}

/**
 * Gradle `--tests` filter. Characters outside identifiers (spaces in Kotlin backtick names) become `*`, which also
 * keeps the argument safe for the Windows shell used to start gradlew.bat.
 */
export function gradleTestFilter(className: string, method?: string): string {
  const safe = (value: string) => value.replace(/[^\w$.]/g, '*');
  return method ? `${safe(className)}.${safe(method)}` : safe(className);
}

export type TestOutcome = 'passed' | 'failed' | 'skipped';

export interface TestCaseResult {
  className: string;
  name: string;
  durationMs: number;
  outcome: TestOutcome;
  message?: string;
  details?: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (entity, body: string) => {
    if (body.startsWith('#x')) { return String.fromCodePoint(parseInt(body.slice(2), 16)); }
    if (body.startsWith('#')) { return String.fromCodePoint(Number(body.slice(1))); }
    return ENTITIES[body] ?? entity;
  });
}

function attribute(text: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(text);
  return match ? decode(match[1]) : undefined;
}

/** Parses a Gradle JUnit XML report (`TEST-<class>.xml`). */
export function parseJUnitXml(xml: string): TestCaseResult[] {
  const results: TestCaseResult[] = [];
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const className = attribute(match[1], 'classname');
    const name = attribute(match[1], 'name');
    if (!className || !name) { continue; }
    const body = match[2] ?? '';
    const failure = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    results.push({
      className, name,
      durationMs: Math.round(Number(attribute(match[1], 'time') ?? 0) * 1000),
      outcome: failure ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed',
      ...(failure ? { message: attribute(failure[2], 'message') ?? attribute(failure[2], 'type') ?? 'Falha', details: decode(failure[3] ?? '').trim() } : {}),
    });
  }
  return results;
}

/** Method a JUnit case refers to: parameterized runs report `name[0]` or `name(Object)`. */
export function caseMethodName(name: string): string {
  return name.replace(/(\[[^\]]*\]|\([^)]*\))$/, '');
}

/** Zero-based line of the deepest frame inside `className` in a failure stack trace. */
export function failureLine(details: string, className: string): number | undefined {
  const escaped = className.replace(/[.$]/g, match => `\\${match}`);
  const frame = new RegExp(`at ${escaped}(?:\\$[\\w$]+)?\\.[^(]+\\([^:)]+:(\\d+)\\)`).exec(details);
  return frame ? Number(frame[1]) - 1 : undefined;
}

export function unitTestResultsDirectory(selection: GradleSelection): string {
  const moduleRoot = selection.moduleDirectory ?? join(selection.rootPath, ...selection.modulePath.slice(1).split(':'));
  const variant = `${selection.variant[0].toUpperCase()}${selection.variant.slice(1)}`;
  return join(moduleRoot, 'build', 'test-results', `test${variant}UnitTest`);
}

/**
 * Results of a run that started at `startedAt` (ms). Gradle rewrites reports of executed tests; when the task fails
 * before running them (for example, a compile error), older reports are ignored. A successful up-to-date task keeps
 * reports that still describe the current code.
 */
export function readUnitTestResults(selection: GradleSelection, startedAt: number, succeeded: boolean): TestCaseResult[] {
  const directory = unitTestResultsDirectory(selection);
  if (!existsSync(directory)) { return []; }
  return readdirSync(directory)
    .filter(name => /^TEST-.*\.xml$/.test(name))
    .map(name => join(directory, name))
    .filter(file => succeeded || statSync(file).mtimeMs + 1000 >= startedAt)
    .flatMap(file => parseJUnitXml(readFileSync(file, 'utf8')));
}
