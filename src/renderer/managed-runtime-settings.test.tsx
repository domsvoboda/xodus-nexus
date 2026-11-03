// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ManagedRuntimeSettings} from './ManagedRuntimeSettings';
import {demoSnapshot} from '../shared/demo-data';
import type {ManagedFamilyStatus} from '../shared/types';
let root:Root,data:ReturnType<typeof demoSnapshot>,busy:ReturnType<typeof vi.fn>;
const offer={version:'runtime-11.0',candidateSha256:'a'.repeat(64),sourceCommit:'b'.repeat(40),archiveName:'nexus-runtime.tar.xz',requiresBackendVersion:'0.2.3',requiresLauncherVersion:'0.5.0'};
const available=(id:'nexus'|'nexus-cachyos'='nexus'):ManagedFamilyStatus=>({id,checking:false,installing:false,available:offer,updateAvailable:true});
const render=async(disabled=false)=>act(async()=>root.render(<ManagedRuntimeSettings data={data} disabled={disabled} onBusyChange={busy}/>));
const click=async(node:Element)=>act(async()=>(node as HTMLElement).click());
const button=(text:string)=>[...document.querySelectorAll('button')].find(node=>node.textContent===text)!;
const checkbox=(text:string)=>[...document.querySelectorAll('label')].find(node=>node.textContent?.includes(text))!.querySelector('input')!;
beforeEach(async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);data=demoSnapshot();data.runtime.managedFamilies=[];busy=vi.fn();
 window.launcher={checkManagedRuntime:vi.fn(async()=>available()),installManagedRuntime:vi.fn(async()=>({family:'nexus',success:true,committed:true,durability:'confirmed'}))} as unknown as Window['launcher'];
 document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root')!);await render();
});
afterEach(async()=>{await act(async()=>root.unmount());vi.restoreAllMocks();vi.unstubAllGlobals();document.body.innerHTML='';});
it('starts simple and performs no discovery or optional installation on render',()=>{
 expect(document.querySelectorAll('.managed-runtime-family')).toHaveLength(1);expect(document.body.textContent).toContain('Not installed');expect(window.launcher.checkManagedRuntime).not.toHaveBeenCalled();expect(window.launcher.installManagedRuntime).not.toHaveBeenCalled();expect(document.body.textContent).toContain('default Wine / Proton selection unchanged');
});
it('checks Standard explicitly then installs the exact captured candidate without selecting games',async()=>{
 await click(button('Check for updates'));expect(window.launcher.checkManagedRuntime).toHaveBeenCalledWith('nexus',{allowCachyos:false,allowPrerelease:false});expect(document.body.textContent).toContain(offer.version);
 await click(button('Install Nexus Runtime'));expect(window.launcher.installManagedRuntime).toHaveBeenCalledWith('nexus',offer.candidateSha256,{allowCachyos:false,allowPrerelease:false});expect(document.querySelector('[role="status"]')?.textContent).toContain('Game family choices and local saves were kept');expect(busy.mock.calls).toEqual([[true],[false],[true],[false]]);
});
it('requires distinct CachyOS and prerelease opt-ins for both API actions',async()=>{
 await click(button('Show experimental CachyOS runtime'));const row=document.querySelector('[aria-label="Nexus Runtime (CachyOS, experimental)"]')!;const check=row.querySelector('button')!;expect(check.disabled).toBe(true);
 await click(checkbox('Allow this optional'));vi.mocked(window.launcher.checkManagedRuntime).mockResolvedValue(available('nexus-cachyos'));
 const prerelease=[...row.querySelectorAll('input')][1];await click(prerelease);await click(check);
 expect(window.launcher.checkManagedRuntime).toHaveBeenCalledWith('nexus-cachyos',{allowCachyos:true,allowPrerelease:true});
 vi.mocked(window.launcher.installManagedRuntime).mockResolvedValue({family:'nexus-cachyos',success:true,committed:true,durability:'confirmed'});await click(row.querySelector('button.primary')!);expect(window.launcher.installManagedRuntime).toHaveBeenCalledWith('nexus-cachyos',offer.candidateSha256,{allowCachyos:true,allowPrerelease:true});
});
it('reports a committed uncertain result as attention, never success or old-runtime-kept',async()=>{
 data.runtime.managedFamilies=[available()];await render();vi.mocked(window.launcher.installManagedRuntime).mockResolvedValue({family:'nexus',success:false,committed:true,durability:'unknown'});
 await click(button('Install Nexus Runtime'));expect(document.querySelector('[role="alert"]')?.textContent).toContain('runtime was activated');expect(document.body.textContent).not.toContain('Runtime family installed.');expect(document.body.textContent).not.toContain('previous runtime was kept');
});
it('discards a held old-root discovery response and releases local busy state',async()=>{
 let resolve!:(value:ManagedFamilyStatus)=>void;vi.mocked(window.launcher.checkManagedRuntime).mockReturnValue(new Promise(done=>resolve=done));await click(button('Check for updates'));
 data={...data,settings:{...data.settings,runtimeRoot:'/new/root'}};await render();await act(async()=>resolve(available()));expect(button('Install Nexus Runtime')).toBeUndefined();expect(busy).toHaveBeenLastCalledWith(false);
});
it('invalidates offered prerelease-policy candidates until a new explicit check',async()=>{
 await click(button('Check for updates'));expect(button('Install Nexus Runtime')).toBeDefined();await click(checkbox('Include prereleases'));expect(button('Install Nexus Runtime')).toBeUndefined();expect(window.launcher.installManagedRuntime).not.toHaveBeenCalled();await click(button('Check for updates'));expect(button('Install Nexus Runtime')).toBeDefined();
});
it('shows installed optional families with their recorded channel and no fresh installation opt-in',async()=>{
 data.runtime.managedFamilies=[{...available('nexus-cachyos'),installed:{id:'nexus-cachyos',label:'CachyOS',buildId:'c'.repeat(64),manifestSha256:'d'.repeat(64),sourceCommit:'e'.repeat(40)},version:'installed-v1',channel:'prerelease',updateAvailable:false}];await render();
 expect(document.querySelectorAll('.managed-runtime-family')).toHaveLength(2);expect(document.body.textContent).not.toContain('Allow this optional');expect(checkbox('Include prereleases').checked).toBe(false);expect(document.querySelector<HTMLInputElement>('[aria-label="Nexus Runtime (CachyOS, experimental)"] input')?.checked).toBe(true);expect(document.body.textContent).toContain('Installed: installed-v1');expect(document.body.textContent).toContain('up to date');expect(button('Update Nexus Runtime (CachyOS, experimental)')).toBeUndefined();expect(window.launcher.checkManagedRuntime).not.toHaveBeenCalled();
});
it('blocks controls during other activity and prevents duplicate held requests',async()=>{
 await render(true);expect(button('Check for updates').disabled).toBe(true);await click(button('Check for updates'));expect(window.launcher.checkManagedRuntime).not.toHaveBeenCalled();await render();let resolve!:(value:ManagedFamilyStatus)=>void;vi.mocked(window.launcher.checkManagedRuntime).mockReturnValue(new Promise(done=>resolve=done));await click(button('Check for updates'));await click(button('Check for updates'));expect(window.launcher.checkManagedRuntime).toHaveBeenCalledOnce();await act(async()=>resolve(available()));
});

