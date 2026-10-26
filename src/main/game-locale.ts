import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeGameLocale, windowsGameLocale } from '../shared/game-language.js';
import { parsePackageXml } from './package-xml.js';
import { manifestAttribute, manifestElements, manifestText } from './manifest-xml.js';

const MANIFEST_LIMIT = 1_048_576;

async function readManifest(directory: string, filename: string): Promise<string> {
  const names = (await fs.readdir(directory)).filter(name => name.toLowerCase() === filename.toLowerCase());
  if (!names.length) return '';
  if (names.length !== 1) throw Error('Ambiguous game language manifest.');
  const handle = await fs.open(path.join(directory, names[0]), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MANIFEST_LIMIT) throw Error('Unsupported game language manifest.');
    const buffer = Buffer.alloc(MANIFEST_LIMIT + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > MANIFEST_LIMIT) throw Error('Game language manifest is too large.');
    return buffer.subarray(0, size).toString('utf8');
  } finally { await handle.close(); }
}

export async function installedGameLocales(directory: string): Promise<string[]> {
  const found = new Set<string>();
  for (const file of ['MicrosoftGame.config', 'AppxManifest.xml']) {
    for (const locale of manifestLocales(await readManifest(directory, file))) found.add(locale);
  }
  return [...found];
}

export async function installedGameTitleId(directory: string): Promise<string | undefined> {
  return manifestTitleId(await readManifest(directory, 'MicrosoftGame.config'));
}

export function manifestLocales(xml: string): string[] {
  const found = new Set<string>();
  for (const tag of manifestElements(xml ? parsePackageXml(xml) : undefined, 'Resource')) {
    const locale = manifestAttribute(tag, 'Language');
    if (locale) {
      try { found.add(normalizeGameLocale(locale)); }
      catch { /* Resource placeholders are not locale overrides. */ }
    }
  }
  return [...found];
}

export function manifestTitleId(xml: string): string | undefined {
  const value = manifestText(xml ? parsePackageXml(xml) : undefined, 'TitleId');
  return value && /^[0-9A-Fa-f]+$/.test(value) ? value : undefined;
}

export function supportedGameLocale(requested: string, locales: string[] = []): string | undefined {
  if (!requested.trim()) return undefined;
  const normalized = normalizeGameLocale(requested);
  windowsGameLocale(normalized);
  // Resources localize shell visuals, not necessarily every game translation.
  return locales.find(locale => locale.toLowerCase() === normalized.toLowerCase()) ?? normalized;
}

export function gameLocaleEnvironment(source: NodeJS.ProcessEnv, locale?: string): NodeJS.ProcessEnv {
  const environment = { ...source };
  delete environment.XODUS_PACKAGE_LOCALE;
  delete environment.WINEUSERLOCALE;
  if (!locale) return environment;
  const tag = normalizeGameLocale(locale);
  const windows = windowsGameLocale(tag);
  const resolved = new Intl.Locale(windows);
  const script = resolved.script === 'Latn' ? 'latin' : resolved.script === 'Cyrl' ? 'cyrillic' : resolved.script?.toLowerCase();
  const modifier = script ? `@${script}` : '';
  const unix = `${resolved.language}_${resolved.region}.UTF-8${modifier}`;
  Object.assign(environment, { XODUS_PACKAGE_LOCALE: tag, WINEUSERLOCALE: windows, LANG: unix,
    LANGUAGE: `${resolved.language}_${resolved.region}${modifier}:${resolved.language}` });
  for (const key of ['LC_ALL', 'LC_MESSAGES', 'LC_CTYPE', 'LC_TIME', 'LC_COLLATE', 'LC_MONETARY', 'LC_NUMERIC', 'LC_PAPER']) environment[key] = unix;
  return environment;
}

export function systemGameLocale(environment: NodeJS.ProcessEnv): string | undefined {
  const value = environment.LC_ALL || environment.LC_MESSAGES || environment.LANG;
  if (value === 'C' || value === 'POSIX' || value?.startsWith('C.')) return 'en-US';
  try {
    const base = value?.split(/[.@]/)[0].replaceAll('_', '-');
    const script = value?.endsWith('@latin') ? 'Latn' : value?.endsWith('@cyrillic') ? 'Cyrl' : undefined;
    const parsed = base ? new Intl.Locale(base) : undefined;
    const tag = parsed && script ? `${parsed.language}-${script}${parsed.region ? `-${parsed.region}` : ''}` : base;
    return windowsGameLocale(tag || Intl.DateTimeFormat().resolvedOptions().locale);
  } catch { return undefined; }
}
