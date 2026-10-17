import { statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AndroidModule, AndroidVariant } from './projectDiscovery';

export type SourceLanguage = 'java' | 'kotlin';
export type GeneratedSourceKind = 'R' | 'BuildConfig' | 'annotation' | 'ksp' | 'agp';

export interface SourceRoot {
  sourceSet: string;
  language: SourceLanguage;
  path: string;
  exists: boolean;
}

export interface GeneratedSourceRoot {
  kind: GeneratedSourceKind;
  path: string;
  exists: boolean;
}

export interface SourceSetLayout {
  moduleDir: string;
  variant: string;
  /** Ordered from shared to most specific. Includes source sets without directories yet. */
  sourceSetNames: string[];
  /** Source sets declared by other discovered variants; unknown custom sets are left unclassified. */
  inactiveSourceSetNames: string[];
  sourceRoots: SourceRoot[];
  /** Reported static roots exclusive to another discovered variant. */
  inactiveSourceRoots: string[];
  /** Known AGP/KSP output conventions. Check `exists` before adding to an editor classpath. */
  generatedRoots: GeneratedSourceRoot[];
}

export type SourceFileActivity = 'active' | 'inactive' | 'unrelated';

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function safeSegment(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\') && !value.includes('\0');
}

function upperFirst(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1); }