it('reuses installed CachyOS opt-in and prerelease channel for an ordinary update',async()=>{
 data.runtime.managedFamilies=[{...available('nexus-cachyos'),installed:{id:'nexus-cachyos',label:'CachyOS',buildId:'c'.repeat(64),manifestSha256:'d'.repeat(64),sourceCommit:'e'.repeat(40)},channel:'prerelease'}];await render();
 vi.mocked(window.launcher.installManagedRuntime).mockResolvedValue({family:'nexus-cachyos',success:true,committed:true,durability:'confirmed'});await click(button('Update Nexus Runtime (CachyOS, experimental)'));expect(window.launcher.installManagedRuntime).toHaveBeenCalledWith('nexus-cachyos',offer.candidateSha256,{allowCachyos:true,allowPrerelease:true});
});

it('uses a later authoritative snapshot instead of retaining a stale locally checked offer',async()=>{
 await click(button('Check for updates'));expect(button('Install Nexus Runtime')).toBeDefined();data.runtime.managedFamilies=[{...available(),installed:{id:'nexus',label:'Nexus',buildId:'c'.repeat(64),manifestSha256:'d'.repeat(64),sourceCommit:offer.sourceCommit},updateAvailable:false}];await render();expect(button('Install Nexus Runtime')).toBeUndefined();expect(document.body.textContent).toContain('up to date');
});
