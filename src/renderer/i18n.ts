import { createInstance } from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';
import { useEffect } from 'react';
import { resolveInterfaceLanguage, validateTranslationCatalog, type TranslationCatalog } from '../shared/interface-language';
import { messageTranslator } from '../shared/ui-messages';

// Static resources only. No Tolgee SDK, credentials, remote scripts or API calls.
const files = import.meta.glob('../../assets/locales/*.json', { eager: true, import: 'default' });
const english = validateTranslationCatalog(files['../../assets/locales/en.json']);
export const catalogs: Record<string, TranslationCatalog> = { en: english };
for (const [file, value] of Object.entries(files)) {
  const language = file.split('/').at(-1)!.replace(/\.json$/, '');
  if (language !== 'en') catalogs[language] = validateTranslationCatalog(value, english);
}
export const interfaceLanguages = Object.keys(catalogs).sort();
export const i18n = createInstance();
void i18n.use(initReactI18next).init({
  resources: Object.fromEntries(Object.entries(catalogs).map(([language, translation]) => [language, { translation }])),
  lng: 'en', fallbackLng: 'en',
  initAsync: false, keySeparator: false, nsSeparator: false,
  returnNull: false, returnEmptyString: false,
  interpolation: { escapeValue: false }, // React escapes all rendered text and attributes.
  react: { useSuspense: false },
});

export function ui(key: string, values?: Record<string, string | number>): string {
  return i18n.t(key, values ?? {}) as string;
}

// Only call at presentation boundaries for launcher-owned messages. Never use
// this for game/catalogue/chat content, raw logs, error codes or protocol parsing.
const translateMessage = messageTranslator(english, ui);
export function uiText(value: string): string;
export function uiText(value: string | undefined): string | undefined;
export function uiText(value: string | undefined): string | undefined {
  if (!value) return value;
  return translateMessage(value);
}

export function useInterfaceLanguage(preference: string | undefined): void {
  useTranslation(undefined, { i18n });
  useEffect(() => {
    const language = resolveInterfaceLanguage(preference ?? 'system', navigator.languages, interfaceLanguages);
    if (language !== i18n.language) void i18n.changeLanguage(language);
  }, [preference]);
  useEffect(() => {
    document.documentElement.lang = i18n.resolvedLanguage ?? 'en';
    document.documentElement.dir = i18n.dir();
  });
}
