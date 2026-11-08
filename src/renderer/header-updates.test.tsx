// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {SettingsPage,Sidebar,TopStatus} from './App';
import {demoSnapshot} from '../shared/demo-data';
import type {AppSnapshot,ManagedFamilyStatus} from '../shared/types';

let root:Root,data:AppSnapshot,go:ReturnType<typeof vi.fn>;
const offer=(version:string,archiveName:string)=>({version,candidateSha256:'a'.repeat(64),sourceCommit:'b'.repeat(40),archiveName,requiresBackendVersion:'0.5.0',requiresLauncherVersion:'0.5.0'});
const build=(id:'nexus'|'nexus-cachyos',label:string)=>({id,label,buildId:'c'.repeat(64),manifestSha256:'d'.repeat(64),sourceCommit:'e'.repeat(40)});
const managedStandard:ManagedFamilyStatus={id:'nexus',checking:false,installing:false,installed:build('nexus','Standard'),version:'runtime-10.0',channel:'stable',available:offer('runtime-11.0','nexus-runtime-x86_64.tar.xz'),updateAvailable:true};
const managedCachyos:ManagedFamilyStatus={id:'nexus-cachyos',checking:false,installing:false,installed:build('nexus-cachyos','CachyOS'),version:'runtime-cachyos-10.0',channel:'stable',available:offer('runtime-cachyos-11.0','nexus-runtime-cachyos-x86_64.tar.xz'),updateAvailable:true};
const legacyStandard=(snapshot:AppSnapshot)=>{snapshot.runtime={...snapshot.runtime,installed:true,name:'xodus-nexus-runtime-10.0-old',nexusAvailable:true,nexusVersion:'runtime-11.0-new',nexusName:'xodus-nexus-runtime-11.0-new-x86_64.tar.xz'};};
const render=async(snapshot:AppSnapshot)=>act(async()=>root.render(<TopStatus data={snapshot} go={go}/>));
const action=()=>document.querySelector<HTMLButtonElement>('button.update-notice');
const buttons=()=>document.querySelectorAll('button').length;
const click=async(node:HTMLButtonElement|null)=>{expect(node).not.toBeNull();await act(async()=>node!.click());};

beforeEach(()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);data=demoSnapshot();go=vi.fn();
  window.launcher={planComponentUpdates:vi.fn(),checkManagedRuntime:vi.fn(),installManagedRuntime:vi.fn()} as unknown as Window['launcher'];
  document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root')!);
});
afterEach(async()=>{await act(async()=>root.unmount());vi.restoreAllMocks();vi.unstubAllGlobals();document.body.innerHTML='';});

it('renders no ready badge, offline text or duplicate settings gear without a component update',async()=>{
  await render(data);
  expect(document.querySelector('.top-status')).toBeNull();expect(buttons()).toBe(0);
  expect(document.body.textContent??'').not.toMatch(/Xodus ready|Offline|Settings/);
  data.connectivity={state:'offline',reason:'No network interface is connected.'};await render(data);
  expect(document.querySelector('.top-status')).toBeNull();expect(buttons()).toBe(0);
  data.backend.available=false;await render(data);
  expect(document.querySelector('.top-status')).toBeNull();expect(buttons()).toBe(0);
});

it('keeps backend failures on the existing Settings surface instead of claiming readiness',async()=>{
  data.backend.available=false;
  const settings=renderToStaticMarkup(<SettingsPage data={data} toast={()=>{}}/>);
  expect(settings).toContain('Xodus backend');expect(settings).toContain('OFFLINE');
  await render(data);expect(document.querySelector('.top-status')).toBeNull();
});

it('opens Settings from a genuine backend update',async()=>{
  data.backend.releaseAvailable=true;data.backend.updateAvailable=true;data.backend.releaseVersion='0.5.2';
  await render(data);
  expect(action()?.getAttribute('title')).toContain('Backend 0.5.2');
  await click(action());expect(go).toHaveBeenCalledTimes(1);expect(go).toHaveBeenCalledWith('settings');
});

it('opens Settings from a newer launcher release and ignores a non-newer latestVersion',async()=>{
  data.launcherUpdate={currentVersion:'0.4.2',checking:false,checkedAt:'today',latestVersion:'0.4.2'};
  await render(data);expect(action()).toBeNull();
  data.launcherUpdate={...data.launcherUpdate,latestVersion:'0.4.3'};await render(data);
  expect(action()?.getAttribute('title')).toContain('Launcher 0.4.3');
  await click(action());expect(go).toHaveBeenCalledTimes(1);expect(go).toHaveBeenCalledWith('settings');
});

it('advertises one installed Standard runtime family and dedupes the default Standard notice',async()=>{
  legacyStandard(data);data.runtime.managedFamilies=[managedStandard];
  await render(data);
  const title=action()?.getAttribute('title')??'';
  expect(title).toContain('Runtime Standard 11.0');
  expect(title).not.toContain('Runtime 11.0-new');
  expect((title.match(/Runtime /g)??[])).toHaveLength(1);
  await click(action());expect(go).toHaveBeenCalledTimes(1);expect(go).toHaveBeenCalledWith('settings');
});

it('opens Settings for an installed managed CachyOS update',async()=>{
  data.runtime.managedFamilies=[managedCachyos];
  await render(data);
  expect(action()?.getAttribute('title')).toContain('Runtime CachyOS 11.0');
  await click(action());expect(go).toHaveBeenCalledTimes(1);expect(go).toHaveBeenCalledWith('settings');
});

it('never advertises an uninstalled optional CachyOS candidate and performs no discovery on render',async()=>{
  data.runtime.managedFamilies=[{...managedCachyos,installed:undefined,updateAvailable:true}];
  await render(data);
  expect(document.querySelector('.top-status')).toBeNull();expect(buttons()).toBe(0);
  expect(window.launcher.planComponentUpdates).not.toHaveBeenCalled();
  expect(window.launcher.checkManagedRuntime).not.toHaveBeenCalled();
  expect(window.launcher.installManagedRuntime).not.toHaveBeenCalled();
});

it('keeps a pending launcher restart actionable without a latestVersion',async()=>{
  data.launcherUpdate={currentVersion:'0.4.2',checking:false,restartRequired:true};
  data.backend.releaseAvailable=true;data.backend.updateAvailable=true;data.backend.releaseVersion='0.5.2';
  await render(data);
  expect(action()?.textContent).toContain('Restart available');
  expect(action()?.getAttribute('title')).toContain('Restart to finish launcher update.');
  await click(action());expect(go).toHaveBeenCalledTimes(1);expect(go).toHaveBeenCalledWith('settings');
});

it('leaves the sidebar Settings entry as the only global settings control',async()=>{
  await render(data);expect(action()).toBeNull();
  await act(async()=>root.render(<Sidebar data={data} page="home" go={go}/>));
  const settings=[...document.querySelectorAll<HTMLButtonElement>('button')].filter(node=>node.textContent?.trim()==='Settings');
  expect(settings).toHaveLength(1);
  await click(settings[0]);expect(go).toHaveBeenCalledTimes(1);expect(go).toHaveBeenCalledWith('settings');
});
