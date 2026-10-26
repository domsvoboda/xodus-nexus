import { describe, expect, it } from 'vitest';
import { canonicalLanguage, interfaceLanguagePreference, resolveInterfaceLanguage, validateTranslationCatalog } from './interface-language';
import { messageTranslator } from './ui-messages';

describe('interface language preferences', () => {
  it('canonicalizes tags without accepting paths, URLs or control data', () => {
    expect(canonicalLanguage('pt-br')).toBe('pt-BR');
    for (const value of [null, 2, {}, '', '../cs', 'en.json', 'https://x.invalid', 'en_US', '__proto__', 'en\n']) {
      expect(canonicalLanguage(value)).toBeUndefined(); expect(interfaceLanguagePreference(value)).toBe('system');
    }
    expect(interfaceLanguagePreference('system')).toBe('system');
  });
  it('negotiates system and region fallbacks, never game language or Store market', () => {
    expect(resolveInterfaceLanguage('system', ['cs-CZ', 'en-US'], ['en', 'cs'])).toBe('cs');
    expect(resolveInterfaceLanguage('pt-BR', ['cs'], ['en', 'pt'])).toBe('pt');
    expect(resolveInterfaceLanguage('fr', ['cs'], ['en', 'cs'])).toBe('en');
    expect(resolveInterfaceLanguage('system', ['ja', 'de-AT'], ['en', 'de'])).toBe('de');
    expect(resolveInterfaceLanguage(undefined, ['ar'], ['en'])).toBe('en');
  });
});

describe('plain-text translation schema', () => {
  const en = { 'hello.user': 'Hello {{name}}', 'count_one': '{{count}} friend', 'count_other': '{{count}} friends', 'save': 'Save' };
  it('accepts incomplete translations, reordered parameters and target plural forms', () => {
    expect(validateTranslationCatalog({ 'hello.user': '{{name}}, ahoj', count_few: '{{count}} přátelé' }, en)).toMatchObject({count_few:'{{count}} přátelé'});
    expect(validateTranslationCatalog({}, en)).toEqual({});
  });
  it.each([
    null, [], { save: '' }, { save: 2 }, { other: 'Unknown' }, { save: '<img src=x>' }, {save:'$t(save)'},
    { 'hello.user': 'Hello' }, { 'hello.user': 'Hello {{token}}' }, { 'hello.user': '{{-name}}' },
    { save: '{{broken' }, { save: 'bad\0text' }, {save:'{name}'}, { save: '{{name, html}}' },
    JSON.parse('{"__proto__":"bad"}'), { constructor: 'bad' },
  ])('rejects unsafe or incompatible catalogue data %j', value => {
    expect(() => validateTranslationCatalog(value, en)).toThrow();
  });
  it('translates only explicitly presented launcher-owned messages', () => {
    const translate = messageTranslator({ saved:'Settings saved.', download:'Downloading {{game}}…' }, (key, values) => `${key}:${values?.game ?? ''}`);
    expect(translate('Settings saved.')).toBe('saved:');
    expect(translate('Downloading Some Game…')).toBe('download:Some Game');
    expect(translate('NEXUS_AUTH_DIAGNOSTIC_V1 account 200')).toBe('NEXUS_AUTH_DIAGNOSTIC_V1 account 200');
    expect(translate('Unknown native failure 0x80004001')).toBe('Unknown native failure 0x80004001');
    expect(translate('Settings saved.\nraw log')).toBe('Settings saved.\nraw log');
  });
});
