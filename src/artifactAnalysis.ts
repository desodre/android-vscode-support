import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { BuiltArtifact } from './gradle/artifacts';

export interface ZipEntry {
  name: string;
  compressedSize: number;
  size: number;
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL_ENTRY = 0x02014b50;
const MAX_U32 = 0xffffffff;

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const read = readSync(fd, buffer, 0, length, position);
  return buffer.subarray(0, read);
}

/** Lists entries from the ZIP central directory (APK and AAB are ZIP files), without reading their contents. */
export function readZipEntries(file: string): ZipEntry[] {
  const fd = openSync(file, 'r');
  try {
    const fileSize = statSync(file).size;
    const tailLength = Math.min(fileSize, 22 + 0xffff);
    const tail = readAt(fd, fileSize - tailLength, tailLength);
    let eocd = -1;
    for (let index = tail.length - 22; index >= 0; index--) {
      if (tail.readUInt32LE(index) === EOCD) { eocd = index; break; }
    }
    if (eocd < 0) { throw new Error(`${basename(file)} não é um arquivo ZIP válido.`); }
    let count = tail.readUInt16LE(eocd + 10);
    let directorySize = tail.readUInt32LE(eocd + 12);
    let directoryOffset = tail.readUInt32LE(eocd + 16);
    if (directoryOffset === MAX_U32 || directorySize === MAX_U32 || count === 0xffff) {
      const locator = eocd - 20;
      if (locator < 0 || tail.readUInt32LE(locator) !== ZIP64_LOCATOR) { throw new Error('Diretório ZIP64 inválido.'); }
      const record = readAt(fd, Number(tail.readBigUInt64LE(locator + 8)), 56);
      if (record.readUInt32LE(0) !== ZIP64_EOCD) { throw new Error('Diretório ZIP64 inválido.'); }
      count = Number(record.readBigUInt64LE(32));
      directorySize = Number(record.readBigUInt64LE(40));
      directoryOffset = Number(record.readBigUInt64LE(48));
    }
    const directory = readAt(fd, directoryOffset, directorySize);
    const entries: ZipEntry[] = [];
    let offset = 0;
    for (let index = 0; index < count; index++) {
      if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== CENTRAL_ENTRY) {
        throw new Error('Diretório central do ZIP corrompido.');
      }
      let compressedSize = directory.readUInt32LE(offset + 20);
      let size = directory.readUInt32LE(offset + 24);
      const nameLength = directory.readUInt16LE(offset + 28);
      const extraLength = directory.readUInt16LE(offset + 30);
      const commentLength = directory.readUInt16LE(offset + 32);
      const name = directory.toString('utf8', offset + 46, offset + 46 + nameLength);
      if (size === MAX_U32 || compressedSize === MAX_U32) {
        // ZIP64 extra field (id 1) holds the 64-bit sizes, uncompressed first, only for the fields set to 0xFFFFFFFF.
        const extra = directory.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
        for (let cursor = 0; cursor + 4 <= extra.length;) {
          const id = extra.readUInt16LE(cursor);
          const length = extra.readUInt16LE(cursor + 2);
          if (id === 1) {
            let field = cursor + 4;
            if (size === MAX_U32) { size = Number(extra.readBigUInt64LE(field)); field += 8; }
            if (compressedSize === MAX_U32) { compressedSize = Number(extra.readBigUInt64LE(field)); }
            break;
          }
          cursor += 4 + length;
        }
      }
      if (!name.endsWith('/')) { entries.push({ name, compressedSize, size }); }
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    closeSync(fd);
  }
}

