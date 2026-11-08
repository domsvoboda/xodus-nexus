// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {useGameRuntimeReady} from './useGameRuntimeReady';
import {HomePage} from './App';
import {demoSnapshot} from '../shared/demo-data';
let root:Root,data:ReturnType<typeof demoSnapshot>;
const approval={buildId:'a'.repeat(64),manifestSha256:'b'.repeat(64),sourceCommit:'c'.repeat(40)};
const pending=()=>{let resolve!:(ready:boolean)=>void;const promise=new Promise<boolean>(r=>resolve=r);return {promise,resolve};};
function Fixture(){const ready=useGameRuntimeReady(data.games[0],data);return <button disabled={!ready}>Play</button>;}
const render=()=>act(async()=>root.render(<Fixture/>));
const enabled=()=>!(document.querySelector('button') as HTMLButtonElement).disabled;
beforeEach(()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);data=demoSnapshot();data.games=[{...data.games[0],runtime:'nexus-cachyos',runtimeSeparatePrefix:true,runtimeBuild:approval}];data.runtime.variants=[];
 window.launcher={getGameRuntimeReadiness:vi.fn(async()=>true)} as unknown as Window['launcher'];
 document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root')!);
});
afterEach(async()=>{await act(async()=>root.unmount());vi.restoreAllMocks();vi.unstubAllGlobals();});
it('uses verified main-process readiness without requiring a snapshot descriptor, and avoids rerender request loops',async()=>{
 const request=pending();vi.mocked(window.launcher.getGameRuntimeReadiness).mockReturnValue(request.promise);
 await render();expect(enabled()).toBe(false);await act(async()=>request.resolve(true));expect(enabled()).toBe(true);
 await render();await render();expect(window.launcher.getGameRuntimeReadiness).toHaveBeenCalledTimes(1);
});
it('never borrows snapshot availability when current verification fails',async()=>{
 data.runtime.variants=[{id:'nexus-cachyos',label:'B',buildId:'d'.repeat(64),manifestSha256:'e'.repeat(64),sourceCommit:'f'.repeat(40)}];
 vi.mocked(window.launcher.getGameRuntimeReadiness).mockResolvedValue(false);await render();expect(enabled()).toBe(false);
 vi.mocked(window.launcher.getGameRuntimeReadiness).mockRejectedValue(Error('verification failed'));data.settings.runtimeRoot+='-changed';await render();expect(enabled()).toBe(false);
});
it('rejects stale A-to-B responses and old A results after an A-to-B-to-A switch',async()=>{
 const a=pending(),b=pending(),again=pending();vi.mocked(window.launcher.getGameRuntimeReadiness).mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise).mockReturnValueOnce(again.promise);
 await render();await act(async()=>a.resolve(true));expect(enabled()).toBe(true);
 data.games=[{...data.games[0],runtimeBuild:{...approval,buildId:'d'.repeat(64)}}];await render();expect(enabled()).toBe(false);
 data.games=[{...data.games[0],runtimeBuild:approval}];await render();expect(enabled()).toBe(false);
 await act(async()=>b.resolve(true));expect(enabled()).toBe(false);
 await act(async()=>again.resolve(true));expect(enabled()).toBe(true);
});
it('ignores a held response after unmount and starts pending on remount',async()=>{
 const old=pending(),fresh=pending();vi.mocked(window.launcher.getGameRuntimeReadiness).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
 await render();await act(async()=>root.render(null));await act(async()=>old.resolve(true));await render();expect(enabled()).toBe(false);
 await act(async()=>fresh.resolve(false));expect(enabled()).toBe(false);
});
it('preserves default/custom Wine readiness but never treats a verified legacy Cachy runner as the new-game default',async()=>{
 data.games=[{...data.games[0],runtime:'default'}];data.settings.winePath='/custom/wine';await render();expect(enabled()).toBe(true);expect(window.launcher.getGameRuntimeReadiness).not.toHaveBeenCalled();
 data.runtime={...data.runtime,installed:true,name:'nexus-runtime-cachyos-11.0-experimental-gaaaaaaaa'};data.settings.winePath='/cachyos/files/bin/wine';await render();expect(enabled()).toBe(false);
 data.runtime.managedFamilies=[{id:'nexus',checking:false,installing:false,installed:{id:'nexus',label:'Standard',buildId:'a'.repeat(64),sourceCommit:'b'.repeat(40),manifestSha256:'c'.repeat(64)}}];await render();expect(enabled()).toBe(true);
 data.settings.winePath='';data.runtime.winePath=undefined;data.runtime.managedFamilies=[];await render();expect(enabled()).toBe(false);
});

it('is not ready for a default game when only managed CachyOS exists, even with legacy Standard or custom Wine present',async()=>{
 data.games=[{...data.games[0],runtime:'default'}];data.settings.winePath='/legacy/standard/files/bin/wine';data.runtime={...data.runtime,installed:true,name:'nexus-runtime-11.0-experimental-g76c6dd13'};
 data.runtime.managedFamilies=[{id:'nexus-cachyos',checking:false,installing:false,installed:{id:'nexus-cachyos',label:'CachyOS',buildId:'d'.repeat(64),sourceCommit:'e'.repeat(40),manifestSha256:'f'.repeat(64)}}];
 await render();expect(enabled()).toBe(false);expect(window.launcher.getGameRuntimeReadiness).not.toHaveBeenCalled();
 data.runtime.managedFamilies=[{...data.runtime.managedFamilies![0],id:'nexus',installed:{id:'nexus',label:'Standard',buildId:'a'.repeat(64),sourceCommit:'b'.repeat(40),manifestSha256:'c'.repeat(64)}}];
 await render();expect(enabled()).toBe(true);
});

it('ignores held A readiness after switching to B',async()=>{
 const a=pending(),b=pending();vi.mocked(window.launcher.getGameRuntimeReadiness).mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
 await render();data.games=[{...data.games[0],runtimeBuild:{...approval,buildId:'d'.repeat(64)}}];await render();
 await act(async()=>a.resolve(true));expect(enabled()).toBe(false);await act(async()=>b.resolve(true));expect(enabled()).toBe(true);
});

it('enables actual Home Play only after fresh main-process verification, even without a snapshot descriptor',async()=>{
 const request=pending();vi.mocked(window.launcher.getGameRuntimeReadiness).mockReturnValue(request.promise);
 window.launcher.getGameLaunchOptions=vi.fn(async()=>({cloudSaves:false,vcInstall:false}));
 data.games[0].installState='ready';data.backend.capabilities.run=true;
 await act(async()=>root.render(<HomePage data={data} go={()=>{}} action={()=>{}}/>));
 const play=()=>document.querySelector<HTMLButtonElement>('[data-gamepad-key="home-play"]');
 expect(play()).toBeNull();await act(async()=>request.resolve(true));expect(play()?.disabled).toBe(false);
});

it('rechecks readiness after a managed installation revision even when descriptor identity stays unchanged',async()=>{
 await render();expect(enabled()).toBe(true);const next=pending();vi.mocked(window.launcher.getGameRuntimeReadiness).mockReturnValueOnce(next.promise);data.runtime.managedRevision=1;await render();expect(enabled()).toBe(false);expect(window.launcher.getGameRuntimeReadiness).toHaveBeenCalledTimes(2);await act(async()=>next.resolve(true));expect(enabled()).toBe(true);
});
