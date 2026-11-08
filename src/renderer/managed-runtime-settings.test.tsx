// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ManagedRuntimeSettings} from './ManagedRuntimeSettings';
import {demoSnapshot} from '../shared/demo-data';
import type {ManagedFamilyStatus,ManagedFamilyInstallResult} from '../shared/types';
let root:Root,data:ReturnType<typeof demoSnapshot>,busy:ReturnType<typeof vi.fn>;
const offers={
  nexus:{version:'runtime-11.0',candidateSha256:'1'.repeat(64),sourceCommit:'2'.repeat(40),archiveName:'nexus-runtime-11.0-x86_64.tar.xz',requiresBackendVersion:'0.2.3',requiresLauncherVersion:'0.5.0'},
  'nexus-cachyos':{version:'runtime-cachyos-11.0',candidateSha256:'3'.repeat(64),sourceCommit:'4'.repeat(40),archiveName:'nexus-runtime-cachyos-11.0-x86_64.tar.xz',requiresBackendVersion:'0.2.3',requiresLauncherVersion:'0.5.0'},
};
const builds={
  nexus:{id:'nexus' as const,label:'Standard',buildId:'a'.repeat(64),manifestSha256:'b'.repeat(64),sourceCommit:'c'.repeat(40),displayWinePath:'/managed/standard/files/bin/wine'},
  'nexus-cachyos':{id:'nexus-cachyos' as const,label:'CachyOS',buildId:'d'.repeat(64),manifestSha256:'e'.repeat(64),sourceCommit:'f'.repeat(40),displayWinePath:'/managed/cachyos/files/bin/wine'},
};
const available=(family:'nexus'|'nexus-cachyos'):ManagedFamilyStatus=>({id:family,checking:false,installing:false,available:offers[family],updateAvailable:true});
const installed=(family:'nexus'|'nexus-cachyos',version:string):ManagedFamilyStatus=>({id:family,checking:false,installing:false,installed:builds[family],version,channel:'stable',updateAvailable:false});
const render=async(disabled=false)=>act(async()=>root.render(<ManagedRuntimeSettings data={data} disabled={disabled} onBusyChange={busy}/>));
const card=(family:'nexus'|'nexus-cachyos')=>document.querySelector<HTMLElement>(`section.settings-card.managed-runtime-settings[data-runtime-family="${family}"]`)!;
const button=(family:'nexus'|'nexus-cachyos',label:string)=>[...card(family).querySelectorAll('button')].find(node=>node.textContent===label) as HTMLButtonElement|undefined;
const click=async(node:Element|undefined)=>{expect(node).toBeDefined();await act(async()=>(node as HTMLElement).click());};
const text=()=>document.body.textContent??'';
beforeEach(async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);data=demoSnapshot();data.runtime.managedFamilies=[];busy=vi.fn();
 window.launcher={
  checkManagedRuntime:vi.fn(async(family:'nexus'|'nexus-cachyos')=>available(family)),
  installManagedRuntime:vi.fn(async(family:'nexus'|'nexus-cachyos'):Promise<ManagedFamilyInstallResult>=>({family,success:true,committed:true,durability:'confirmed'})),
  importManagedRuntime:vi.fn(async(family:'nexus'|'nexus-cachyos'):Promise<ManagedFamilyInstallResult>=>({family,success:true,committed:true,durability:'confirmed'})),
  chooseDirectory:vi.fn(async()=>'/local/runtime-build'),
 } as unknown as Window['launcher'];
 document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root')!);await render();
});
afterEach(async()=>{await act(async()=>root.unmount());vi.restoreAllMocks();vi.unstubAllGlobals();document.body.innerHTML='';});
it('always shows independent Standard and CachyOS family cards with no global toggle or binary path',()=>{
 expect(document.querySelectorAll('section.settings-card.managed-runtime-settings')).toHaveLength(2);
 expect([...document.querySelectorAll('h2')].map(node=>node.textContent)).toEqual(['Standard runtime','CachyOS runtime']);
 expect(card('nexus').querySelector('.status-label')?.textContent).toContain('Not installed');
 expect(card('nexus-cachyos').querySelector('.status-label')?.textContent).toContain('Not installed');
 expect(button('nexus','Install Standard runtime')).toBeUndefined();
 expect(button('nexus-cachyos','Install CachyOS runtime')).toBeUndefined();
 expect(document.querySelector('input[type="checkbox"]')).toBeNull();
 expect(text()).not.toContain('/managed/standard/files/bin/wine');
 expect(text()).not.toContain('/managed/cachyos/files/bin/wine');
 expect(text()).not.toContain('ACTIVE');
});
it('checks and installs each family with its own exact candidate and options',async()=>{
 await click(button('nexus','Check for updates'));
 expect(window.launcher.checkManagedRuntime).toHaveBeenCalledWith('nexus',{allowCachyos:false,allowPrerelease:false});
 expect(button('nexus','Install Standard runtime')).toBeDefined();
 await click(button('nexus','Install Standard runtime'));
 expect(window.launcher.installManagedRuntime).toHaveBeenCalledWith('nexus',offers.nexus.candidateSha256,{allowCachyos:false,allowPrerelease:false});
 expect(card('nexus').querySelector('[role="status"]')?.textContent).toContain('Standard runtime installed and verified');
 await click(button('nexus-cachyos','Check for updates'));
 expect(window.launcher.checkManagedRuntime).toHaveBeenCalledWith('nexus-cachyos',{allowCachyos:true,allowPrerelease:false});
 await click(button('nexus-cachyos','Install CachyOS runtime'));
 expect(window.launcher.installManagedRuntime).toHaveBeenCalledWith('nexus-cachyos',offers['nexus-cachyos'].candidateSha256,{allowCachyos:true,allowPrerelease:false});
 expect(busy.mock.calls).toEqual([[true],[false],[true],[false],[true],[false],[true],[false]]);
});
it('imports a local verified build output through the explicit directory chooser',async()=>{
 await click(button('nexus','Install from archive'));
 expect(window.launcher.chooseDirectory).toHaveBeenCalledWith('runtime');
 expect(window.launcher.importManagedRuntime).toHaveBeenCalledWith('nexus','/local/runtime-build',{allowCachyos:false,allowPrerelease:false});
 expect(card('nexus').querySelector('[role="status"]')?.textContent).toContain('Standard runtime installed and verified');
});
it('shows each managed installed version independently and never borrows the legacy runtime',async()=>{
 data.runtime={...data.runtime,installed:true,name:'nexus-runtime-cachyos-legacy',winePath:'/legacy/cachyos/files/bin/wine'};
 data.runtime.managedFamilies=[installed('nexus','runtime-10.0'),installed('nexus-cachyos','runtime-cachyos-10.0')];
 await render();
 expect(card('nexus').textContent).toContain('Installed: runtime-10.0');expect(card('nexus').querySelector('.status-label.ready')).not.toBeNull();
 expect(card('nexus-cachyos').textContent).toContain('Installed: runtime-cachyos-10.0');expect(card('nexus-cachyos').querySelector('.status-label.ready')).not.toBeNull();
 expect(text()).not.toContain('/legacy/cachyos/files/bin/wine');
 expect(text()).not.toContain('/managed/standard/files/bin/wine');
});
it('keeps phases and errors on the family they belong to',async()=>{
 data.runtime.managedFamilies=[
  {...installed('nexus','runtime-10.0'),checking:true,phase:'Checking the Standard runtime release.'},
  {...installed('nexus-cachyos','runtime-cachyos-10.0'),phase:'Runtime is ready.',error:'Backend 0.3.0 or newer is required'},
 ];
 await render();
 expect(card('nexus').querySelector('.runtime-phase')?.textContent).toContain('Checking the Standard runtime release.');
 expect(card('nexus-cachyos').querySelector('.runtime-phase')).toBeNull();
 expect(card('nexus-cachyos').querySelector('[role="alert"]')?.textContent).toContain('Backend 0.3.0 or newer is required');
});
it('reports a committed uncertain install as attention instead of success',async()=>{
 data.runtime.managedFamilies=[available('nexus')];await render();
 vi.mocked(window.launcher.installManagedRuntime).mockResolvedValue({family:'nexus',success:false,committed:true,durability:'unknown'});
 await click(button('nexus','Install Standard runtime'));
 expect(text()).toContain('runtime was activated');expect(text()).not.toContain('Standard runtime installed and verified');
});
it('does not start a second operation while another family is checking',async()=>{
 data.runtime.managedFamilies=[{...available('nexus-cachyos'),checking:true}];await render();
 expect(button('nexus','Check for updates')!.disabled).toBe(true);
 await click(button('nexus','Check for updates'));
 expect(window.launcher.checkManagedRuntime).not.toHaveBeenCalled();
});
