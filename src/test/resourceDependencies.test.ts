import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AndroidModule, AndroidVariant } from '../projectDiscovery';
import { resourceDependencyModules } from '../resourceDependencies';

const variant = (name: string, buildType: string, dependencies: string[] = [], flavor?: string): AndroidVariant => ({
  name, buildType, projectDependencies: dependencies, applicationId: null,
  flavors: flavor ? [{ dimension: 'tier', name: flavor }] : []
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
