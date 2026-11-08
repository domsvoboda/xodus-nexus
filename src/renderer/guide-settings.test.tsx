import {afterEach,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {SettingsPage} from './App';
import {demoSnapshot} from '../shared/demo-data';
import {i18n} from './i18n';

afterEach(async()=>{await i18n.changeLanguage('en');});

it.each([false,true])('Guide On indicator reflects saved enabled=%s without implying shortcut permission',enabled=>{
 const data=demoSnapshot();data.settings.overlayEnabled=enabled;data.overlayShortcut={state:'requested'};
 const html=renderToStaticMarkup(<SettingsPage data={data} toast={()=>{}}/>);
 expect(html).toContain(`class="guide-state${enabled?' on':''}"`);
 expect(html).toContain(enabled?'>On</span>':'>Off</span>');
 expect(html).not.toContain('Shortcut ready');
 expect(html).toContain('Open friends and chats while playing. Desktop shortcut permissions may be needed; fullscreen support depends on your desktop.');
 expect(html).not.toContain('Requires Python 3, PyGObject, GTK 3 and WebKitGTK 4.1.');
});

it('falls back to the concise English overlay help when a locale only has the old paragraph',async()=>{
 await i18n.changeLanguage('es');
 const html=renderToStaticMarkup(<SettingsPage data={demoSnapshot()} toast={()=>{}}/>);
 expect(html).toContain('Open friends and chats while playing. Desktop shortcut permissions may be needed; fullscreen support depends on your desktop.');
 expect(html).not.toContain('Requiere Python 3');
});
