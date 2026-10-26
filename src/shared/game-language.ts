// Selectable overrides, not a claim that a package includes translations.
export const gameLanguageOverrides = [
  'ar-SA', 'bg-BG', 'cs-CZ', 'da-DK', 'de-DE', 'el-GR', 'en-US', 'en-GB',
  'es-ES', 'es-MX', 'fi-FI', 'fr-FR', 'he-IL', 'hu-HU', 'id-ID', 'it-IT',
  'ja-JP', 'ko-KR', 'nb-NO', 'nl-NL', 'pl-PL', 'pt-BR', 'pt-PT', 'ro-RO',
  'ru-RU', 'sk-SK', 'sv-SE', 'th-TH', 'tr-TR', 'uk-UA', 'vi-VN', 'zh-CN', 'zh-TW',
] as const;

export function normalizeGameLocale(value: string): string {
  const tag = value.trim();
  if (tag.length > 35 || !/^[a-z]{2,3}(?:-[a-z]{4})?(?:-(?:[a-z]{2}|[0-9]{3}))?$/i.test(tag)) {
    throw Error('Enter a language code such as pl-PL, de or zh-Hant.');
  }
  try {
    const locale = new Intl.Locale(tag);
    if (!locale.language || locale.language === 'und') throw Error('A language is required.');
    return locale.baseName;
  }
  catch { throw Error('Invalid game language code.'); }
}

export function windowsGameLocale(value: string): string {
  const locale = new Intl.Locale(normalizeGameLocale(value));
  const expanded = locale.maximize();
  if (!expanded.region) throw Error('This language needs an explicit region code.');
  if (locale.language === 'zh' && locale.script && locale.script !== new Intl.Locale(`zh-${expanded.region}`).maximize().script) {
    throw Error('The Chinese script and region must agree.');
  }
  // Windows uses zh-CN / zh-TW. Other explicit scripts must remain distinct.
  const script = locale.script ?? (['sr', 'az', 'bs', 'uz'].includes(locale.language) ? expanded.script : undefined);
  return [locale.language, locale.language === 'zh' ? undefined : script, expanded.region].filter(Boolean).join('-');
}
