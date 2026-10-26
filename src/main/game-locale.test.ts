import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { gameLocaleEnvironment, installedGameLocales, installedGameTitleId, manifestLocales, manifestTitleId, supportedGameLocale, systemGameLocale } from './game-locale.js';
import { normalizeGameLocale, windowsGameLocale } from '../shared/game-language.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-languages-')); roots.push(root); return root; }

describe('game locale', () => {
  it('ignores commented locale and title examples, including arrows and terminal escapes', () => {
    const xml = `<Game><!-- example -> \x1b[31m <TitleId>0000</TitleId><Resource Language="fr-FR"/> -->
      <TitleId>6BE4<!-- annotation -->1AB5</TitleId><Resources><Resource Language='en'/>
      <!-- <Resource Language="de-DE"/> --><Resource Language="cs-CZ"/></Resources></Game>`;
    expect(manifestTitleId(xml)).toBe('6BE41AB5');
    expect(manifestLocales(xml)).toEqual(['en', 'cs-CZ']);
    expect(manifestTitleId('<Game><!-- <TitleId>0000</TitleId> --></Game>')).toBeUndefined();
    expect(manifestLocales('<Game><![CDATA[<Resource Language="fr-FR"/>]]></Game>')).toEqual([]);
  });

  const xml = '<Resources><Resource Language="en"/><Resource Language="cs-CZ"/><Resource Language="cs-CZ"/></Resources>';

  it('reads declared languages without duplicates', () => {
    expect(manifestLocales(xml)).toEqual(['en', 'cs-CZ']);
    expect(supportedGameLocale('cs-cz', manifestLocales(xml))).toBe('cs-CZ');
    expect(supportedGameLocale('fr-FR', manifestLocales(xml))).toBe('fr-FR');
  });

  it('reads the title id used for the per-title config directory', () => {
    expect(manifestTitleId('<Game><Identity Name="Microsoft.Fairlightbasegame" /><TitleId>6BE41AB5</TitleId></Game>')).toBe('6BE41AB5');
    expect(manifestTitleId('<TitleId> 6BE41AB5 </TitleId>')).toBe('6BE41AB5');
    expect(manifestTitleId('<Game></Game>')).toBeUndefined();
  });

  it('does not let shell resource hints discard an explicit region or script', () => {
    const locales = ['en', 'cs', 'de'];
    expect(supportedGameLocale('cs-CZ', locales)).toBe('cs-CZ');
    expect(supportedGameLocale('de-DE', locales)).toBe('de-DE');
    expect(supportedGameLocale('pt-PT', ['pt-BR'])).toBe('pt-PT');
    expect(supportedGameLocale('zh-Hant', ['zh-Hans'])).toBe('zh-Hant');
    expect(supportedGameLocale('pl-PL', ['en'])).toBe('pl-PL');
  });

  it('sets Windows and Unix locale only for the selected game', () => {
    const original = { LANG: 'en_US.UTF-8', LC_ALL: 'C.UTF-8' };
    const result = gameLocaleEnvironment(original, 'cs-CZ');
    expect(result).toMatchObject({
      XODUS_PACKAGE_LOCALE: 'cs-CZ',
      WINEUSERLOCALE: 'cs-CZ',
      LANG: 'cs_CZ.UTF-8',
      LC_ALL: 'cs_CZ.UTF-8',
      LC_MESSAGES: 'cs_CZ.UTF-8',
      LC_CTYPE: 'cs_CZ.UTF-8',
      LC_TIME: 'cs_CZ.UTF-8',
      LC_COLLATE: 'cs_CZ.UTF-8',
      LC_MONETARY: 'cs_CZ.UTF-8',
      LC_NUMERIC: 'cs_CZ.UTF-8',
      LC_PAPER: 'cs_CZ.UTF-8',
      LANGUAGE: 'cs_CZ:cs',
    });
    expect(original).toEqual({ LANG: 'en_US.UTF-8', LC_ALL: 'C.UTF-8' });
  });

  it.each([
    ['de', 'de-DE', 'de_DE.UTF-8'], ['pl', 'pl-PL', 'pl_PL.UTF-8'], ['pt-BR', 'pt-BR', 'pt_BR.UTF-8'],
    ['pt-PT', 'pt-PT', 'pt_PT.UTF-8'], ['zh-Hans', 'zh-CN', 'zh_CN.UTF-8'],
    ['zh-Hant', 'zh-TW', 'zh_TW.UTF-8'], ['es-419', 'es-419', 'es_419.UTF-8'],
    ['sr-Latn', 'sr-Latn-RS', 'sr_RS.UTF-8@latin'], ['sr-Cyrl', 'sr-Cyrl-RS', 'sr_RS.UTF-8@cyrillic'],
  ])('resolves %s consistently for package, Wine and Unix', (input, windows, unix) => {
    expect(windowsGameLocale(input)).toBe(windows);
    expect(gameLocaleEnvironment({ LANG: 'en_US.UTF-8' }, input)).toMatchObject({ XODUS_PACKAGE_LOCALE: input, WINEUSERLOCALE: windows, LANG: unix, LC_ALL: unix });
  });

  it.each(['../../pl', 'de\nLANG=fr', 'en_US', 'ms-resource:Language', 'en-x-private', 'en-u-ca-gregory', 'x', '123', 'und', 'und-Latn', 'und-US', 'zh-Hant-CN'])('rejects unsafe or unresolvable override %s', input => {
    expect(() => supportedGameLocale(input)).toThrow();
  });

  it('rejects an absent Intl language instead of turning a locale into a bare region', () => {
    const language = vi.spyOn(Intl.Locale.prototype, 'language', 'get').mockReturnValue(undefined as unknown as string);
    try {
      expect(() => normalizeGameLocale('und')).toThrow();
      expect(() => supportedGameLocale('und-US')).toThrow();
      expect(() => gameLocaleEnvironment({}, 'und-Latn')).toThrow();
    } finally { language.mockRestore(); }
  });

  it('canonicalizes case and never leaks another title override into system default', () => {
    expect(normalizeGameLocale(' PT-br ')).toBe('pt-BR');
    const env = { LANG: 'pl_PL.UTF-8', XODUS_PACKAGE_LOCALE: 'de', WINEUSERLOCALE: 'de-DE' };
    expect(gameLocaleEnvironment(env)).toEqual({ LANG: 'pl_PL.UTF-8' });
    expect(env.WINEUSERLOCALE).toBe('de-DE');
    expect(supportedGameLocale('')).toBeUndefined();
    expect(systemGameLocale({ LC_ALL: 'C.UTF-8', LANG: 'pl_PL.UTF-8' })).toBe('en-US');
    expect(systemGameLocale({ LANG: 'sr_RS.UTF-8@latin' })).toBe('sr-Latn-RS');
    expect(systemGameLocale({ LANG: 'pl_PL.UTF-8' })).toBe('pl-PL');
    expect(systemGameLocale({ LANG: 'unsafe/path' })).toBeUndefined();
  });

  it('reads case-varied Microsoft and Appx manifests, combining hints without duplicates', async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, 'MicrosoftGame.Config'), '<Game><TitleId>1234ABCD</TitleId><Resources><Resource Language="en"/><Resource Language="pl-PL"/></Resources></Game>');
    await fs.writeFile(path.join(root, 'APPXMANIFEST.XML'), '<Package xmlns:r="urn:test"><Resources><r:Resource Language="PL-pl"/><r:Resource Language="de"/><r:Resource Language="ms-resource:Language"/></Resources></Package>');
    expect(await installedGameLocales(root)).toEqual(['en', 'pl-PL', 'de']);
    expect(await installedGameTitleId(root)).toBe('1234ABCD');
    expect(await installedGameLocales(await fixture())).toEqual([]);
  });

  it('refuses ambiguous, oversized, malformed and linked manifests without reading outside the fixture', async () => {
    const root = await fixture(), file = path.join(root, 'MicrosoftGame.config');
    await fs.writeFile(file, '<Game/>');
    await fs.writeFile(path.join(root, 'MicrosoftGame.Config'), '<Game/>');
    await expect(installedGameLocales(root)).rejects.toThrow('Ambiguous');
    await fs.unlink(path.join(root, 'MicrosoftGame.Config'));
    await fs.writeFile(file, 'a'.repeat(1_048_577));
    await expect(installedGameLocales(root)).rejects.toThrow('Unsupported');
    await fs.writeFile(file, '<Game><Resources></Game>');
    await expect(installedGameLocales(root)).rejects.toThrow();
    await fs.unlink(file);
    await fs.symlink(path.join(await fixture(), 'not-read'), file);
    await expect(installedGameLocales(root)).rejects.toThrow();
  });
});
