import type { AndroidModule, AndroidVariant } from './projectDiscovery';
import { moduleKey } from './projectDiscovery';
import { resolveSourceSets } from './sourceSets';
import type { ResourceModuleDependency } from './xmlResources';

/** A variant whose build type matches and whose flavors are all part of `selected`. */
export function isCompatibleVariant(candidate: AndroidVariant, selected: AndroidVariant): boolean {
  return candidate.buildType === selected.buildType && candidate.flavors.every(flavor => selected.flavors.some(parent =>
    parent.dimension === flavor.dimension && parent.name === flavor.name));
}

/**
 * Variant used to resolve resources of `owner`: the selected variant for the selected module; otherwise the only
 * variant compatible with the selection, or the only variant the module has.
 */
export function resourceVariant(
  owner: AndroidModule, selected?: { module: AndroidModule; variant: AndroidVariant }
): AndroidVariant | undefined {
  if (selected && moduleKey(selected.module) === moduleKey(owner)) { return selected.variant; }
  const compatible = selected ? owner.variants.filter(candidate => isCompatibleVariant(candidate, selected.variant)) : [];
  return compatible.length === 1 ? compatible[0] : owner.variants.length === 1 ? owner.variants[0] : undefined;
}

/** Maps direct Gradle project dependencies to known Android modules and their compatible variants. */
export function resourceDependencyModules(
  modules: readonly AndroidModule[], module: AndroidModule, variant: AndroidVariant
): ResourceModuleDependency[] {
  const result: ResourceModuleDependency[] = [];
  const visited = new Set<string>([moduleKey(module)]);
  const visit = (owner: AndroidModule, selected: AndroidVariant): void => {
    for (const path of selected.projectDependencies ?? []) {
      const dependency = modules.find(candidate => candidate.root === owner.root && candidate.path === path);
      if (!dependency || visited.has(moduleKey(dependency))) { continue; }
      const matched = dependency.variants.find(candidate => candidate.name === selected.name)
        ?? dependency.variants.find(candidate => isCompatibleVariant(candidate, selected));
      if (!matched) { continue; }
      visited.add(moduleKey(dependency));
      result.push({ root: dependency.projectDir,
        sourceSetNames: resolveSourceSets(dependency, matched).sourceSetNames });
      visit(dependency, matched);
    }
  };
  visit(module, variant);
  return result;
}