const CATEGORIES: Array<[string, RegExp]> = [
  ['Código (DEX)', /(^|\/)(dex\/|classes\d*\.dex$)/],
  ['Bibliotecas nativas', /(^|\/)lib\//],
  ['Recursos', /(^|\/)res\//],
  ['Tabela de recursos', /(^|\/)resources\.(arsc|pb)$/],
  ['Assets', /(^|\/)assets\//],
  ['Manifesto', /(^|\/)(manifest\/)?AndroidManifest\.xml$/],
  ['Assinatura e metadados', /^(META-INF|BUNDLE-METADATA)\/|^BundleConfig\.pb$/],
];

export interface SizeCategory {
  category: string;
  files: number;
  compressedSize: number;
  size: number;
}

/** Groups entries by kind, largest compressed size first. */
export function summarizeEntries(entries: readonly ZipEntry[]): SizeCategory[] {
  const totals = new Map<string, SizeCategory>();
  for (const entry of entries) {
    const category = CATEGORIES.find(([, pattern]) => pattern.test(entry.name))?.[0] ?? 'Outros';
    const total = totals.get(category) ?? { category, files: 0, compressedSize: 0, size: 0 };
    total.files++;
    total.compressedSize += entry.compressedSize;
    total.size += entry.size;
    totals.set(category, total);
  }
  return [...totals.values()].sort((a, b) => b.compressedSize - a.compressedSize);
}

export interface Badging {
  packageName?: string;
  versionCode?: string;
  versionName?: string;
  minSdk?: string;
  targetSdk?: string;
  label?: string;
  launchableActivity?: string;
  debuggable: boolean;
  permissions: string[];
  nativeCode: string[];
}

/** Parses `aapt2 dump badging` output. */
export function parseBadging(output: string): Badging {
  const result: Badging = { debuggable: false, permissions: [], nativeCode: [] };
  // aapt2 prints empty quotes for attributes the manifest does not set.
  const value = (line: string, key: string) => new RegExp(`\\b${key}='([^']*)'`).exec(line)?.[1] || undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('package:')) {
      result.packageName = value(line, 'name');
      result.versionCode = value(line, 'versionCode');
      result.versionName = value(line, 'versionName');
    } else if (line.startsWith('sdkVersion:') || line.startsWith('minSdkVersion:')) {
      result.minSdk = /'([^']*)'/.exec(line)?.[1];
    } else if (line.startsWith('targetSdkVersion:')) {
      result.targetSdk = /'([^']*)'/.exec(line)?.[1];
    } else if (line.startsWith('application-label:')) {
      result.label = /'([^']*)'/.exec(line)?.[1];
    } else if (line.startsWith('launchable-activity:')) {
      result.launchableActivity = value(line, 'name');
    } else if (line.trim() === 'application-debuggable') {
      result.debuggable = true;
    } else if (line.startsWith('uses-permission:')) {
      const permission = value(line, 'name');
      if (permission) { result.permissions.push(permission); }
    } else if (line.startsWith('native-code:')) {
      result.nativeCode = [...line.matchAll(/'([^']*)'/g)].map(match => match[1]);
    }
  }
  return result;
}

/** aapt2 from the newest build-tools that has it. */
export function findAapt2(sdk: string): string | undefined {
  const root = join(sdk, 'build-tools');
  if (!existsSync(root)) { return undefined; }
  const binary = process.platform === 'win32' ? 'aapt2.exe' : 'aapt2';
  const numeric = (version: string) => version.split(/[.-]/).map(part => Number.parseInt(part, 10) || 0);
  const versions = readdirSync(root).sort((a, b) => {
    const left = numeric(a);
    const right = numeric(b);
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
      const difference = (right[index] ?? 0) - (left[index] ?? 0);
      if (difference) { return difference; }
    }
    return 0;
  });
  return versions.map(version => join(root, version, binary)).find(file => existsSync(file));
}

export function dumpBadging(aapt2: string, apk: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(aapt2, ['dump', 'badging', apk], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, signal },
      (error, stdout, stderr) => error ? reject(new Error(`aapt2 falhou: ${stderr.trim() || error.message}`)) : resolve(stdout));
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) { return `${bytes} B`; }
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** Text report with size by category and, for APKs, the manifest metadata read by aapt2. */
export function formatArtifactReport(artifact: BuiltArtifact, fileSize: number, entries: readonly ZipEntry[],
  badging: Badging | undefined, badgingProblem?: string): string {
  const lines = [
    `Análise de ${artifact.type}: ${artifact.file}`,
    `Variante: ${artifact.variant}${artifact.filters.length ? ` · ${artifact.filters.map(filter => `${filter.filterType}: ${filter.value}`).join(', ')}` : ''}`,
    `Tamanho do arquivo: ${formatBytes(fileSize)} · ${entries.length} arquivo(s) internos`,
    '',
    'Conteúdo (compactado / descompactado):',
  ];
  for (const category of summarizeEntries(entries)) {
    lines.push(`- ${category.category}: ${formatBytes(category.compressedSize)} / ${formatBytes(category.size)} (${category.files})`);
  }
  lines.push('');
  if (badging) {
    lines.push(
      'Manifesto:',
      `- applicationId: ${badging.packageName ?? 'desconhecido'}`,
      `- versão: ${badging.versionName ?? 'não definida'} (código ${badging.versionCode ?? 'não definido'})`,
      `- minSdk: ${badging.minSdk ?? '?'} · targetSdk: ${badging.targetSdk ?? '?'}`,
      `- depurável: ${badging.debuggable ? 'sim' : 'não'}`,
      `- Activity inicial: ${badging.launchableActivity ?? 'nenhuma'}`,
      `- ABIs nativas: ${badging.nativeCode.join(', ') || 'nenhuma'}`,
      `- permissões (${badging.permissions.length}): ${badging.permissions.join(', ') || 'nenhuma'}`,
    );
  } else {
    lines.push(`Manifesto: ${badgingProblem ?? 'não analisado.'}`);
  }
  return lines.join('\n');
}
