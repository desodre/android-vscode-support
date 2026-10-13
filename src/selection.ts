import type { AndroidCatalog, AndroidModule, AndroidVariant } from './projectDiscovery';
import { moduleKey } from './projectDiscovery';

/** Compatível com `vscode.Memento` (ex.: `context.workspaceState`). */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export interface Selection {
  /** `moduleKey` do módulo selecionado, ou null. */
  module: string | null;
  /** Nome do variant selecionado dentro do módulo, ou null. */
  variant: string | null;
}

export type InvalidationReason = 'module-removed' | 'variant-removed' | 'module-not-runnable';

export interface Reconciled {
  selection: Selection;
  invalidated: InvalidationReason[];
}

export const SELECTION_STATE_KEY = 'androidSupport.selection.v1';
export const EMPTY_SELECTION: Selection = { module: null, variant: null };

function sanitize(value: unknown): Selection {
  const candidate = (typeof value === 'object' && value !== null ? value : {}) as Partial<Selection>;
  const module = typeof candidate.module === 'string' && candidate.module ? candidate.module : null;
  return { module, variant: module && typeof candidate.variant === 'string' && candidate.variant ? candidate.variant : null };
}

/**
 * Compara a seleção salva com o catálogo atual. Módulo removido limpa tudo; variant removido limpa só o variant.
 */
export function reconcileSelection(saved: Selection, catalog: Pick<AndroidCatalog, 'modules'>): Reconciled {
  const selection = sanitize(saved);
  if (!selection.module) { return { selection: { ...EMPTY_SELECTION }, invalidated: [] }; }
  const module = catalog.modules.find(candidate => moduleKey(candidate) === selection.module);
  if (!module) { return { selection: { ...EMPTY_SELECTION }, invalidated: ['module-removed'] }; }
  if (selection.variant && !module.variants.some(variant => variant.name === selection.variant)) {
    return { selection: { module: selection.module, variant: null }, invalidated: ['variant-removed'] };
  }
  return { selection, invalidated: [] };
}

/** Variant padrão: preferir `debug`, senão o primeiro variant debug, senão o primeiro. */
export function defaultVariant(module: Pick<AndroidModule, 'variants'>): AndroidVariant | undefined {
  return module.variants.find(variant => variant.name === 'debug')
    ?? module.variants.find(variant => variant.buildType === 'debug')
    ?? module.variants[0];
}

/** Módulo padrão: primeiro application, senão o primeiro módulo. */
export function defaultModule(catalog: Pick<AndroidCatalog, 'modules'>): AndroidModule | undefined {
  return catalog.modules.find(module => module.runnable) ?? catalog.modules[0];
}

export interface ResolvedSelection {
  module: AndroidModule;
  variant: AndroidVariant;
}

export interface PickItem<T> { label: string; description?: string; detail?: string; value: T }

/** Abstração de UI; `createVscodeSelectionUi` fornece a implementação com QuickPick. */
export interface SelectionUi {
  pick<T>(items: PickItem<T>[], placeHolder: string): Promise<T | undefined>;
}

/**
 * Seleção de módulo/variant persistida por workspace (via `workspaceState`) e invalidada
 * quando a descoberta deixa de listar o módulo ou o variant.
 */
export class SelectionStore {
  private catalog: AndroidCatalog = { roots: [], modules: [], failures: [] };
  private selection: Selection;
  private readonly listeners = new Set<(selection: Selection) => void>();

  constructor(private readonly memento: MementoLike, private readonly key = SELECTION_STATE_KEY) {
    this.selection = sanitize(memento.get<Selection>(key));
  }

  get current(): Selection { return { ...this.selection }; }
  get modules(): readonly AndroidModule[] { return this.catalog.modules; }

