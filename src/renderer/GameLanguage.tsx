import { gameLanguageOverrides } from '../shared/game-language';
import { ui, i18n } from './i18n';

function label(locale: string): string {
  try { return `${new Intl.DisplayNames([i18n.resolvedLanguage ?? 'en'], { type: 'language' }).of(locale)} (${locale})`; }
  catch { return locale; }
}

export function GameLanguage({ value, locales, onChange }: { value: string; locales: string[]; onChange: (locale: string) => void }) {
  const known = new Set(locales.map(locale => locale.toLowerCase()));
  const overrides = gameLanguageOverrides.filter(locale => !known.has(locale.toLowerCase()));
  const custom = Boolean(value) && !known.has(value.toLowerCase()) && !overrides.some(locale => locale.toLowerCase() === value.toLowerCase());
  return <>
    <label>{ui("ui.game_language_2334975")}<select value={value} onChange={event => onChange(event.target.value)}>
      <option value="">{ui("settings.system_language")}</option>
      {locales.length ? <optgroup label={ui("ui.package_listed_languages_df183fc")}>{locales.map(locale => <option key={locale} value={locale}>{label(locale)}</option>)}</optgroup> : null}
      <optgroup label={ui("ui.language_overrides_support_varies_5d10f28")}>{overrides.map(locale => <option key={locale} value={locale}>{label(locale)}</option>)}</optgroup>
      {custom ? <option value={value}>{label(value)}</option> : null}
    </select></label>
    <small>{ui("ui.package_languages_may_be_incomplete_overrides_re_661a23d")}</small>
  </>;
}
