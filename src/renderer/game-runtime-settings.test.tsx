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
it('retains family consent when a newer installed build is discovered without a new approval action',async()=>{
 await openSettings();expect(consent().checked).toBe(true);expect(document.querySelector('[role="alert"]')).toBeNull();
 await save();expect(window.launcher.updateGame).toHaveBeenCalledWith(data.games[0].id,expect.objectContaining({runtime:family,runtimeSeparatePrefix:true}));expect(vi.mocked(window.launcher.updateGame).mock.calls[0][1]).not.toHaveProperty('runtimeApproveBuild');
});
it('keeps consent during B to C update while the form is open',async()=>{
 await openSettings();data.runtime.variants=[installed(c)];await render();expect(consent().checked).toBe(true);await save();expect(window.launcher.updateGame).toHaveBeenCalledWith(data.games[0].id,expect.objectContaining({runtimeSeparatePrefix:true}));
});
it('retains consent after reopening and local family refresh',async()=>{
 data.runtime.variants=[installed(a)];await render();vi.mocked(window.launcher.getRuntimeFamilies).mockResolvedValue([installed(b)]);await openSettings();expect(consent().checked).toBe(true);await click(document.querySelector('[role="dialog"] [data-gamepad-cancel]')!);await openSettings();expect(consent().checked).toBe(true);
});
it('requires separate prefix consent when first choosing another family',async()=>{
 data.games=[{...data.games[0],runtime:'default',runtimeSeparatePrefix:false,runtimeBuild:undefined}];await render();await openSettings();
 const select=[...document.querySelectorAll<HTMLSelectElement>('[role="dialog"] select')].find(node=>[...node.options].some(option=>option.value===family))!;
 await act(async()=>{select.value=family;select.dispatchEvent(new Event('change',{bubbles:true}));});expect(consent().checked).toBe(false);await click(consent());await save();expect(window.launcher.updateGame).toHaveBeenCalledWith(data.games[0].id,expect.objectContaining({runtime:family,runtimeSeparatePrefix:true}));
});
it('returning to a previously used family retains its saved prefix choice',async()=>{
 data.games=[{...data.games[0],runtime:'default',runtimeSeparatePrefix:false,runtimePrefixes:{[family]:{layout:'build',origin:a}}}];await render();await openSettings();
 const select=[...document.querySelectorAll<HTMLSelectElement>('[role="dialog"] select')].find(node=>[...node.options].some(option=>option.value===family))!;
 await act(async()=>{select.value=family;select.dispatchEvent(new Event('change',{bubbles:true}));});expect(consent().checked).toBe(true);
});
