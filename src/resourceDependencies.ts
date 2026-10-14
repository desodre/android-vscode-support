import type { AndroidModule, AndroidVariant } from './projectDiscovery';
import { moduleKey } from './projectDiscovery';
import { resolveSourceSets } from './sourceSets';
import type { ResourceModuleDependency } from './xmlResources';

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
        ?? dependency.variants.find(candidate => candidate.buildType === selected.buildType &&
          candidate.flavors.every(flavor => selected.flavors.some(parent =>
            parent.dimension === flavor.dimension && parent.name === flavor.name)));
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