function isWithin(path: string, parent: string): boolean {
  const child = relative(parent, path);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

/** Resolve os diretórios convencionais da variante usando o catálogo Gradle já descoberto. */
export function resolveSourceSets(
  module: Pick<AndroidModule, 'projectDir'> & Partial<Pick<AndroidModule, 'variants'>>,
  variant: Pick<AndroidVariant, 'name' | 'buildType' | 'flavors'> &
    Partial<Pick<AndroidVariant, 'javaSourceDirs' | 'kotlinSourceDirs' | 'javaGeneratedDirs' | 'kotlinGeneratedDirs'>>,
): SourceSetLayout {
  const moduleDir = resolve(module.projectDir);
  const sourceSetNames = namesForVariant(variant);
  const inactiveSourceSetNames = [...new Set((module.variants ?? []).flatMap(namesForVariant))]
    .filter(name => !sourceSetNames.includes(name));
  const conventionalRoots = sourceSetNames.flatMap(sourceSet => (['java', 'kotlin'] as const).map(language => {
    const path = join(moduleDir, 'src', sourceSet, language);
    return { sourceSet, language, path, exists: isDirectory(path) };
  }));
  const reportedRoots = (['java', 'kotlin'] as const).flatMap(language => {
    const paths = language === 'java' ? variant.javaSourceDirs : variant.kotlinSourceDirs;
    return (paths ?? []).filter(isAbsolute).map(path => {
      const normalized = resolve(path);
      const parts = relative(join(moduleDir, 'src'), normalized).split(sep);
      const sourceSet = parts.length >= 2 && parts[0] !== '..' ? parts[0] : 'variant';
      return { sourceSet, language, path: normalized, exists: isDirectory(normalized) };
    });
  });
  // AGP includes custom source directories; conventional roots remain for older model responses.
  const sourceRoots = [...reportedRoots, ...conventionalRoots.filter(root =>
    !reportedRoots.some(reported => reported.language === root.language && reported.path === root.path))];
  const activePaths = new Set(sourceRoots.map(root => root.path));
  const inactiveSourceRoots = [...new Set((module.variants ?? [])
    .filter(candidate => candidate.name !== variant.name)
    .flatMap(candidate => [...candidate.javaSourceDirs ?? [], ...candidate.kotlinSourceDirs ?? []])
    .filter(isAbsolute).map(path => resolve(path)))].filter(path => !activePaths.has(path));

  // AGP moved R and BuildConfig output paths across releases. These paths are candidates,
  // never evidence that a generated class exists; only existing directories enter classpaths.
  const variantName = safeSegment(variant.name) ? variant.name : '';
  const generated: Array<[GeneratedSourceKind, string[]]> = variantName ? [
    ['R', ['build', 'generated', 'source', 'r', variantName]],
    ['R', ['build', 'generated', 'not_namespaced_r_class_sources', variantName, `process${upperFirst(variantName)}Resources`, 'r']],
    ['BuildConfig', ['build', 'generated', 'source', 'buildConfig', variantName]],
    ['annotation', ['build', 'generated', 'ap_generated_sources', variantName, 'out']],
    ['annotation', ['build', 'generated', 'source', 'kapt', variantName]],
    ['annotation', ['build', 'generated', 'source', 'kaptKotlin', variantName]],
    ['ksp', ['build', 'generated', 'ksp', variantName, 'java']],
    ['ksp', ['build', 'generated', 'ksp', variantName, 'kotlin']],
  ] : [];
  const conventionalGeneratedRoots = generated.map(([kind, parts]) => {
    const path = join(moduleDir, ...parts);
    return { kind, path, exists: isDirectory(path) };
  });
  const reportedGeneratedRoots = [...variant.javaGeneratedDirs ?? [], ...variant.kotlinGeneratedDirs ?? []]
    .filter(isAbsolute).map(path => ({ kind: 'agp' as const, path: resolve(path), exists: isDirectory(path) }));
  const generatedRoots = [...reportedGeneratedRoots, ...conventionalGeneratedRoots.filter(root =>
    !reportedGeneratedRoots.some(reported => reported.path === root.path))];
  return { moduleDir, variant: variant.name, sourceSetNames, inactiveSourceSetNames,
    sourceRoots, inactiveSourceRoots, generatedRoots };
}

function namesForVariant(variant: Pick<AndroidVariant, 'name' | 'buildType' | 'flavors'>): string[] {
  const flavors = variant.flavors.map(flavor => flavor.name);
  const names = ['main', ...flavors];
  if (flavors.length > 1) { names.push(flavors[0] + flavors.slice(1).map(upperFirst).join('')); }
  if (variant.buildType) { names.push(variant.buildType); }
  names.push(variant.name);
  return [...new Set(names.filter(safeSegment))];
}

/**
 * Marca arquivos de source sets e saídas geradas de outras variantes como inativos.
 * Arquivos fora dos padrões conhecidos ficam `unrelated`, para não ocultar diagnósticos legítimos.
 */
export function classifySourceFile(file: string, layout: SourceSetLayout): SourceFileActivity {
  const path = resolve(file);
  if (!isWithin(path, layout.moduleDir)) { return 'unrelated'; }
  if (layout.sourceRoots.some(root => isWithin(path, root.path))) { return 'active'; }
  if (layout.inactiveSourceRoots.some(root => isWithin(path, root))) { return 'inactive'; }
  const parts = relative(layout.moduleDir, path).split(sep);
  if (parts[0] === 'src' && parts.length >= 4 && (parts[2] === 'java' || parts[2] === 'kotlin')) {
    return layout.sourceSetNames.includes(parts[1]) ? 'active'
      : layout.inactiveSourceSetNames.includes(parts[1]) ? 'inactive' : 'unrelated';
  }
  if (layout.generatedRoots.some(root => isWithin(path, root.path))) { return 'active'; }
  if (parts[0] !== 'build' || parts[1] !== 'generated') { return 'unrelated'; }
  const variantIndex = parts[2] === 'source' && ['r', 'buildConfig', 'kapt', 'kaptKotlin'].includes(parts[3]) ? 4
    : ['not_namespaced_r_class_sources', 'ap_generated_sources', 'ksp'].includes(parts[2]) ? 3 : -1;
  if (variantIndex < 0 || parts.length <= variantIndex + 1) { return 'unrelated'; }
  return parts[variantIndex] === layout.variant ? 'active' : 'inactive';
}
