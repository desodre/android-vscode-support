import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AndroidModule, AndroidVariant } from '../projectDiscovery';
import { resourceDependencyModules, resourceVariant } from '../resourceDependencies';

const variant = (name: string, buildType: string, dependencies: string[] = [], flavor?: string, dimension = 'tier'): AndroidVariant => ({
  name, buildType, projectDependencies: dependencies, applicationId: null,
  flavors: flavor ? [{ dimension, name: flavor }] : []
});
const makeModule = (path: string, variants: AndroidVariant[]): AndroidModule => ({
  root: '/workspace', path, name: path.slice(1), projectDir: `/workspace/${path.slice(1)}`,
  type: 'library', namespace: null, runnable: false, variants, buildTypes: [],
  flavorDimensions: [], flavors: []
});

test('indexes only declared Gradle project dependencies with matching variants', () => {
  const app = makeModule(':app', [variant('freeDebug', 'debug', [':lib', ':unrelated'], 'free')]);
  const lib = makeModule(':lib', [variant('debug', 'debug', [':core'])]);
  const core = makeModule(':core', [variant('debug', 'debug')]);
  const unrelated = makeModule(':unrelated', [variant('paidDebug', 'debug', [], 'paid')]);
  assert.deepEqual(resourceDependencyModules([app, lib, core, unrelated], app, app.variants[0]), [
    { root: '/workspace/lib', sourceSetNames: ['main', 'debug'] },
    { root: '/workspace/core', sourceSetNames: ['main', 'debug'] }
  ]);
});

test('does not follow dependencies from another Gradle root', () => {
  const app = makeModule(':app', [variant('debug', 'debug', [':lib'])]);
  const other = { ...makeModule(':lib', [variant('debug', 'debug')]), root: '/other' };
  assert.deepEqual(resourceDependencyModules([app, other], app, app.variants[0]), []);
});

test('módulo selecionado usa a variante selecionada', () => {
  const app = makeModule(':app', [variant('freeDebug', 'debug', [], 'free'), variant('paidDebug', 'debug', [], 'paid')]);
  assert.equal(resourceVariant(app, { module: app, variant: app.variants[1] }), app.variants[1]);
});

test('outro módulo usa a única variante compatível com a seleção', () => {
  const app = makeModule(':app', [variant('freeDebug', 'debug', [], 'free')]);
  const lib = makeModule(':lib', [variant('freeDebug', 'debug', [], 'free'), variant('paidDebug', 'debug', [], 'paid'),
    variant('freeRelease', 'release', [], 'free')]);
  assert.equal(resourceVariant(lib, { module: app, variant: app.variants[0] }), lib.variants[0]);
});

test('flavor de outra dimensão não é compatível', () => {
  const app = makeModule(':app', [variant('freeDebug', 'debug', [], 'free')]);
  const lib = makeModule(':lib', [variant('freeDebug', 'debug', [], 'free', 'store'), variant('release', 'release')]);
  assert.equal(resourceVariant(lib, { module: app, variant: app.variants[0] }), undefined);
});

test('variantes compatíveis ambíguas não escolhem nenhuma', () => {
  const app = makeModule(':app', [variant('debug', 'debug')]);
  const lib = makeModule(':lib', [variant('debug', 'debug'), { ...variant('debug', 'debug'), name: 'debugCopy' }]);
  assert.equal(resourceVariant(lib, { module: app, variant: app.variants[0] }), undefined);
});

test('sem seleção usa a única variante do módulo, se houver só uma', () => {
  const single = makeModule(':single', [variant('debug', 'debug')]);
  const many = makeModule(':many', [variant('debug', 'debug'), variant('release', 'release')]);
  assert.equal(resourceVariant(single), single.variants[0]);
  assert.equal(resourceVariant(many), undefined);
});
