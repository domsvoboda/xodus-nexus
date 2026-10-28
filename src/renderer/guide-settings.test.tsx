import {expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {SettingsPage} from './App';
import {demoSnapshot} from '../shared/demo-data';

it.each([false,true])('Guide On indicator reflects saved enabled=%s without implying shortcut permission',enabled=>{
 const data=demoSnapshot();data.settings.overlayEnabled=enabled;data.overlayShortcut={state:'requested'};
 const html=renderToStaticMarkup(<SettingsPage data={data} toast={()=>{}}/>);
 expect(html).toContain(`class="guide-state${enabled?' on':''}"`);
 expect(html).toContain(enabled?'>On</span>':'>Off</span>');
 expect(html).not.toContain('Shortcut ready');
});
