import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';

export interface ResourceReference {
  type: string;
  name: string;
  start: number;
  end: number;
  declaration: boolean;
}

export interface ResourceDefinition {
  type: string;
  name: string;
  file: string;
  offset: number;
}

export interface XmlResourceSupport extends vscode.Disposable { refresh(): void }

/** Finds references while preserving source offsets and ignoring XML comments/CDATA. */
export function xmlReferences(source: string): ResourceReference[] {
  const visible = source.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, match => ' '.repeat(match.length));
  const references: ResourceReference[] = [];
  const pattern = /@(\+)?(?:(\*?android):)?([A-Za-z][\w]*)\/([A-Za-z][\w.]*)/g;
  for (const match of visible.matchAll(pattern)) {
    if (match[2]) { continue; }
    references.push({ type: match[3], name: match[4], start: match.index, end: match.index + match[0].length, declaration: Boolean(match[1]) && match[3] === 'id' });
  }
  return references;
}

/** The source set containing a manifest or resource file identifies its Android module. */
export function androidModuleRoot(file: string): string | undefined {
  let directory = path.dirname(path.resolve(file));
  while (directory !== path.dirname(directory)) {
    if (path.basename(path.dirname(directory)) === 'src') { return path.dirname(path.dirname(directory)); }
    directory = path.dirname(directory);
  }
  return undefined;
}

function add(index: Map<string, ResourceDefinition[]>, definition: ResourceDefinition): void {
  const key = `${definition.type}/${definition.name}`;
  const existing = index.get(key) ?? [];
  existing.push(definition);
  index.set(key, existing);
}

function namedAttribute(tag: string, attribute: string): { value: string; offset: number } | undefined {
  const pattern = new RegExp(`(?:^|\\s)${attribute}\\s*=\\s*(["'])([^"']+)\\1`);
  const match = pattern.exec(tag);
  return match ? { value: match[2], offset: match.index + match[0].indexOf(match[2]) } : undefined;
}

function indexValuesXml(index: Map<string, ResourceDefinition[]>, file: string, source: string): void {
  const visible = source.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, match => ' '.repeat(match.length));
  const typeByTag: Record<string, string> = {
    'string-array': 'array', 'integer-array': 'array', array: 'array', bool: 'bool', color: 'color',
    dimen: 'dimen', drawable: 'drawable', fraction: 'fraction', id: 'id', integer: 'integer',
    plurals: 'plurals', string: 'string', style: 'style', attr: 'attr', 'declare-styleable': 'styleable'
  };
  const tags = /<([A-Za-z][\w-]*)\b[^>]*>/g;
  for (const match of visible.matchAll(tags)) {
    const name = namedAttribute(match[0], 'name');
    if (!name) { continue; }
    const type = match[1] === 'item' ? namedAttribute(match[0], 'type')?.value : typeByTag[match[1]];
    if (type && /^[A-Za-z][\w-]*$/.test(type)) {
      add(index, { type, name: name.value, file, offset: match.index + name.offset });
    }
  }
}

/** Indexes resource definitions across all source sets of one module, including qualified res directories. */
export function indexModuleResources(
  moduleRoot: string, overlay?: { file: string; source: string }, sourceSetNames?: readonly string[]
): Map<string, ResourceDefinition[]> {
  const index = new Map<string, ResourceDefinition[]>();
  const readSource = (file: string): string => overlay?.file === file ? overlay.source : fs.readFileSync(file, 'utf8');
  const sources = path.join(moduleRoot, 'src');
  let sourceSets: fs.Dirent[];
  try { sourceSets = fs.readdirSync(sources, { withFileTypes: true }); } catch { return index; }
  for (const sourceSet of sourceSets.filter(entry => entry.isDirectory() &&
    (!sourceSetNames || sourceSetNames.includes(entry.name))).sort((a, b) => a.name.localeCompare(b.name))) {
    const res = path.join(sources, sourceSet.name, 'res');
    let directories: fs.Dirent[];
    try { directories = fs.readdirSync(res, { withFileTypes: true }); } catch { continue; }
    for (const directory of directories.filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const type = directory.name.split('-')[0];
      const resourceDir = path.join(res, directory.name);
      let files: fs.Dirent[];
      try { files = fs.readdirSync(resourceDir, { withFileTypes: true }); } catch { continue; }
      for (const entry of files.filter(item => item.isFile()).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(resourceDir, entry.name);
        if (type === 'values') {
          if (!entry.name.endsWith('.xml')) { continue; }
          try { indexValuesXml(index, file, readSource(file)); } catch { /* A single unreadable file must not hide the module. */ }
        } else if (entry.name.includes('.')) {
          const name = entry.name.replace(/\.9\.png$/, '').replace(/\.[^.]+$/, '');
          add(index, { type, name, file, offset: 0 });
        }
      }
    }
  }
  // @+id in layout/menu XML files also creates a resource definition.
  for (const definitions of [...index.values()]) {
    for (const definition of definitions) {
      if (!definition.file.endsWith('.xml') || definition.type === 'id') { continue; }
      let source: string;
      try { source = readSource(definition.file); } catch { continue; }
      for (const reference of xmlReferences(source).filter(item => item.type === 'id' && item.declaration)) {
        add(index, { type: 'id', name: reference.name, file: definition.file, offset: reference.start });
      }
    }
  }
  return index;
}

