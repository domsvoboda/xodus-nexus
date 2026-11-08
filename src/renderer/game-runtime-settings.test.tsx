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
const installed=(build:typeof a):InstalledRuntimeFamily=>({id:family,label:'CachyOS',...build});
const render=async()=>{await act(async()=>root.render(<LibraryPage data={data} toast={()=>{}}/>));};
const click=async(element:Element)=>{await act(async()=>(element as HTMLElement).click());};
async function openSettings() {
 await click(document.querySelector('.library-card-menu-button')!);
 const settings=[...document.querySelectorAll('.game-context-menu button')].find(button=>button.textContent==='Game settings')!;
 await click(settings);
}
const runtimeSelect=()=>[...document.querySelectorAll<HTMLSelectElement>('[role="dialog"] select')].find(node=>[...node.options].some(option=>option.value===family))!;
const choose=async(value:string)=>{const select=runtimeSelect();await act(async()=>{select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));});};
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
it('shows the saved family as a plain runtime choice without a separate-prefix checkbox',async()=>{
 await openSettings();expect(runtimeSelect().value).toBe(family);
 expect(document.querySelector('[role="dialog"] input[type="checkbox"][required]')).toBeNull();
 expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain('separate prefix');
 await save();
 expect(window.launcher.updateGame).toHaveBeenCalledWith(data.games[0].id,expect.objectContaining({runtime:family}));
 expect(vi.mocked(window.launcher.updateGame).mock.calls[0][1]).not.toHaveProperty('runtimeSeparatePrefix');
});
it('saves a newly chosen family without a consent action and without an explicit prefix field',async()=>{
 data.games=[{...data.games[0],runtime:'default',runtimeSeparatePrefix:false,runtimeBuild:undefined}];await render();await openSettings();
 expect(runtimeSelect().value).toBe('default');
 await choose(family);
 await save();
 expect(window.launcher.updateGame).toHaveBeenCalledWith(data.games[0].id,expect.objectContaining({runtime:family}));
 expect(vi.mocked(window.launcher.updateGame).mock.calls[0][1]).not.toHaveProperty('runtimeSeparatePrefix');
});
it('keeps the family choice when a newer installed build is discovered while the form is open',async()=>{
 await openSettings();data.runtime.variants=[installed(b)];await render();
 expect(runtimeSelect().value).toBe(family);await save();
 expect(window.launcher.updateGame).toHaveBeenCalledWith(data.games[0].id,expect.objectContaining({runtime:family}));
});
it('returns the choice to the default runtime without leftover consent state',async()=>{
 await openSettings();await choose('default');await save();
 expect(window.launcher.updateGame).toHaveBeenCalledWith(data.games[0].id,expect.objectContaining({runtime:'default'}));
 expect(vi.mocked(window.launcher.updateGame).mock.calls[0][1]).not.toHaveProperty('runtimeSeparatePrefix');
});
