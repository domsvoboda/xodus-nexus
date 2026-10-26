import { readdirSync, readFileSync } from 'node:fs';
import { createInstance } from 'i18next';
import { canonicalLanguage, resolveInterfaceLanguage, validateTranslationCatalog, type TranslationCatalog } from '../shared/interface-language.js';
import { messageTranslator } from '../shared/ui-messages.js';

const folder = new URL('../../assets/locales/', import.meta.url);
const english = validateTranslationCatalog(JSON.parse(readFileSync(new URL('en.json', folder), 'utf8')));
const catalogs: Record<string, TranslationCatalog> = { en: english };
for (const name of readdirSync(folder)) {
  if (!name.endsWith('.json') || name === 'en.json') continue;
  const language = name.slice(0, -5);
  if (canonicalLanguage(language) !== language) throw Error('Invalid bundled interface language.');
  catalogs[language] = validateTranslationCatalog(JSON.parse(readFileSync(new URL(name, folder), 'utf8')), english);
}
const i18n = createInstance();
void i18n.init({ resources: Object.fromEntries(Object.entries(catalogs).map(([language, translation]) => [language, { translation }])),
  lng: 'en', fallbackLng: 'en', initAsync: false, keySeparator: false, nsSeparator: false, returnEmptyString: false,
  interpolation: { escapeValue: false } });

export function nativeTranslator(preference: unknown, systemLanguages: readonly string[]) {
  const language = resolveInterfaceLanguage(preference, systemLanguages, Object.keys(catalogs));
  const translate = (key: string, values?: Record<string, string | number>) => i18n.t(key, { ...values, lng: language }) as string;
  return { text: messageTranslator(english, translate), ui: translate };
}
