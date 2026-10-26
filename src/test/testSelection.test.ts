import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectedTestLeaves } from '../testing/testSelection';

interface Item { name: string; children: Item[]; parent?: Item }
function item(name: string, ...children: Item[]): Item {
  const result = { name, children };
  children.forEach(child => child.parent = result);
  return result;
}
const first = item('first');
const second = item('second');
const third = item('third');
const firstClass = item('FirstTest', first, second);
const secondClass = item('SecondTest', third);
const suite = item('suite', firstClass, secondClass);
const select = (included: Item[], excluded: Item[] = []) =>
  selectedTestLeaves(included, excluded, value => value.children, value => value.parent).map(value => value.name);

test('executa método, classe e suíte sem duplicar seleções sobrepostas', () => {
  assert.deepEqual(select([first]), ['first']);
  assert.deepEqual(select([firstClass]), ['first', 'second']);
  assert.deepEqual(select([suite, firstClass, first]), ['first', 'second', 'third']);
});

test('excluir classe ou suíte exclui todos seus métodos, inclusive inclusões explícitas', () => {
  assert.deepEqual(select([suite], [firstClass]), ['third']);
  assert.deepEqual(select([suite, first], [firstClass]), ['third']);
  assert.deepEqual(select([first], [firstClass]), []);
  assert.deepEqual(select([suite], [suite]), []);
});

test('excluir método mantém os demais métodos da classe', () => {
  assert.deepEqual(select([suite], [second]), ['first', 'third']);
  assert.deepEqual(select([firstClass], [first, second]), []);
});