export function unresolvedXmlReferences(source: string, index: Map<string, ResourceDefinition[]>): ResourceReference[] {
  return xmlReferences(source).filter(reference => !reference.declaration && !index.has(`${reference.type}/${reference.name}`));
}

function referenceAt(source: string, offset: number): ResourceReference | undefined {
  return xmlReferences(source).find(reference => reference.start <= offset && offset < reference.end);
}

/** Recognizes local `R.type.name` uses in Kotlin/Java without claiming framework `android.R`. */
export function codeResourceReferenceAt(source: string, offset: number): ResourceReference | undefined {
  const pattern = /\bR\.([A-Za-z]\w*)\.([A-Za-z]\w*)\b/g;
  for (const match of source.matchAll(pattern)) {
    if (source.slice(0, match.index).endsWith('android.')) { continue; }
    if (match.index <= offset && offset < match.index + match[0].length) {
      return { type: match[1], name: match[2], start: match.index, end: match.index + match[0].length, declaration: false };
    }
  }
  return undefined;
}

function xmlDocument(document: vscode.TextDocument): boolean {
  return document.uri.scheme === 'file' && document.uri.fsPath.endsWith('.xml') && Boolean(androidModuleRoot(document.uri.fsPath));
}

/** Registers go-to-definition and missing-resource diagnostics for Android XML documents. */
export function registerAndroidXmlResourceSupport(
  getSourceSets?: (moduleRoot: string) => readonly string[] | undefined
): XmlResourceSupport {
  // Keep the indexer usable in plain Node tests; VS Code is loaded only on activation.
  const vscode: typeof import('vscode') = require('vscode');
  const diagnostics = vscode.languages.createDiagnosticCollection('androidResources');
  const update = (document: vscode.TextDocument): void => {
    if (!xmlDocument(document)) { return; }
    const root = androidModuleRoot(document.uri.fsPath);
    if (!root) { return; }
    const enabled = vscode.workspace.getConfiguration('androidSupport').get<boolean>('xmlLocalResourceDiagnostics', false);
    if (!enabled) { diagnostics.delete(document.uri); return; }
    const missing = unresolvedXmlReferences(document.getText(),
      indexModuleResources(root, { file: document.uri.fsPath, source: document.getText() }, getSourceSets?.(root)));
    diagnostics.set(document.uri, missing.map(reference => {
      const range = new vscode.Range(document.positionAt(reference.start), document.positionAt(reference.end));
      const diagnostic = new vscode.Diagnostic(range,
        `Recurso não encontrado neste módulo: @${reference.type}/${reference.name} (pode vir de dependência)`,
        vscode.DiagnosticSeverity.Warning);
      diagnostic.code = 'android-resource-missing';
      return diagnostic;
    }));
  };
  const refreshOpen = (): void => { for (const document of vscode.workspace.textDocuments) { update(document); } };
  const watcher = vscode.workspace.createFileSystemWatcher('**/src/*/res/**');
  const definitionsFor = (document: vscode.TextDocument, reference: ResourceReference): vscode.Location[] => {
    const root = androidModuleRoot(document.uri.fsPath);
    if (!root) { return []; }
    const definitions = indexModuleResources(root, { file: document.uri.fsPath, source: document.getText() },
      getSourceSets?.(root)).get(`${reference.type}/${reference.name}`);
    if (!definitions?.length) { return []; }
    return definitions.flatMap(definition => {
      const target = vscode.Uri.file(definition.file);
      let source: string;
      try { source = definition.file === document.uri.fsPath ? document.getText() : fs.readFileSync(definition.file, 'utf8'); }
      catch { return []; }
      const before = source.slice(0, definition.offset);
      const line = before.split('\n').length - 1;
      const character = definition.offset - before.lastIndexOf('\n') - 1;
      return [new vscode.Location(target, new vscode.Position(line, character))];
    });
  };
  const provider = vscode.languages.registerDefinitionProvider({ scheme: 'file', pattern: '**/*.xml' }, {
    provideDefinition(document, position) {
      if (!xmlDocument(document)) { return undefined; }
      const reference = referenceAt(document.getText(), document.offsetAt(position));
      return reference ? definitionsFor(document, reference) : undefined;
    }
  });
  const codeProvider = vscode.languages.registerDefinitionProvider([
    { scheme: 'file', language: 'kotlin' }, { scheme: 'file', language: 'java' }
  ], {
    provideDefinition(document, position) {
      const reference = codeResourceReferenceAt(document.getText(), document.offsetAt(position));
      return reference ? definitionsFor(document, reference) : undefined;
    }
  });
  const subscriptions: vscode.Disposable[] = [
    diagnostics, watcher, provider, codeProvider,
    vscode.workspace.onDidOpenTextDocument(update),
    vscode.workspace.onDidChangeTextDocument(event => update(event.document)),
    vscode.workspace.onDidSaveTextDocument(update),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('androidSupport.xmlLocalResourceDiagnostics')) { refreshOpen(); }
    }),
    vscode.workspace.onDidCloseTextDocument(document => diagnostics.delete(document.uri)),
    watcher.onDidCreate(refreshOpen), watcher.onDidChange(refreshOpen), watcher.onDidDelete(refreshOpen)
  ];
  refreshOpen();
  return Object.assign(new vscode.Disposable(() => {
    for (const subscription of subscriptions) { subscription.dispose(); }
  }), { refresh: refreshOpen });
}