  onDidChange(listener: (selection: Selection) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  /** Resolve a seleção atual para objetos concretos; variant ausente cai no padrão do módulo. */
  resolve(): ResolvedSelection | undefined {
    const module = this.catalog.modules.find(candidate => moduleKey(candidate) === this.selection.module);
    if (!module) { return undefined; }
    const variant = module.variants.find(candidate => candidate.name === this.selection.variant) ?? defaultVariant(module);
    return variant ? { module, variant } : undefined;
  }

  /** Integra um novo catálogo; invalida seleções removidas e persiste. Retorna os motivos de invalidação. */
  async refresh(catalog: AndroidCatalog): Promise<InvalidationReason[]> {
    this.catalog = catalog;
    // Falha de descoberta não prova remoção: preserva seleção de raízes que falharam.
    const failedRoots = new Set(catalog.failures.map(failure => failure.root));
    const savedRoot = this.selection.module?.split('::')[0];
    if (savedRoot && failedRoots.has(savedRoot)) { return []; }
    const { selection, invalidated } = reconcileSelection(this.selection, catalog);
    await this.apply(selection);
    return invalidated;
  }

  async selectModule(module: Pick<AndroidModule, 'root' | 'path'>): Promise<void> {
    const key = moduleKey(module);
    const known = this.catalog.modules.find(candidate => moduleKey(candidate) === key);
    if (!known) { throw new Error(`Módulo desconhecido: ${module.path}`); }
    if (this.selection.module === key) { return; }
    await this.apply({ module: key, variant: defaultVariant(known)?.name ?? null });
  }

  async selectVariant(variantName: string): Promise<void> {
    const resolved = this.catalog.modules.find(candidate => moduleKey(candidate) === this.selection.module);
    if (!resolved) { throw new Error('Selecione um módulo antes do variant.'); }
    if (!resolved.variants.some(variant => variant.name === variantName)) {
      throw new Error(`Variant desconhecido em ${resolved.path}: ${variantName}`);
    }
    await this.apply({ module: this.selection.module, variant: variantName });
  }

  async clear(): Promise<void> { await this.apply({ ...EMPTY_SELECTION }); }

  /** Fluxo de comando "Selecionar módulo". Retorna true se houve escolha. */
  async pickModule(ui: SelectionUi): Promise<boolean> {
    if (this.catalog.modules.length === 0) { throw new Error('Nenhum módulo Android descoberto.'); }
    const multipleRoots = new Set(this.catalog.modules.map(module => module.root)).size > 1;
    const chosen = await ui.pick(this.catalog.modules.map(module => ({
      label: module.path === ':' ? module.name : module.path,
      description: module.type + (module.namespace ? ` · ${module.namespace}` : ''),
      detail: multipleRoots ? module.root : undefined,
      value: module
    })), 'Selecione o módulo Android');
    if (!chosen) { return false; }
    await this.selectModule(chosen);
    return true;
  }

  /** Fluxo de comando "Selecionar variant" para o módulo atual. */
  async pickVariant(ui: SelectionUi): Promise<boolean> {
    const module = this.catalog.modules.find(candidate => moduleKey(candidate) === this.selection.module);
    if (!module) { throw new Error('Selecione um módulo antes do variant.'); }
    const chosen = await ui.pick(module.variants.map(variant => ({
      label: variant.name,
      description: variant.flavors.map(flavor => flavor.name).concat(variant.buildType).filter(Boolean).join(' · '),
      value: variant.name
    })), `Selecione o variant de ${module.path}`);
    if (!chosen) { return false; }
    await this.selectVariant(chosen);
    return true;
  }

  /** Texto para status bar, por exemplo `:app [freeDebug]`. */
  statusText(): string {
    const resolved = this.resolve();
    return resolved ? `${resolved.module.path} [${resolved.variant.name}]` : 'Android: sem módulo';
  }

  private async apply(next: Selection): Promise<void> {
    if (next.module === this.selection.module && next.variant === this.selection.variant) { return; }
    this.selection = next;
    await this.memento.update(this.key, next);
    for (const listener of this.listeners) { listener({ ...next }); }
  }
}

/** UI baseada em `vscode.window.showQuickPick`; o módulo `vscode` é carregado só quando usado. */
export function createVscodeSelectionUi(): SelectionUi {
  return {
    async pick<T>(items: PickItem<T>[], placeHolder: string): Promise<T | undefined> {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const vscode = require('vscode') as typeof import('vscode');
      const picked = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true });
      return picked?.value;
    }
  };
}
