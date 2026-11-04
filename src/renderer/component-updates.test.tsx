// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ConfirmationProvider} from './Confirmation';
import {SettingsPage} from './App';
import {demoSnapshot} from '../shared/demo-data';
import type {ComponentUpdatePlan,ComponentUpdateBatchResult} from '../shared/types';
let root:Root,data:ReturnType<typeof demoSnapshot>,toast:ReturnType<typeof vi.fn>;
const plan:ComponentUpdatePlan={id:'opaque-plan',createdAt:'2026-11-03',items:[{id:'backend',component:'backend',label:'Nexus backend',currentVersion:'0.2.3',targetVersion:'0.2.4',state:'ready'},{id:'cachy',component:'runtime',label:'CachyOS',state:'skipped',reason:'Optional family is not installed'},{id:'launcher',component:'launcher',label:'Launcher',currentVersion:'0.4.2',targetVersion:'0.5.0',state:'ready'}]};
const result:ComponentUpdateBatchResult={planId:plan.id,items:[{id:'backend',outcome:'updated',committed:true,retryable:false},{id:'cachy',outcome:'skipped',committed:false,retryable:false},{id:'launcher',outcome:'updated',committed:true,retryable:false}],restartRequired:false};
const render=async()=>act(async()=>root.render(<ConfirmationProvider><SettingsPage data={data} toast={toast}/></ConfirmationProvider>));
const launcher=()=>document.querySelector<HTMLElement>('.launcher-card')!;
const launcherButton=(label:string)=>[...launcher().querySelectorAll('button')].find(node=>node.textContent===label) as HTMLButtonElement|undefined;
const button=(label:string)=>[...document.querySelectorAll('button')].find(node=>node.textContent===label) as HTMLButtonElement|undefined;
const click=async(node:Element|undefined)=>{expect(node).toBeDefined();await act(async()=>(node as HTMLElement).click());};
beforeEach(async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);data=demoSnapshot();data.downloads=[];toast=vi.fn();
 window.launcher={
  planComponentUpdates:vi.fn(async()=>structuredClone(plan)),
  applyComponentUpdates:vi.fn(async()=>structuredClone(result)),
  retryComponentUpdate:vi.fn(async()=>structuredClone(result)),
  checkLauncherUpdate:vi.fn(async()=>{}),
  checkKeyring:vi.fn(async()=>({state:'ready'})),
  onOperationLog:vi.fn(()=>()=>{}),
 } as unknown as Window['launcher'];
 document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root')!);await render();
});
afterEach(async()=>{await act(async()=>root.unmount());vi.restoreAllMocks();vi.unstubAllGlobals();document.body.innerHTML='';});
it('removes the standalone component update card and discovers nothing on mount',()=>{
 expect(document.querySelector('.component-updates')).toBeNull();
 expect(document.body.textContent).not.toContain('Component updates');
 expect(launcherButton('Update all')).toBeUndefined();
 expect(window.launcher.planComponentUpdates).not.toHaveBeenCalled();
 expect(window.launcher.applyComponentUpdates).not.toHaveBeenCalled();
});
it('read-only Check discovers updates and reveals Update all beside it without installing',async()=>{
 await click(launcherButton('Check for updates'));
 expect(window.launcher.planComponentUpdates).toHaveBeenCalledOnce();
 // The plan already runs launcher release discovery; no duplicate launcher check follows it.
 expect(window.launcher.checkLauncherUpdate).not.toHaveBeenCalled();
 expect(window.launcher.applyComponentUpdates).not.toHaveBeenCalled();
 const row=launcher().querySelector('.button-row')!;
 const labels=[...row.querySelectorAll('button')].map(node=>node.textContent);
 expect(labels).toContain('Check for updates');expect(labels).toContain('Update all');
 await click(launcherButton('Update all'));
 expect(window.launcher.applyComponentUpdates).not.toHaveBeenCalled();
 expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Nexus backend → 0.2.4');
 await click(button('Apply updates'));
 expect(window.launcher.applyComponentUpdates).toHaveBeenCalledWith('opaque-plan');
 const results=launcher().querySelector('.component-update-results');
 expect(results).not.toBeNull();expect(results?.textContent).toContain('Updated');
 expect(results?.textContent).toContain('Optional family is not installed');
 expect(launcherButton('Update all')).toBeUndefined();
 expect(window.launcher.restartLauncher).toBeUndefined();
});
it('falls back to the launcher-only check only when the plan cannot cover the launcher',async()=>{
 vi.mocked(window.launcher.planComponentUpdates).mockResolvedValue({...structuredClone(plan),items:structuredClone(plan).items.map(item=>item.component==='launcher'?{...item,state:'skipped' as const,targetVersion:undefined,reason:'An installed writable AppImage is required.'}:{...item,state:'unchanged' as const,targetVersion:undefined})});
 await click(launcherButton('Check for updates'));
 expect(window.launcher.planComponentUpdates).toHaveBeenCalledOnce();
 expect(window.launcher.checkLauncherUpdate).toHaveBeenCalledOnce();
 expect(launcherButton('Update all')).toBeUndefined();
 expect(launcher().querySelector('.component-update-results')?.textContent).toContain('An installed writable AppImage is required.');
});
it('cancelling confirmation never applies the plan',async()=>{
 await click(launcherButton('Check for updates'));
 await click(launcherButton('Update all'));
 await click(button('Cancel'));
 expect(window.launcher.applyComponentUpdates).not.toHaveBeenCalled();
});
it('shows deferred or already-current plans inline without an Update all action',async()=>{
 vi.mocked(window.launcher.planComponentUpdates).mockResolvedValue({...plan,items:plan.items.map(item=>({...item,state:'deferred' as const,reason:'Update launcher then restart first'}))});
 await click(launcherButton('Check for updates'));
 expect(launcherButton('Update all')).toBeUndefined();
 expect(document.querySelector('[role="dialog"]')).toBeNull();
 expect(launcher().querySelector('.component-update-results')?.textContent).toContain('Update launcher then restart first');
});
it('offers targeted retry only for main-authorized retryable rows and keeps committed attention wording',async()=>{
 data.componentUpdates={running:false,plan,result:{...result,items:[{id:'backend',outcome:'committed-needs-attention',committed:true,retryable:false,message:'Selection was published, confirmation failed'},{id:'cachy',outcome:'failed-before-commit',committed:false,retryable:true}]}};
 await render();
 expect(launcher().textContent).toContain('Activated, needs attention');
 expect(button('Retry Nexus backend')).toBeUndefined();
 await click(button('Retry CachyOS'));
 expect(window.launcher.retryComponentUpdate).toHaveBeenCalledWith(plan.id,'cachy');
 expect(window.launcher.applyComponentUpdates).not.toHaveBeenCalled();
});
it('shows explicit restart guidance last and never restarts automatically',async()=>{
 data.componentUpdates={running:false,plan,result:{...result,restartRequired:true}};
 await render();
 expect(launcher().textContent).toContain('No restart happens automatically');
 expect(window.launcher.restartLauncher).toBeUndefined();
});
it('blocks discovery during other activity and never overlaps held requests',async()=>{
 data.auth={...data.auth,running:true};await render();
 await click(launcherButton('Check for updates'));
 expect(window.launcher.planComponentUpdates).not.toHaveBeenCalled();
 data.auth={...data.auth,running:false};await render();
 let done!:(value:ComponentUpdatePlan)=>void;
 vi.mocked(window.launcher.planComponentUpdates).mockReturnValue(new Promise(resolve=>done=resolve));
 await click(launcherButton('Check for updates'));await click(launcherButton('Check for updates'));
 expect(window.launcher.planComponentUpdates).toHaveBeenCalledOnce();
 await act(async()=>done(structuredClone(plan)));
 data.componentUpdates={running:true,phase:'Verifying runtime',plan};
 await render();
 expect(launcherButton('Update all')?.disabled).toBe(true);
 expect(launcher().querySelector('[role="status"]')?.textContent).toBe('Verifying runtime');
});
it('does not start the launcher fallback when discovery is blocked by other activity',async()=>{
 data.auth={...data.auth,running:true};await render();
 expect(launcherButton('Check for updates')?.disabled).toBe(true);
 await click(launcherButton('Check for updates'));
 expect(window.launcher.planComponentUpdates).not.toHaveBeenCalled();
 expect(window.launcher.checkLauncherUpdate).not.toHaveBeenCalled();
});
it('ignores a duplicate Check while planning without releasing the shared busy state',async()=>{
 let done!:(value:ComponentUpdatePlan)=>void;
 vi.mocked(window.launcher.planComponentUpdates).mockReturnValue(new Promise(resolve=>done=resolve));
 await click(launcherButton('Check for updates'));
 expect(window.launcher.planComponentUpdates).toHaveBeenCalledOnce();
 expect(launcherButton('Check for updates')?.disabled).toBe(true);
 expect(launcherButton('Add Nexus Launcher to Steam')?.disabled).toBe(true);
 await click(launcherButton('Check for updates'));
 expect(window.launcher.planComponentUpdates).toHaveBeenCalledOnce();
 expect(window.launcher.checkLauncherUpdate).not.toHaveBeenCalled();
 await act(async()=>done(structuredClone(plan)));
 expect(window.launcher.planComponentUpdates).toHaveBeenCalledOnce();
 expect(window.launcher.checkLauncherUpdate).not.toHaveBeenCalled();
 expect(launcherButton('Check for updates')?.disabled).toBe(false);
 expect(launcherButton('Add Nexus Launcher to Steam')?.disabled).toBe(false);
});
it('discards an old-account plan instead of applying it',async()=>{
 let done!:(value:ComponentUpdatePlan)=>void;
 vi.mocked(window.launcher.planComponentUpdates).mockReturnValue(new Promise(resolve=>done=resolve));
 await click(launcherButton('Check for updates'));
 data={...data,auth:{...data.auth,username:'different@example.test'}};
 await render();
 await act(async()=>done(structuredClone(plan)));
 expect(document.querySelector('[role="dialog"]')).toBeNull();
 expect(launcherButton('Update all')).toBeUndefined();
 expect(window.launcher.applyComponentUpdates).not.toHaveBeenCalled();
});
it('retains a completed result after the backend identity changes but hides it after account changes',async()=>{
 let done!:(value:ComponentUpdateBatchResult)=>void;
 vi.mocked(window.launcher.applyComponentUpdates).mockReturnValue(new Promise(resolve=>done=resolve));
 await click(launcherButton('Check for updates'));await click(launcherButton('Update all'));await click(button('Apply updates'));
 data={...data,backend:{...data.backend,binaryPath:'/new/backend',version:'0.2.4'}};
 await render();
 await act(async()=>done(structuredClone(result)));
 expect(launcher().textContent).toContain('Updated');
 data={...data,auth:{...data.auth,username:'new@example.test'}};
 await render();
 expect(launcher().querySelector('.component-update-results')).toBeNull();
});
it('falls back exactly once when real discovery fails and keeps the error visible',async()=>{
 vi.mocked(window.launcher.planComponentUpdates).mockRejectedValue(Error('Update plan could not be prepared.'));
 await click(launcherButton('Check for updates'));
 expect(launcher().querySelector('[role="alert"]')?.textContent).toContain('Update plan could not be prepared.');
 expect(window.launcher.checkLauncherUpdate).toHaveBeenCalledOnce();
 expect(window.launcher.applyComponentUpdates).not.toHaveBeenCalled();
 expect(launcherButton('Check for updates')?.disabled).toBe(false);
 expect(data.componentUpdates?.running).not.toBe(true);
});
