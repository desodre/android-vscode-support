import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ManifestClassReference {
  name: string;
  start: number;
  end: number;
}

export interface ManifestClassDefinition {
  file: string;
  offset: number;
}

const COMPONENT_TAG = /<(application|activity-alias|activity|service|receiver|provider|instrumentation)(?=[\s/>])[^>]*>/g;
const JAVA_NAME = /^\.?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

function visibleXml(source: string): string {
  return source.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, match => ' '.repeat(match.length));
}

/** Only component class attributes are links; intent-filter actions are not local classes. */
export function manifestClassReferenceAt(source: string, offset: number): ManifestClassReference | undefined {
  const visible = visibleXml(source);
  for (const tag of visible.matchAll(COMPONENT_TAG)) {
    const attributes = tag[0].matchAll(/\sandroid:(name|targetActivity)\s*=\s*(["'])([^"']+)\2/g);
    for (const attribute of attributes) {
      if (tag[1] === 'activity-alias' ? attribute[1] !== 'targetActivity' : attribute[1] !== 'name') { continue; }
      if (!JAVA_NAME.test(attribute[3])) { continue; }
      const start = tag.index + attribute.index + attribute[0].indexOf(attribute[3]);
      if (start <= offset && offset < start + attribute[3].length) {
        return { name: attribute[3], start, end: start + attribute[3].length };
      }
    }
  }
  return undefined;
}

/** Resolve local Java/Kotlin component sources in the selected variant's source sets. */
export function findManifestClassDefinitions(
  moduleRoot: string, manifest: string, reference: ManifestClassReference,
  sourceSetNames: readonly string[], namespace?: string | null
): ManifestClassDefinition[] {
  const packageName = /<manifest\b[^>]*\bpackage\s*=\s*(["'])([^"']+)\1/.exec(visibleXml(manifest))?.[2];
  const prefix = namespace || packageName;
  const qualified = reference.name.startsWith('.') ? prefix && prefix + reference.name
    : reference.name.includes('.') ? reference.name : prefix && `${prefix}.${reference.name}`;
  if (!qualified || !JAVA_NAME.test(qualified)) { return []; }
  const parts = qualified.split('.');
  const className = parts.pop();
  if (!className) { return []; }
  const definitions: ManifestClassDefinition[] = [];
  for (const sourceSet of sourceSetNames) {
    if (!/^[A-Za-z][\w]*$/.test(sourceSet)) { continue; }
    for (const sourceDir of ['java', 'kotlin']) {
      for (const extension of ['java', 'kt']) {
        const file = path.join(moduleRoot, 'src', sourceSet, sourceDir, ...parts, `${className}.${extension}`);
        let contents: string;
        try { contents = fs.readFileSync(file, 'utf8'); } catch { continue; }
        const escapedName = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const declaration = new RegExp(`\\b(?:class|object|interface)\\s+${escapedName}\\b`).exec(contents);
        if (declaration) {
          definitions.push({ file, offset: declaration.index + declaration[0].lastIndexOf(className) });
        }
      }
    }
  }
  return definitions;
}
