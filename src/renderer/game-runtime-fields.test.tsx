import {expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {GameRuntimeFields} from './GameRuntimeFields';
import type {InstalledRuntimeFamily} from '../shared/runtime-selection';
const change=()=>{};
const installed:InstalledRuntimeFamily[]=[
 {id:'nexus',label:'Standard',buildId:'a'.repeat(64),sourceCommit:'b'.repeat(40),manifestSha256:'c'.repeat(64)},
 {id:'nexus-cachyos',label:'CachyOS',buildId:'d'.repeat(64),sourceCommit:'e'.repeat(40),manifestSha256:'f'.repeat(64)},
];
it('offers Standard as the default when no verified family is installed, never an unbuilt CachyOS option',()=>{
 const html=renderToStaticMarkup(<GameRuntimeFields value="default" installed={[]} change={change}/>);
 expect(html.match(/<option/g)).toHaveLength(1);expect(html).not.toContain('CachyOS');expect(html).toContain('Standard (default)');
});
it('lists Standard (default) and installed CachyOS as plain per-game choices without a separate-prefix consent step',()=>{
 const html=renderToStaticMarkup(<GameRuntimeFields value="nexus-cachyos" installed={installed} change={change}/>);
 expect(html.match(/<option/g)).toHaveLength(2);
 expect(html).toContain('Standard (default)');expect(html).toContain('>CachyOS</option>');
 expect(html).not.toContain('type="checkbox"');expect(html).not.toContain('required=""');
 expect(html).not.toContain('separate prefix');expect(html).not.toContain('local saves');
});
it('preserves an explicit Standard family choice without inventing a global default toggle',()=>{
 const html=renderToStaticMarkup(<GameRuntimeFields value="nexus" installed={installed} change={change}/>);
 expect(html.match(/<option/g)).toHaveLength(3);
 expect(html).toContain('>Standard</option>');expect(html).toContain('>CachyOS</option>');
});
it('shows a missing persisted selection as unavailable rather than falling back to another runtime',()=>{
 const html=renderToStaticMarkup(<GameRuntimeFields value="nexus-cachyos" installed={[]} change={change}/>);
 expect(html).toMatch(/value="nexus-cachyos" disabled="" selected=""/);expect(html).toContain('CachyOS (unavailable)');
});
