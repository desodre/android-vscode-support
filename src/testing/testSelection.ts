/** Expand selected suites/classes, preserving exclusions on any ancestor and removing duplicates. */
export function selectedTestLeaves<T>(included: readonly T[], excluded: readonly T[],
  childrenOf: (item: T) => readonly T[], parentOf: (item: T) => T | undefined): T[] {
  const exclusions = new Set(excluded);
  const selected = new Set<T>();
  const visit = (item: T): void => {
    for (let ancestor: T | undefined = item; ancestor !== undefined; ancestor = parentOf(ancestor)) {
      if (exclusions.has(ancestor)) { return; }
    }
    const children = childrenOf(item);
    if (children.length) { children.forEach(visit); }
    else { selected.add(item); }
  };
  included.forEach(visit);
  return [...selected];
}
