import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Subconjunto de BridgeClient necessário aqui (facilita testes e injeção). */
export interface BridgeRequester {
  request<T>(method: string, params?: Record<string, unknown>, signal?: AbortSignal, device?: string, timeoutMs?: number): Promise<T>;
}

export type AndroidModuleType = 'application' | 'library' | 'dynamic-feature' | 'test';

export interface FlavorSelection { dimension: string; name: string }

export interface AndroidVariant {
  name: string;
  buildType: string;
  flavors: FlavorSelection[];
  applicationId: string | null;
}

export interface AndroidModule {
  /** Raiz do build Gradle (diretório com settings.gradle[.kts]). */
  root: string;
  /** Caminho Gradle, por exemplo ":app". */
  path: string;
  name: string;
  projectDir: string;
  type: AndroidModuleType;
  namespace: string | null;
  /** Apenas módulos application geram APK instalável. */
  runnable: boolean;
  variants: AndroidVariant[];
  buildTypes: string[];
  flavorDimensions: string[];
  /** Flavors únicos por dimensão. */
  flavors: FlavorSelection[];
}

export interface DiscoveryFailure { root: string; message: string }

export interface AndroidCatalog {
  roots: string[];
  modules: AndroidModule[];
  failures: DiscoveryFailure[];
}

const MODULE_TYPES: readonly string[] = ['application', 'library', 'dynamic-feature', 'test'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'build', 'out', '.git', '.gradle', '.idea', '.vscode', '.cxx']);
const SETTINGS_FILES = ['settings.gradle', 'settings.gradle.kts'];

/** Identificador estável de um módulo entre raízes Gradle. */
export function moduleKey(module: { root: string; path: string }): string {
  return `${module.root}::${module.path}`;
}

/** Nome da task Gradle para um variant: `:app` + `freeDebug` + `install` => `:app:installFreeDebug`. */
export function variantTask(module: Pick<AndroidModule, 'path'>, variantName: string, prefix: 'assemble' | 'install'): string {
  const base = module.path === ':' ? '' : module.path;
  return `${base}:${prefix}${variantName.charAt(0).toUpperCase()}${variantName.slice(1)}`;
}

/**
 * Localiza raízes de builds Gradle apenas pela existência de settings.gradle[.kts]
 * (nunca lê o conteúdo). Não desce dentro de uma raiz já encontrada.
 */
export function findGradleRoots(directory: string, maxDepth = 3): string[] {
  const roots: string[] = [];
  const visit = (dir: string, depth: number): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some(entry => entry.isFile() && SETTINGS_FILES.includes(entry.name))) {
      roots.push(dir);
      return;
    }
    if (depth >= maxDepth) { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED_DIRECTORIES.has(entry.name)) {
        visit(join(dir, entry.name), depth + 1);
      }
    }
  };
  visit(directory, 0);
  return roots;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

/** Converte a resposta crua de `gradle.discoverProjects` em módulos Android; ignora entradas malformadas. */
export function normalizeDiscovery(raw: unknown, fallbackRoot: string): AndroidModule[] {
  if (!isObject(raw) || !Array.isArray(raw.projects)) {
    throw new Error('Resposta de descoberta Gradle inválida.');
  }
  const root = text(raw.rootDir) ?? fallbackRoot;
  const modules: AndroidModule[] = [];
  for (const project of raw.projects) {
    if (!isObject(project) || !isObject(project.android)) { continue; }
    const path = text(project.path);
    const type = text(project.android.type);
    if (!path || !type || !MODULE_TYPES.includes(type)) { continue; }
    const variants: AndroidVariant[] = [];
    for (const variant of Array.isArray(project.android.variants) ? project.android.variants : []) {
      if (!isObject(variant)) { continue; }
      const name = text(variant.name);
      if (!name || variants.some(existing => existing.name === name)) { continue; }
      const flavors: FlavorSelection[] = [];
      for (const flavor of Array.isArray(variant.flavors) ? variant.flavors : []) {
        if (isObject(flavor) && text(flavor.name)) {
          flavors.push({ dimension: text(flavor.dimension) ?? '', name: String(flavor.name) });
        }
      }
      variants.push({ name, buildType: text(variant.buildType) ?? '', flavors, applicationId: text(variant.applicationId) });
    }
    variants.sort((a, b) => a.name.localeCompare(b.name));
    const flavors: FlavorSelection[] = [];
    for (const flavor of variants.flatMap(variant => variant.flavors)) {
      if (!flavors.some(known => known.dimension === flavor.dimension && known.name === flavor.name)) { flavors.push(flavor); }
    }
    modules.push({
      root, path, name: text(project.name) ?? path, projectDir: text(project.projectDir) ?? root,
      type: type as AndroidModuleType, namespace: text(project.android.namespace),
      runnable: type === 'application', variants,
      buildTypes: [...new Set(variants.map(variant => variant.buildType).filter(Boolean))].sort(),
      flavorDimensions: [...new Set(flavors.map(flavor => flavor.dimension).filter(Boolean))],
      flavors
    });
  }
  return modules;
}

/** Descobre os módulos Android de um único build Gradle via Kotlin bridge + Gradle Tooling API. */
export async function discoverGradleRoot(bridge: BridgeRequester, root: string, signal?: AbortSignal): Promise<AndroidModule[]> {
  const raw = await bridge.request<unknown>('gradle.discoverProjects', { projectDir: root }, signal, undefined, 300000);
  return normalizeDiscovery(raw, root);
}

/**
 * Ponto de integração principal: acha raízes Gradle nas pastas do workspace e descobre módulos/variantes.
 * Falhas por raiz são coletadas em `failures` (não interrompem as demais); cancelamento propaga.
 */
export async function discoverAndroidWorkspace(
  bridge: BridgeRequester, workspaceFolders: readonly string[], signal?: AbortSignal, maxDepth = 3
): Promise<AndroidCatalog> {
  const roots = [...new Set(workspaceFolders.flatMap(folder => findGradleRoots(folder, maxDepth)))];
  const modules: AndroidModule[] = [];
  const failures: DiscoveryFailure[] = [];
  for (const root of roots) {
    if (signal?.aborted) { throw new Error('Operação cancelada.'); }
    try {
      modules.push(...await discoverGradleRoot(bridge, root, signal));
    } catch (error) {
      if (signal?.aborted) { throw error; }
      failures.push({ root, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { roots, modules, failures };
}
