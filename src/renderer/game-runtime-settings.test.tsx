// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {LibraryPage} from './App';
import {demoAccountLibrary,demoLaunchOptions,demoSnapshot} from '../shared/demo-data';
import type {InstalledRuntimeFamily} from '../shared/runtime-selection';
let root:Root,data:ReturnType<typeof demoSnapshot>;
const family='nexus-cachyos';
const a={buildId:'a'.repeat(64),manifestSha256:'b'.repeat(64),sourceCommit:'c'.repeat(40)};
const b={buildId:'d'.repeat(64),manifestSha256:'e'.repeat(64),sourceCommit:'f'.repeat(40)};
const c={buildId:'1'.repeat(64),manifestSha256:'2'.repeat(64),sourceCommit:'3'.repeat(40)};
const installed=(build:typeof a):InstalledRuntimeFamily=>({id:family,label:'Nexus Runtime (CachyOS, experimental)',...build});
const render=async()=>{await act(async()=>root.render(<LibraryPage data={data} toast={()=>{}}/>));};
const click=async(element:Element)=>{await act(async()=>(element as HTMLElement).click());};
async function openSettings() {
 await click(document.querySelector('.library-card-menu-button')!);
 const settings=[...document.querySelectorAll('.game-context-menu button')].find(button=>button.textContent==='Game settings')!;
 await click(settings);
}
const consent=()=>document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"][required]')!;
const save=()=>click(document.querySelector('[role="dialog"] button.primary')!);
beforeEach(async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 data=demoSnapshot();data.games=[{...data.games[0],runtime:family,runtimeSeparatePrefix:true,runtimeBuild:a}];
 data.runtime.variants=[installed(b)];
 window.launcher={getRuntimeFamilies:vi.fn(async()=>data.runtime.variants??[]),getAccountLibrary:vi.fn(async()=>demoAccountLibrary('all',new Map())),getGameLaunchOptions:vi.fn(async()=>demoLaunchOptions),getGameLocales:vi.fn(async()=>[]),
  updateGame:vi.fn(async(_id,patch)=>({...data.games[0],...patch}))} as unknown as Window['launcher'];
 document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root')!);await render();
});
afterEach(async()=>{await act(async()=>root.unmount());vi.restoreAllMocks();vi.unstubAllGlobals();document.body.innerHTML='';});
const chooseInstalled=()=>click([...document.querySelectorAll('[role="dialog"] button')].find(button=>button.textContent==='Use the newly installed build with a separate prefix')!);
it('preserves approved A while B is current and unrelated settings Save sends no new approval',async()=>{
 await openSettings();expect(consent().checked).toBe(true);
 expect(document.querySelector('[role="alert"]')?.textContent).toContain('approved build');
 await save();expect(window.launcher.updateGame).toHaveBeenCalledWith(data.games[0].id,expect.objectContaining({runtime:family,runtimeSeparatePrefix:true,runtimeApproveBuild:false,runtimeExpectedBuild:undefined}));
});
it('permits same-family A-to-B only after explicit choice of the installed build',async()=>{
 await openSettings();await chooseInstalled();await save();
 expect(window.launcher.updateGame).toHaveBeenCalledWith(data.games[0].id,expect.objectContaining({runtime:family,runtimeSeparatePrefix:true,runtimeApproveBuild:true,runtimeExpectedBuild:b}));
});
it('ordinary Save of an already current approved build sends no fresh build approval',async()=>{
 data.runtime.variants=[installed(a)];await render();await openSettings();expect(consent().checked).toBe(true);
 await save();expect(window.launcher.updateGame).toHaveBeenCalledWith(data.games[0].id,expect.objectContaining({runtimeApproveBuild:false,runtimeExpectedBuild:undefined}));
});
it('invalidates pending B approval when C arrives, retaining A until explicit C choice',async()=>{
 await openSettings();await chooseInstalled();data.runtime.variants=[installed(c)];await render();
 expect(consent().checked).toBe(true);await save();expect(window.launcher.updateGame).toHaveBeenLastCalledWith(data.games[0].id,expect.objectContaining({runtimeApproveBuild:false,runtimeExpectedBuild:undefined}));
 await openSettings();await chooseInstalled();await save();
 expect(window.launcher.updateGame).toHaveBeenLastCalledWith(data.games[0].id,expect.objectContaining({runtimeApproveBuild:true,runtimeExpectedBuild:c}));
});
it('preserves A approval when current changes while the form stays open',async()=>{
 data.runtime.variants=[installed(a)];await render();await openSettings();expect(consent().checked).toBe(true);
 data.runtime.variants=[installed(b)];await render();expect(consent().checked).toBe(true);
 await save();expect(window.launcher.updateGame).toHaveBeenCalledWith(data.games[0].id,expect.objectContaining({runtimeSeparatePrefix:true,runtimeApproveBuild:false}));
});
it('resets fresh B approval after closing and reopening, preserving A',async()=>{
 await openSettings();await chooseInstalled();await click(document.querySelector('[role="dialog"] [data-gamepad-cancel]')!);
 await openSettings();expect(consent().checked).toBe(true);await save();
 expect(window.launcher.updateGame).toHaveBeenCalledWith(data.games[0].id,expect.objectContaining({runtimeApproveBuild:false}));
});
it('refreshes verified current B locally without clearing saved A approval',async()=>{
 data.runtime.variants=[installed(a)];await render();vi.mocked(window.launcher.getRuntimeFamilies).mockResolvedValue([installed(b)]);
 await openSettings();expect(window.launcher.getRuntimeFamilies).toHaveBeenCalledOnce();expect(consent().checked).toBe(true);
 await chooseInstalled();await save();
 expect(window.launcher.updateGame).toHaveBeenCalledWith(data.games[0].id,expect.objectContaining({runtime:family,runtimeApproveBuild:true,runtimeExpectedBuild:b}));
});
it('does not fabricate valid approval for a legacy family-wide consent',async()=>{
 data.games=[{...data.games[0],runtimeBuild:undefined}];await render();await openSettings();expect(consent().checked).toBe(false);
 await click(consent());await save();expect(window.launcher.updateGame).toHaveBeenCalledWith(data.games[0].id,expect.objectContaining({runtimeApproveBuild:true,runtimeExpectedBuild:b}));
});
