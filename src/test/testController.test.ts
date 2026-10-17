import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('Test Explorer respeita exclusões nos filtros Gradle e não executa uma seleção vazia', async t => {
  interface Item { id: string; parent?: Item; children: Collection }
  class Collection {
    values: Item[] = [];
    constructor(private owner?: Item) {}
    replace(values: Item[]) { this.values = values; values.forEach(value => value.parent = this.owner); }
    forEach(callback: (value: Item) => void) { this.values.forEach(callback); }
  }
  const items = new Collection();
  let handler: (request: unknown, token: unknown) => Promise<void>;
  const filters: string[][] = [];
  let ended = 0;
  const started: string[] = [];
  const fakeController = {
    items,
    createTestItem: (id: string) => {
      const result: Item = { id, children: new Collection() };
      result.children = new Collection(result);
      return result;
    },
    createRunProfile: (_name: string, _kind: unknown, run: typeof handler) => { handler = run; },
    createTestRun: () => ({
      started: (value: Item) => started.push(value.id), skipped: () => {},
      appendOutput: () => {}, end: () => { ended++; },
    }),
    dispose: () => {},
  };
  const vscode = {
    tests: { createTestController: () => fakeController },
    TestRunProfileKind: { Run: 1 },
    Uri: { file: (file: string) => ({ fsPath: file }) },
    Range: class {}, workspace: { isTrusted: true },
  };
  const runner = {
    runGradle: async (_selection: unknown, _action: unknown, _output: unknown, _signal: unknown, args: string[]) => {
      filters.push(args);
      return { cancelled: true, exitCode: 130 };
    },
  };
  const runtime = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const original = runtime._load;
  let Controller: typeof import('../testing/testController').AndroidUnitTestController;
  try {
    runtime._load = (request, parent, isMain) => request === 'vscode' ? vscode
      : request === '../gradle/runner' ? runner : original.call(runtime, request, parent, isMain);
    Controller = require('../testing/testController').AndroidUnitTestController;
  } finally { runtime._load = original; }
  const root = mkdtempSync(join(tmpdir(), 'android-controller-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'FirstTest.kt'), 'package example\nclass FirstTest {\n@Test fun first() {}\n@Test fun second() {}\n}');
  writeFileSync(join(root, 'SecondTest.kt'), 'package example\nclass SecondTest {\n@Test fun third() {}\n}');
  const controller = new Controller(() => ({ roots: [root], selection: { rootPath: root, modulePath: ':app', variant: 'freeDebug' } }));
  controller.refresh();
  const suite = items.values[0];
  const [firstClass, secondClass] = suite.children.values;
  const [first, second] = firstClass.children.values;
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };
  await handler!({}, token);
  assert.deepEqual(filters.pop(), [], 'suite completa usa tarefa sem filtro');
  await handler!({ include: [firstClass] }, token);
  assert.deepEqual(filters.pop(), ['--tests', 'example.FirstTest']);
  await handler!({ include: [first] }, token);
  assert.deepEqual(filters.pop(), ['--tests', 'example.FirstTest.first']);
  await handler!({ exclude: [firstClass] }, token);
  assert.deepEqual(filters.pop(), ['--tests', 'example.SecondTest.third']);
  await handler!({ include: [firstClass], exclude: [second] }, token);
  assert.deepEqual(filters.pop(), ['--tests', 'example.FirstTest.first']);
  started.length = 0;
  await handler!({ exclude: [firstClass, secondClass] }, token);
  await handler!({}, { ...token, isCancellationRequested: true });
  assert.deepEqual(filters, [], 'não chama Gradle com seleção vazia ou cancelada');
  assert.deepEqual(started, []);
  assert.equal(ended, 7);
});
