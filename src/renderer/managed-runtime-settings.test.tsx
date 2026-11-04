// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ManagedRuntimeSettings} from './ManagedRuntimeSettings';
import {demoSnapshot} from '../shared/demo-data';
import type {ManagedFamilyStatus,ManagedFamilyInstallResult} from '../shared/types';
let root:Root,data:ReturnType<typeof demoSnapshot>,busy:ReturnType<typeof vi.fn>;
const offer={version:'runtime-cachyos-11.0',candidateSha256:'a'.repeat(64),sourceCommit:'b'.repeat(40),archiveName:'nexus-runtime-cachyos-x86_64.tar.xz',requiresBackendVersion:'0.2.3',requiresLauncherVersion:'0.5.0'};
const build={id:'nexus-cachyos' as const,label:'CachyOS',buildId:'c'.repeat(64),manifestSha256:'d'.repeat(64),sourceCommit:'e'.repeat(40),displayWinePath:'/managed/cachyos/files/bin/wine'};
const available=():ManagedFamilyStatus=>({id:'nexus-cachyos',checking:false,installing:false,available:offer,updateAvailable:true});
const installed=(channel:'stable'|'prerelease'='stable',updateAvailable=false):ManagedFamilyStatus=>({...available(),installed:build,version:'runtime-cachyos-10.0',channel,updateAvailable});
const standard:ManagedFamilyStatus={id:'nexus',checking:false,installing:false,installed:{...build,id:'nexus',label:'Standard'},version:'runtime-10.0',channel:'stable',updateAvailable:false};
const activeCachy={...demoSnapshot().runtime,installed:true,name:'nexus-runtime-cachyos-11.0-experimental-ge36f73cb-local',winePath:'/local/cachyos/files/bin/wine',commit:'runtime-cachyos-11.0-experimental-ge36f73cb-local'};
const render=async(disabled=false)=>act(async()=>root.render(<ManagedRuntimeSettings data={data} disabled={disabled} onBusyChange={busy}/>));
const text=()=>document.body.textContent??'';
const card=()=>document.querySelector<HTMLElement>('section.settings-card.managed-runtime-settings')!;
const button=(label:string)=>[...document.querySelectorAll('button')].find(node=>node.textContent===label) as HTMLButtonElement|undefined;
const click=async(node:Element|undefined)=>{expect(node).toBeDefined();await act(async()=>(node as HTMLElement).click());};
const alerts=()=>[...document.querySelectorAll('[role="alert"]')].map(node=>node.textContent??'').join(' ');
beforeEach(async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);data=demoSnapshot();data.runtime.managedFamilies=[];busy=vi.fn();
 window.launcher={checkManagedRuntime:vi.fn(async()=>available()),installManagedRuntime:vi.fn(async():Promise<ManagedFamilyInstallResult>=>({family:'nexus-cachyos',success:true,committed:true,durability:'confirmed'}))} as unknown as Window['launcher'];
 document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root')!);await render();
});
afterEach(async()=>{await act(async()=>root.unmount());vi.restoreAllMocks();vi.unstubAllGlobals();document.body.innerHTML='';});
it('renders one concise CachyOS card with no experimental text, prerelease control or help paragraph',()=>{
 expect(document.querySelectorAll('section.settings-card.managed-runtime-settings')).toHaveLength(1);
 expect(document.querySelectorAll('h3,.managed-runtime-family,input[type="checkbox"]')).toHaveLength(0);
 expect([...document.querySelectorAll('h2')].map(node=>node.textContent)).toEqual(['CachyOS runtime']);
 expect(text().toLowerCase()).not.toContain('experimental');
 expect(card().querySelector('.status-label.unknown')?.textContent).toContain('Not installed');
 expect(button('Install CachyOS runtime')).toBeUndefined();
 expect(text()).toContain('CachyOS binary');expect(text()).toContain('The optional managed CachyOS family is not installed.');
 expect(card().querySelector('[data-cachyos-binary="missing"]')).not.toBeNull();
 expect(window.launcher.checkManagedRuntime).not.toHaveBeenCalled();expect(window.launcher.installManagedRuntime).not.toHaveBeenCalled();
});
it('never infers an installed family from a Standard snapshot or an unrelated default runtime',async()=>{
 data.runtime.managedFamilies=[standard];await render();
 expect(text()).toContain('Not installed');expect(text()).not.toContain('Installed: runtime-10.0');
 expect(button('Install CachyOS runtime')).toBeUndefined();
});
it('checks explicitly and installs the exact captured candidate',async()=>{
 await click(button('Check for updates'));
 expect(window.launcher.checkManagedRuntime).toHaveBeenCalledWith('nexus-cachyos',{allowCachyos:true,allowPrerelease:false});
 expect(text()).toContain('Available: runtime-cachyos-11.0');expect(text()).toContain('Requires backend 0.2.3 and launcher 0.5.0 or newer.');
 await click(button('Install CachyOS runtime'));
 expect(window.launcher.installManagedRuntime).toHaveBeenCalledWith('nexus-cachyos',offer.candidateSha256,{allowCachyos:true,allowPrerelease:false});
 expect(document.querySelector('[role="status"]')?.textContent).toContain('CachyOS runtime installed. The default runtime, game runtime choices, prefixes and local saves are unchanged.');
 expect(busy.mock.calls).toEqual([[true],[false],[true],[false]]);
});
it('shows a managed installation with its version and keeps its recorded prerelease channel without a toggle',async()=>{
 data.runtime.managedFamilies=[installed('prerelease',true)];await render();
 expect(text()).toContain('Installed: runtime-cachyos-10.0');expect(text()).toContain('READY');
 expect(text()).toContain('/managed/cachyos/files/bin/wine');expect(card().querySelector('[data-cachyos-binary="managed"]')).not.toBeNull();
 expect(text()).toContain('Read-only path from the verified managed CachyOS family.');
 expect(card().querySelector('.status-label.ready')).not.toBeNull();expect(document.querySelector('input[type="checkbox"]')).toBeNull();
 await click(button('Update CachyOS runtime'));
 expect(window.launcher.installManagedRuntime).toHaveBeenCalledWith('nexus-cachyos',offer.candidateSha256,{allowCachyos:true,allowPrerelease:true});
});
it('reports an active local CachyOS default runtime truthfully without claiming a managed installation',async()=>{
 data.runtime=activeCachy;await render();
 expect(text()).toContain('ACTIVE');expect(text()).toContain('Active local build: cachyos-11.0-experimental-ge36f73cb-local');
 expect(text()).toContain('/local/cachyos/files/bin/wine');expect(card().querySelector('[data-cachyos-binary="default"]')).not.toBeNull();
 expect(text()).toContain('This CachyOS build is the current default runtime, but it is not an installed managed CachyOS family.');
 expect(text()).not.toContain('Installed:');expect(card().querySelector('.status-label.ready')).not.toBeNull();
 expect(button('Install CachyOS runtime')).toBeUndefined();
 await click(button('Check for updates'));
 expect(window.launcher.checkManagedRuntime).toHaveBeenCalledWith('nexus-cachyos',{allowCachyos:true,allowPrerelease:false});
});
it('does not claim an active local CachyOS runtime when the default runtime is something else',async()=>{
 data.runtime={...activeCachy,name:'nexus-runtime-11.0-experimental-g5910703e-local'};await render();
 expect(text()).not.toContain('ACTIVE');expect(text()).toContain('Not installed');
 expect(card().querySelector('[data-cachyos-binary="missing"]')).not.toBeNull();expect(text()).not.toContain('/local/cachyos/files/bin/wine');
});
it('reports a committed uncertain install as attention instead of success',async()=>{
 data.runtime.managedFamilies=[available()];await render();
 vi.mocked(window.launcher.installManagedRuntime).mockResolvedValue({family:'nexus-cachyos',success:false,committed:true,durability:'unknown'});
 await click(button('Install CachyOS runtime'));
 expect(alerts()).toContain('runtime was activated');expect(text()).not.toContain('CachyOS runtime installed.');
 expect(text()).not.toContain('previous runtime was kept');
});
it('surfaces status and request failures as actionable alerts',async()=>{
 data.runtime.managedFamilies=[{...available(),error:'Backend 0.3.0 or newer is required'}];await render();
 expect(alerts()).toContain('Backend 0.3.0 or newer is required');
 vi.mocked(window.launcher.checkManagedRuntime).mockRejectedValue(Error('Runtime release discovery is unavailable.'));
 await click(button('Check for updates'));
 expect(alerts()).toContain('Runtime release discovery is unavailable.');
});
it('discards a held old-root discovery response and releases local busy state',async()=>{
 let resolve!:(value:ManagedFamilyStatus)=>void;vi.mocked(window.launcher.checkManagedRuntime).mockReturnValue(new Promise(done=>resolve=done));
 await click(button('Check for updates'));
 data={...data,settings:{...data.settings,runtimeRoot:'/new/root'}};await render();await act(async()=>resolve(available()));
 expect(button('Install CachyOS runtime')).toBeUndefined();expect(busy).toHaveBeenLastCalledWith(false);
});
it('blocks controls during other activity and prevents duplicate held requests',async()=>{
 await render(true);expect(button('Check for updates')!.disabled).toBe(true);
 await click(button('Check for updates'));expect(window.launcher.checkManagedRuntime).not.toHaveBeenCalled();
 data.runtime.managedFamilies=[{...standard,checking:true}];await render();
 expect(button('Check for updates')!.disabled).toBe(true);
 data.runtime.managedFamilies=[];await render();let resolve!:(value:ManagedFamilyStatus)=>void;
 vi.mocked(window.launcher.checkManagedRuntime).mockReturnValue(new Promise(done=>resolve=done));
 await click(button('Check for updates'));await click(button('Check for updates'));
 expect(window.launcher.checkManagedRuntime).toHaveBeenCalledOnce();await act(async()=>resolve(available()));
});
it('shows the current candidate and uses a later authoritative snapshot instead of a stale local offer',async()=>{
 await click(button('Check for updates'));expect(button('Install CachyOS runtime')).toBeDefined();
 data.runtime.managedFamilies=[installed()];await render();
 expect(button('Install CachyOS runtime')).toBeUndefined();
 expect(text()).toContain('Installed: runtime-cachyos-10.0');expect(text()).toContain('This runtime is up to date.');
});
