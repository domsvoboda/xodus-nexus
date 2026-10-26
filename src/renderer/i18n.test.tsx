import { afterEach, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n, ui, uiText, catalogs } from './i18n';
import { Sidebar, DiagnosticDialog, GameLaunchToolFields, SettingsPage } from './App';
import { GameRemovalContents } from './GameRemovalContents';
import { demoSnapshot } from '../shared/demo-data';
import { defaultLaunchTools } from '../shared/launch-tools';
import { localizedTimeRemaining } from './localized-time';

afterEach(async () => { await i18n.changeLanguage('en'); i18n.removeResourceBundle('cs', 'translation'); i18n.removeResourceBundle('ar', 'translation'); });
function translate(language: string, translation: Record<string, string>) {
  i18n.addResourceBundle(language, 'translation', translation);
  return i18n.changeLanguage(language);
}
it('renders translated navigation offline with English fallback for incomplete languages', async () => {
  await translate('cs', { 'ui.home_3a78695':'Domů', 'ui.settings_74a883a':'Nastavení' });
  const html = renderToStaticMarkup(<Sidebar data={demoSnapshot()} page="home" go={() => {}} />);
  expect(html).toContain('Domů'); expect(html).toContain('Nastavení'); expect(html).toContain('My Library');
  expect(ui('friends.invitation_count', {count:1})).toBe('1 game invitation');
  expect(ui('friends.invitation_count', {count:3})).toBe('3 game invitations');
});
it('supports genuine target-language plural categories and parameter reordering', async () => {
  await translate('cs', {'friends.invitation_count_one':'{{count}} pozvánka','friends.invitation_count_few':'{{count}} pozvánky','friends.invitation_count_other':'{{count}} pozvánek', 'common.remove_game':'{{game}}, odstranit?'});
  expect(ui('friends.invitation_count', {count:1})).toBe('1 pozvánka');
  expect(ui('friends.invitation_count', {count:3})).toBe('3 pozvánky');
  expect(ui('friends.invitation_count', {count:5})).toBe('5 pozvánek');
  const data=demoSnapshot(); data.games[0].title='<img src=x onerror=bad>';
  const html=renderToStaticMarkup(<GameRemovalContents game={data.games[0]} busy={false} close={()=>{}} remove={()=>{}} />);
  expect(html).toContain('&lt;img src=x onerror=bad&gt;, odstranit?'); expect(html).not.toContain('<img src=x');
});
it('keeps raw logs, game names, settings keys and launch arguments untranslated', async () => {
  await translate('cs', {'ui.settings_74a883a':'Nastavení', 'ui.copy_log_99d7297':'Kopírovat', 'ui.launch_options_5dfe538':'Volby spuštění'});
  const raw='NEXUS_AUTH_DIAGNOSTIC_V1 account 200\nSettings saved.\n0x80004001';
  const html=renderToStaticMarkup(<DiagnosticDialog log={{name:'raw.log',content:raw,truncated:false}} close={()=>{}} />);
  expect(html).toContain(raw); expect(html).toContain('Kopírovat');
  const fields=renderToStaticMarkup(<GameLaunchToolFields value={{...defaultLaunchTools,launchOptions:'LANG=en_US.UTF-8 %command% --launcher-skip'}} change={()=>{}} />);
  expect(fields).toContain('Volby spuštění'); expect(fields).toContain('LANG=en_US.UTF-8 %command% --launcher-skip');
  const data=demoSnapshot(), before=JSON.stringify(data);
  renderToStaticMarkup(<SettingsPage data={data} toast={()=>{}} />);
  expect(JSON.stringify(data)).toBe(before);
});
it('localizes safe IPC guidance, not unknown diagnostic text', async () => {
  const key=Object.keys(catalogs.en).find(key=>catalogs.en[key]==='Xbox requires sign-in again. Open Settings to check your account.')!;
  await translate('cs', {[key]:'Přihlas se znovu v Nastavení.'});
  expect(uiText('Xbox requires sign-in again. Open Settings to check your account.')).toBe('Přihlas se znovu v Nastavení.');
  expect(uiText('native_error 0xC0000005')).toBe('native_error 0xC0000005');
  expect(uiText(undefined)).toBeUndefined();
});
it('supports direction metadata and keeps elapsed-time parsing separate', async () => {
  await translate('ar', {'time.minutes_left':'باقي {{count}} د'});
  expect(i18n.dir()).toBe('rtl'); expect(localizedTimeRemaining('~4m left')).toBe('باقي 4 د');
  expect(localizedTimeRemaining('unknown diagnostic')).toBe('unknown diagnostic');
  expect(localizedTimeRemaining(undefined)).toBeUndefined();
});
