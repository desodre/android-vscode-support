import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AndroidCatalog, AndroidModule } from '../projectDiscovery';
import { MementoLike, PickItem, reconcileSelection, SelectionStore, SelectionUi } from '../selection';

class FakeMemento implements MementoLike {
  readonly data = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.data.get(key) as T | undefined; }
  async update(key: string, value: unknown): Promise<void> { this.data.set(key, value); }
}

function module(path: string, variants: string[], type: AndroidModule['type'] = 'application', root = '/r'): AndroidModule {
  return {
    root, path, name: path.slice(1), projectDir: `${root}/${path.slice(1)}`, type, namespace: null, runnable: type === 'application',
    variants: variants.map(name => ({ name, buildType: /release/i.test(name) ? 'release' : 'debug', flavors: [], applicationId: null })),
    buildTypes: [], flavorDimensions: [], flavors: []
  };
}
const catalog = (...modules: AndroidModule[]): AndroidCatalog => ({ roots: ['/r'], modules, failures: [] });
const KEY = 'androidSupport.selection.v1';

test('seleção de módulo e variant persiste e é restaurada por outro store', async () => {
  const memento = new FakeMemento();
  const store = new SelectionStore(memento);
  await store.refresh(catalog(module(':app', ['release', 'debug']), module(':lib', ['debug'], 'library')));
  await store.selectModule({ root: '/r', path: ':app' });
  assert.equal(store.current.variant, 'debug');
  await store.selectVariant('release');
  const restored = new SelectionStore(memento);
  await restored.refresh(catalog(module(':app', ['release', 'debug'])));
  assert.deepEqual(restored.current, { module: '/r:::app', variant: 'release' });
  assert.equal(restored.statusText(), ':app [release]');
  assert.equal(restored.resolve()?.variant.name, 'release');
});

test('variant removido invalida só o variant; módulo removido limpa tudo', async () => {
  const memento = new FakeMemento();
  memento.data.set(KEY, { module: '/r:::app', variant: 'staging' });
  const store = new SelectionStore(memento);
  assert.deepEqual(await store.refresh(catalog(module(':app', ['debug']))), ['variant-removed']);
  assert.equal(store.resolve()?.variant.name, 'debug'); // cai no padrão
  assert.deepEqual(memento.data.get(KEY), { module: '/r:::app', variant: null });
  assert.deepEqual(await store.refresh(catalog(module(':other', ['debug']))), ['module-removed']);
  assert.deepEqual(store.current, { module: null, variant: null });
  assert.deepEqual(memento.data.get(KEY), { module: null, variant: null });
  assert.equal(store.resolve(), undefined);
});

test('falha na raiz Gradle não apaga a seleção', async () => {
  const memento = new FakeMemento();
  memento.data.set(KEY, { module: '/r:::app', variant: 'debug' });
  const store = new SelectionStore(memento);
  const invalidated = await store.refresh({ roots: ['/r'], modules: [], failures: [{ root: '/r', message: 'x' }] });
  assert.deepEqual(invalidated, []);
  assert.equal(store.current.module, '/r:::app');
});

test('estado persistido corrompido é ignorado', () => {
  const memento = new FakeMemento();
  memento.data.set(KEY, { module: 42, variant: ['x'] });
  assert.deepEqual(new SelectionStore(memento).current, { module: null, variant: null });
});

test('reconcileSelection é pura e trata seleção vazia', () => {
  assert.deepEqual(reconcileSelection({ module: null, variant: null }, catalog()), { selection: { module: null, variant: null }, invalidated: [] });
});

test('valida módulo e variant desconhecidos e notifica ouvintes', async () => {
  const store = new SelectionStore(new FakeMemento());
  await store.refresh(catalog(module(':app', ['debug'])));
  await assert.rejects(store.selectVariant('debug'), /módulo antes/);
  await assert.rejects(store.selectModule({ root: '/r', path: ':nope' }), /desconhecido/);
  const events: unknown[] = [];
  const subscription = store.onDidChange(selection => events.push(selection));
  await store.selectModule({ root: '/r', path: ':app' });
  await assert.rejects(store.selectVariant('nope'), /desconhecido/);
  await store.selectModule({ root: '/r', path: ':app' }); // sem mudança, sem evento
  assert.equal(events.length, 1);
  subscription.dispose();
  await store.clear();
  assert.equal(events.length, 1);
});

test('pickers usam a UI e respeitam cancelamento', async () => {
  const store = new SelectionStore(new FakeMemento());
  await store.refresh(catalog(module(':app', ['debug', 'release']), module(':lib', ['debug'], 'library')));
  let seen: PickItem<unknown>[] = [];
  const choose = (index: number | undefined): SelectionUi => ({
    async pick<T>(items: PickItem<T>[]) { seen = items as PickItem<unknown>[]; return index === undefined ? undefined : items[index].value; }
  });
  assert.equal(await store.pickModule(choose(undefined)), false);
  assert.equal(store.current.module, null);
  assert.equal(await store.pickModule(choose(1)), true);
  assert.equal(store.current.module, '/r:::lib');
  assert.deepEqual(seen.map(item => item.label), [':app', ':lib']);
  await store.pickModule(choose(0));
  assert.equal(await store.pickVariant(choose(1)), true);
  assert.equal(store.current.variant, 'release');
  assert.deepEqual(seen.map(item => item.label), ['debug', 'release']);
});
