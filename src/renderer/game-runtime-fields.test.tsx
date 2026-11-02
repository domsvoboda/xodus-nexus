import {gameRuntimeAvailable} from '../shared/runtime-selection';
import {expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {GameRuntimeFields} from './GameRuntimeFields';
const change=()=>{};
it('offers only default when no verified variants are installed, never an unbuilt CachyOS option',()=>{
 const html=renderToStaticMarkup(<GameRuntimeFields value="default" separate={false} installed={[]} change={change} changeSeparate={change}/>);
 expect(html.match(/<option/g)).toHaveLength(1);expect(html).not.toContain('CachyOS');expect(html).toContain('Use default runtime');
});
it('lists verified families with explicit separate-prefix acknowledgment and save warning',()=>{
 const html=renderToStaticMarkup(<GameRuntimeFields value="nexus-cachyos" separate={false} installed={[{id:'nexus-cachyos',label:'Nexus Runtime (CachyOS, experimental)',buildId:'a'.repeat(64),sourceCommit:'b'.repeat(40)}]} change={change} changeSeparate={change}/>);
 expect(html).toContain('experimental');expect(html).toMatch(/type="checkbox" required/);expect(html).toContain('class="check-input"');const help=html.match(/aria-describedby="([^"]+)"/)?.[1];expect(help).toBeTruthy();expect(html).toContain('<small id="'+help+'">');expect(html).toContain('Existing local saves stay in the old prefix');expect(html).not.toContain('checked=""');
});
it('shows a missing persisted selection as disabled rather than falling back',()=>{
 const html=renderToStaticMarkup(<GameRuntimeFields value="nexus-cachyos" separate installed={[]} change={change} changeSeparate={change}/>);
 expect(html).toMatch(/value="nexus-cachyos" disabled="" selected=""/);expect(html).toContain('(unavailable)');
});

it('allows a verified selected family without a default and never borrows default availability for a missing family',()=>{
 const installed=[{id:'nexus-cachyos' as const,label:'Experimental',buildId:'a'.repeat(64),sourceCommit:'b'.repeat(40)}];
 expect(gameRuntimeAvailable('nexus-cachyos',true,false,installed)).toBe(true);
 expect(gameRuntimeAvailable('nexus-cachyos',true,true,[])).toBe(false);
 expect(gameRuntimeAvailable('nexus-cachyos',false,true,installed)).toBe(false);
 expect(gameRuntimeAvailable(undefined,false,true,[])).toBe(true);
});
