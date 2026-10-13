import * as vscode from 'vscode';
import { BuiltArtifact, findBuiltArtifacts } from './artifacts';
import { BuildIssue, BuildIssueCollector } from './diagnostics';
import { GradleAction, GradleSelection, gradleTaskName, runGradle } from './runner';

const TASK_TYPE = 'androidGradle';

interface AndroidTaskDefinition extends vscode.TaskDefinition {
  action: GradleAction;
  module: string;
  variant: string;
  rootPath: string;
}

class GradleTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;
  private readonly controller = new AbortController();
  private finished = false;

  constructor(
    private readonly selection: GradleSelection,
    private readonly action: GradleAction,
    private readonly diagnostics: vscode.DiagnosticCollection,
    private readonly onBuilt?: (artifacts: BuiltArtifact[]) => void,
  ) {}

  open(): void {
    const task = gradleTaskName(this.selection, this.action);
    const issues = new Map<string, vscode.Diagnostic[]>();
    const addIssue = (issue: BuildIssue) => {
      const uri = vscode.Uri.file(issue.file);
      const range = new vscode.Range(issue.line - 1, issue.column - 1, issue.line - 1, issue.column);
      const diagnostic = new vscode.Diagnostic(range, issue.message,
        issue.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
      diagnostic.source = 'Android Gradle';
      const list = issues.get(uri.toString()) ?? [];
      list.push(diagnostic);
      issues.set(uri.toString(), list);
      this.diagnostics.set(uri, list);
    };
    const collectors = {
      stdout: new BuildIssueCollector(this.selection.rootPath, addIssue),
      stderr: new BuildIssueCollector(this.selection.rootPath, addIssue),
    };
    this.diagnostics.clear();
    this.writeEmitter.fire(`Executando ${task}\r\n`);
    void runGradle(this.selection, this.action, (chunk, stream) => {
      this.writeEmitter.fire(chunk.replace(/\r?\n/g, '\r\n'));
      collectors[stream].write(chunk);
    }, this.controller.signal).then(result => {
      collectors.stdout.flush();
      collectors.stderr.flush();
      if (result.cancelled) { this.writeEmitter.fire('\r\nBuild cancelado.\r\n'); }
      else if (result.exitCode === 0 && (this.action === 'assemble' || this.action === 'bundle')) {
        try {
          const type = this.action === 'bundle' ? 'AAB' : 'APK';
          const artifacts = findBuiltArtifacts(this.selection, this.selection.applicationId ?? null).filter(artifact => artifact.type === type);
          this.onBuilt?.(artifacts);
          if (artifacts.length === 0) { this.writeEmitter.fire('Nenhum APK/AAB encontrado para esta variante.\r\n'); }
          for (const artifact of artifacts) {
            this.writeEmitter.fire(`${artifact.type}: ${artifact.file}${artifact.applicationId ? ` (${artifact.applicationId})` : ''}\r\n`);
          }
        } catch (error) {
          this.writeEmitter.fire(`Falha ao localizar artefatos: ${String(error)}\r\n`);
        }
      }
      this.finish(result.exitCode);
    }, error => {
      this.writeEmitter.fire(`\r\nFalha ao executar Gradle: ${String(error)}\r\n`);
      this.finish(1);
    });
  }

  close(): void { this.controller.abort(); }

  private finish(exitCode: number): void {
    if (this.finished) { return; }
    this.finished = true;
    this.closeEmitter.fire(exitCode);
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }
}

export function createGradleTask(
  selection: GradleSelection,
  action: GradleAction,
  diagnostics: vscode.DiagnosticCollection,
  onBuilt?: (artifacts: BuiltArtifact[]) => void,
): vscode.Task {
  const name = gradleTaskName(selection, action);
  const definition: AndroidTaskDefinition = {
    type: TASK_TYPE, action, module: selection.modulePath, variant: selection.variant, rootPath: selection.rootPath,
  };
  const scope = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(selection.rootPath)) ?? vscode.TaskScope.Workspace;
  const task = new vscode.Task(definition, scope, name, 'Android',
    new vscode.CustomExecution(async () => new GradleTerminal(selection, action, diagnostics, onBuilt)));
  task.group = action === 'assemble' || action === 'bundle' ? vscode.TaskGroup.Build : undefined;
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Shared };
  return task;
}

export function registerGradleTaskProvider(
  getSelection: (refresh: boolean) => Promise<GradleSelection | undefined>,
  diagnostics: vscode.DiagnosticCollection,
  onBuilt?: (artifacts: BuiltArtifact[]) => void,
): vscode.Disposable {
  return vscode.tasks.registerTaskProvider(TASK_TYPE, {
    provideTasks: async () => {
      if (!vscode.workspace.isTrusted) { return []; }
      const selection = await getSelection(false);
      const actions: GradleAction[] = selection?.runnable === false ? ['assemble', 'clean'] : ['assemble', 'bundle', 'install', 'clean'];
      return selection ? actions.map(action =>
        createGradleTask(selection, action, diagnostics, onBuilt)) : [];
    },
    resolveTask: async task => {
      if (!vscode.workspace.isTrusted) { return undefined; }
      const selection = await getSelection(true);
      const definition = task.definition as AndroidTaskDefinition;
      if (!selection || selection.rootPath !== definition.rootPath || selection.modulePath !== definition.module ||
          selection.variant !== definition.variant || !['assemble', 'bundle', 'install', 'clean'].includes(definition.action) ||
          (selection.runnable === false && (definition.action === 'bundle' || definition.action === 'install'))) {
        return undefined;
      }
      return createGradleTask(selection, definition.action, diagnostics, onBuilt);
    },
  });
}
