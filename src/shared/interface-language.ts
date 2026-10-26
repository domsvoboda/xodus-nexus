/** Interface preferences are independent of Store market and game language. */
export const SYSTEM_LANGUAGE = 'system';
export type TranslationCatalog = Record<string, string>;

export function canonicalLanguage(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 48 || !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(value)) return;
  try { return Intl.getCanonicalLocales(value)[0]; } catch { return; }
}

export function interfaceLanguagePreference(value: unknown): string {
  return value === SYSTEM_LANGUAGE ? value : canonicalLanguage(value) ?? SYSTEM_LANGUAGE;
}

export function resolveInterfaceLanguage(preference: unknown, system: readonly string[], available: readonly string[]): string {
  const supported = new Set(available);
  const preferences = preference === SYSTEM_LANGUAGE || !canonicalLanguage(preference) ? system : [String(preference)];
  for (const candidate of preferences) {
    let language = canonicalLanguage(candidate);
    while (language) {
      if (supported.has(language)) return language;
      const separator = language.lastIndexOf('-');
      language = separator > 0 ? language.slice(0, separator) : undefined;
    }
  }
  return 'en';
}

export function translationPlaceholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g)].map(match => match[1]))].sort();
}

/** Imported resources are plain text, never executable markup or a configuration. */
export function validateTranslationCatalog(value: unknown, english?: TranslationCatalog): TranslationCatalog {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('A translation must be a flat JSON object.');
  const result: TranslationCatalog = Object.create(null) as TranslationCatalog;
  if (Object.keys(value).length > 10000) throw Error('Translation catalog is too large.');
  for (const [key, text] of Object.entries(value)) {
    if (!/^[a-z][a-zA-Z0-9_.]*$/.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) throw Error('Invalid translation key.');
    if (typeof text !== 'string' || !text.trim() || text.length > 12000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw Error(`Invalid translation text: ${key}`);
    if (/[{}]/.test(text.replace(/\{\{[a-zA-Z][a-zA-Z0-9_]*\}\}/g, ''))) throw Error(`Malformed translation placeholder: ${key}`);
    // Rich text, i18next nesting, unescaped interpolation and formatting are not supported.
    if (/<\/?[a-zA-Z][^>]*>|\$t\(|\{\{[\s-]*-|\{\{[^}]*[,{}][^}]*\}\}/.test(text)) throw Error(`Unsupported translation syntax: ${key}`);
    if (english) {
      const source = english[key] ?? english[key.replace(/_(?:zero|one|two|few|many|other)$/, '_other')];
      if (source === undefined) throw Error(`Unknown translation key: ${key}`);
      if (JSON.stringify(translationPlaceholders(text)) !== JSON.stringify(translationPlaceholders(source))) throw Error(`Translation placeholders differ: ${key}`);
    }
    result[key] = text;
  }
  return result;
}
