import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BuildIssue } from '../gradle/diagnostics';
import { BuildDiagnosticCoordinator } from '../gradle/diagnosticCoordinator';

function setup() {
  const visible = new Map<string, readonly BuildIssue[]>();
  const coordinator = new BuildDiagnosticCoordinator({
    clear: () => visible.clear(),
    replace: (file, issues) => { if (issues.length) { visible.set(file, [...issues]); } else { visible.delete(file); } },
  });
  const issue = (file: string, message = 'Unresolved reference'): BuildIssue =>
    ({ file, line: 3, column: 2, severity: 'error', message });
  return { coordinator, visible, issue };
}

test('troca de variante invalida builds antigos e diagnósticos já mostrados', () => {
  const { coordinator, visible, issue } = setup();
  coordinator.selectTarget('root::app::freeDebug');
  const old = coordinator.begin('root::app::freeDebug');
  old.add(issue('/project/src/free/Main.kt'));
  assert.equal(visible.size, 1);
  coordinator.selectTarget('root::app::paidDebug');
  old.add(issue('/project/src/free/Late.kt'));
  assert.equal(visible.size, 0);
  const next = coordinator.begin('root::app::paidDebug');
  next.add(issue('/project/src/paid/Main.kt'));
  assert.deepEqual([...visible.keys()], ['/project/src/paid/Main.kt']);
});

test('build mais recente vence e stdout/stderr duplicados aparecem uma vez', () => {
  const { coordinator, visible, issue } = setup();
  coordinator.selectTarget('target');
  const old = coordinator.begin('target');
  const current = coordinator.begin('target');
  old.add(issue('/project/Foo.kt', 'obsolete'));
  current.add(issue('/project/Foo.kt'));
  current.add(issue('/project/Foo.kt', '  Unresolved   reference '));
  assert.equal(visible.get('/project/Foo.kt')?.length, 1);
});

test('edição e cancelamento removem diagnósticos e bloqueiam saída tardia', () => {
  const { coordinator, visible, issue } = setup();
  coordinator.selectTarget('target');
  const session = coordinator.begin('target');
  session.add(issue('/project/Foo.kt'));
  coordinator.invalidateFile('/project/Foo.kt');
  session.add(issue('/project/Foo.kt', 'late'));
  assert.equal(visible.size, 0);
  session.add(issue('/project/Bar.kt'));
  assert.equal(visible.size, 1);
  session.finish(true);
  session.add(issue('/project/Baz.kt'));
  assert.equal(visible.size, 0);
});

test('ignora builds fora da seleção e arquivos da variante inativa', () => {
  const { coordinator, visible, issue } = setup();
  coordinator.selectTarget('selected', file => !file.includes('/other/'));
  coordinator.begin('unselected').add(issue('/project/Foo.kt'));
  const session = coordinator.begin('selected');
  session.add(issue('/project/other/Foo.kt'));
  session.add(issue('/project/active/Foo.kt'));
  assert.deepEqual([...visible.keys()], ['/project/active/Foo.kt']);
});
