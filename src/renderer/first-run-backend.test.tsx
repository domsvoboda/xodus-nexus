import {expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {demoSnapshot} from '../shared/demo-data';
import {FirstRunWizard} from './App';
it('prepares sign-in quietly without a backend progress card and blocks it until verification completes',()=>{
 const data=demoSnapshot();data.auth.stored=false;data.backend.available=false;data.backend.updating=true;data.backend.phase='Verifying the backend checksum and archive…';
 const html=renderToStaticMarkup(<FirstRunWizard data={data} toast={()=>{}} />);
 expect(html).not.toContain('Backend setup');expect(html).not.toContain('Verifying the backend checksum');expect(html).toContain('Preparing sign-in');
 expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?>Sign in<\/button>/);
 expect(html).not.toContain('Retry setup');
});
it('offers an explicit backend retry after failure without forcing sign-in or wizard completion',()=>{
 const data=demoSnapshot();data.backend.available=false;data.backend.updating=false;data.backend.checking=false;data.backend.blockReason='Backend download failed.';
 const html=renderToStaticMarkup(<FirstRunWizard data={data} toast={()=>{}} />);
 expect(html).toContain('Retry setup');expect(html).toContain('Backend download failed.');expect(html).toContain('Start using Xodus Nexus');
});
