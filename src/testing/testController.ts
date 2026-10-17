import { sep } from 'node:path';
import * as vscode from 'vscode';
import { GradleSelection, runGradle } from '../gradle/runner';
import { requireTrust } from '../ui/vscodeHelpers';
import { selectedTestLeaves } from './testSelection';
import {
  caseMethodName, DiscoveredClass, discoverUnitTests, failureLine, gradleTestFilter, readUnitTestResults,
} from './unitTests';

export interface UnitTestTarget {
  selection: GradleSelection;
  /** Existing unit test source roots of the selected variant. */
  roots: string[];
}

interface ItemData {
  className: string;
  method?: string;
  file: string;
}

/**
 * Test Explorer for JVM unit tests of the selected module and variant. Runs `test<Variant>UnitTest` with
 * `--tests` filters and maps the JUnit XML reports back to the items.
 */
export class AndroidUnitTestController implements vscode.Disposable {
  private readonly controller = vscode.tests.createTestController('androidUnitTests', 'Android: testes unitários');
  private readonly data = new WeakMap<vscode.TestItem, ItemData>();
  private target: UnitTestTarget | undefined;

  constructor(private readonly resolveTarget: () => UnitTestTarget | undefined) {
    this.controller.refreshHandler = () => this.refresh();
    this.controller.createRunProfile('Executar', vscode.TestRunProfileKind.Run, (request, token) => this.run(request, token), true);
  }

  /** Rediscovers tests; called when the selection changes or a test source is saved. */
  refresh(): void {
    this.target = this.resolveTarget();
    if (!this.target || this.target.roots.length === 0) { this.controller.items.replace([]); return; }
    const { selection, roots } = this.target;
    const root = this.controller.createTestItem(`${selection.rootPath}|${selection.modulePath}|${selection.variant}`,
      `${selection.modulePath} [${selection.variant}]`);
    root.children.replace(discoverUnitTests(roots).map(discovered => this.classItem(discovered)));
    this.controller.items.replace([root]);
  }

  /** Whether `file` lies in a unit test source root of the current target. */
  isTestSource(file: string): boolean {
    return !!this.target?.roots.some(root => file.startsWith(root + sep));
  }

  dispose(): void { this.controller.dispose(); }

  private classItem(discovered: DiscoveredClass): vscode.TestItem {
    const uri = vscode.Uri.file(discovered.file);
    const item = this.controller.createTestItem(discovered.name, discovered.name.split('.').pop() ?? discovered.name, uri);
    item.description = discovered.name;
    item.range = new vscode.Range(discovered.line, 0, discovered.line, 0);
    this.data.set(item, { className: discovered.name, file: discovered.file });
    item.children.replace(discovered.methods.map(method => {
      const child = this.controller.createTestItem(`${discovered.name}#${method.name}`, method.name, uri);
      child.range = new vscode.Range(method.line, 0, method.line, 0);
      this.data.set(child, { className: discovered.name, method: method.name, file: discovered.file });
      return child;
    }));
    return item;
  }

  private async run(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
    const run = this.controller.createTestRun(request);
    try {
      requireTrust('executar testes');
      const target = this.target;
      if (!target) { throw new Error('Selecione um módulo e uma variante Android.'); }
      const roots: vscode.TestItem[] = [];
      this.controller.items.forEach(item => roots.push(item));
      const included = request.include ?? roots;
      const leaves = selectedTestLeaves(included, request.exclude ?? [], item => {
        const children: vscode.TestItem[] = [];
        item.children.forEach(child => children.push(child));
        return children;
      }, item => item.parent);
      if (leaves.length === 0 || token.isCancellationRequested) { return; }
      // Gradle has no negative --tests filter: restrict the run to surviving methods.
      const filterItems = request.exclude?.length ? leaves : included;
      const filters = !request.exclude?.length && included.includes(roots[0]) ? [] : filterItems.flatMap(item => {
        const data = this.data.get(item);
        return data ? ['--tests', gradleTestFilter(data.className, data.method)] : [];
      });
      for (const leaf of leaves) { run.started(leaf); }

      const controller = new AbortController();
      const subscription = token.onCancellationRequested(() => controller.abort());
      const startedAt = Date.now();
      let result;
      try {
        result = await runGradle(target.selection, 'unitTest', chunk => run.appendOutput(chunk.replace(/\r?\n/g, '\r\n')),
          controller.signal, filters);
      } finally { subscription.dispose(); }
      if (result.cancelled) {
        for (const leaf of leaves) { run.skipped(leaf); }
        return;
      }
      const cases = readUnitTestResults(target.selection, startedAt, result.exitCode === 0);
      for (const leaf of leaves) {
        const data = this.data.get(leaf);
        const matching = cases.filter(item => item.className === data?.className && caseMethodName(item.name) === data.method);
        if (!data || matching.length === 0) {
          run.errored(leaf, new vscode.TestMessage(result.exitCode === 0
            ? 'O Gradle não informou resultado para este teste.'
            : 'O build de testes falhou antes de executar este teste. Veja a saída do teste.'));
          continue;
        }
        const duration = matching.reduce((total, item) => total + item.durationMs, 0);
        const failed = matching.find(item => item.outcome === 'failed');
        if (failed) {
          const message = new vscode.TestMessage(failed.details ? `${failed.message}\n\n${failed.details}` : failed.message ?? 'Falha');
          const line = failed.details ? failureLine(failed.details, data.className) : undefined;
          if (line !== undefined) { message.location = new vscode.Location(vscode.Uri.file(data.file), new vscode.Position(line, 0)); }
          run.failed(leaf, message, duration);
        } else if (matching.every(item => item.outcome === 'skipped')) {
          run.skipped(leaf);
        } else {
          run.passed(leaf, duration);
        }
      }
    } catch (error) {
      run.appendOutput(`${error instanceof Error ? error.message : String(error)}\r\n`);
    } finally {
      run.end();
    }
  }
}
