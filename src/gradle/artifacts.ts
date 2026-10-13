import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { GradleSelection, gradleTaskName } from './runner';

export interface BuiltArtifact {
  type: 'APK' | 'AAB';
  file: string;
  variant: string;
  applicationId: string | null;
  filters: readonly { filterType: string; value: string }[];
}

interface ApkMetadata {
  artifactType?: { type?: unknown };
  applicationId?: unknown;
  variantName?: unknown;
  elements?: unknown;
}

function contained(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep);
}

function walk(root: string, depth: number): string[] {
  if (depth < 0 || !existsSync(root)) { return []; }
  const files: string[] = [];
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isDirectory()) { files.push(...walk(path, depth - 1)); }
    else if (item.isFile()) { files.push(path); }
  }
  return files;
}

export function findBuiltArtifacts(selection: GradleSelection, applicationId: string | null = null): BuiltArtifact[] {
  gradleTaskName(selection, 'assemble');
  const moduleRoot = selection.moduleDirectory ?? join(selection.rootPath, ...selection.modulePath.slice(1).split(':'));
  const outputRoot = join(moduleRoot, 'build', 'outputs');
  const result: BuiltArtifact[] = [];

  for (const metadataFile of walk(join(outputRoot, 'apk'), 5).filter(file => basename(file) === 'output-metadata.json')) {
    let metadata: ApkMetadata;
    try { metadata = JSON.parse(readFileSync(metadataFile, 'utf8')) as ApkMetadata; }
    catch { continue; }
    if (metadata.artifactType?.type !== 'APK' || metadata.variantName !== selection.variant || !Array.isArray(metadata.elements)) { continue; }
    const base = dirname(metadataFile);
    for (const element of metadata.elements) {
      if (typeof element !== 'object' || !element) { continue; }
      const outputFile = (element as { outputFile?: unknown }).outputFile;
      if (typeof outputFile !== 'string' || !outputFile.endsWith('.apk')) { continue; }
      const file = resolve(base, outputFile);
      if (!contained(base, file) || !existsSync(file) || !statSync(file).isFile()) { continue; }
      const filters = (element as { filters?: unknown }).filters;
      result.push({
        type: 'APK', file, variant: selection.variant,
        applicationId: typeof metadata.applicationId === 'string' ? metadata.applicationId : applicationId,
        filters: Array.isArray(filters) ? filters.filter(filter =>
          typeof filter === 'object' && filter !== null && typeof filter.filterType === 'string' && typeof filter.value === 'string'
        ) : [],
      });
    }
  }

  for (const file of walk(join(outputRoot, 'bundle'), 5).filter(file => file.endsWith('.aab'))) {
    const parts = relative(join(outputRoot, 'bundle'), dirname(file)).split(sep);
    if (!parts.includes(selection.variant)) { continue; }
    result.push({ type: 'AAB', file, variant: selection.variant, applicationId, filters: [] });
  }
  return result;
}
