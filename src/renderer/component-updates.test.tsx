// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ComponentUpdates} from './ComponentUpdates';
import {ConfirmationProvider} from './Confirmation';
import {demoSnapshot} from '../shared/demo-data';
import type {ComponentUpdatePlan,ComponentUpdateBatchResult} from '../shared/types';
let root:Root,data:ReturnType<typeof demoSnapshot>,busy:ReturnType<typeof vi.fn>;
const plan:ComponentUpdatePlan={id:'opaque-plan',createdAt:'2026-11-03',items:[{id:'backend',component:'backend',label:'Nexus backend',currentVersion:'0.2.3',targetVersion:'0.2.4',state:'ready'},{id:'cachy',component:'runtime',label:'CachyOS',state:'skipped',reason:'Optional family is not installed'}]};
const result:ComponentUpdateBatchResult={planId:plan.id,items:[{id:'backend',outcome:'updated',committed:true,retryable:false},{id:'cachy',outcome:'skipped',committed:false,retryable:false}],restartRequired:false};
const render=async(disabled=false)=>act(async()=>root.render(<ConfirmationProvider><ComponentUpdates data={data} disabled={disabled} onBusyChange={busy}/></ConfirmationProvider>));
const button=(text:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent===text)!;
const click=async(node:Element)=>act(async()=>(node as HTMLElement).click());
beforeEach(async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);data=demoSnapshot();busy=vi.fn();window.launcher={planComponentUpdates:vi.fn(async()=>structuredClone(plan)),applyComponentUpdates:vi.fn(async()=>structuredClone(result)),retryComponentUpdate:vi.fn(async()=>structuredClone(result)),restartLauncher:vi.fn(async()=>{})} as unknown as Window['launcher'];document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root')!);await render();
});
afterEach(async()=>{await act(async()=>root.unmount());vi.restoreAllMocks();vi.unstubAllGlobals();document.body.innerHTML='';});
it('does no discovery on mount and sends only opaque plan ID after explicit confirmation',async()=>{
 expect(window.launcher.planComponentUpdates).not.toHaveBeenCalled();await click(button('Update all components'));expect(window.launcher.applyComponentUpdates).not.toHaveBeenCalled();expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Nexus backend → 0.2.4');await click(button('Apply updates'));expect(window.launcher.applyComponentUpdates).toHaveBeenCalledWith('opaque-plan');expect(document.body.textContent).toContain('Optional family is not installed');expect(document.body.textContent).toContain('Updated');expect(window.launcher.restartLauncher).not.toHaveBeenCalled();expect(busy).toHaveBeenLastCalledWith(false);
});
it('cancelling confirmation never applies a plan or installs skipped optional components',async()=>{
 await click(button('Update all components'));await click(button('Cancel'));expect(window.launcher.applyComponentUpdates).not.toHaveBeenCalled();expect(document.body.textContent).toContain('Skipped');
});
it('offers targeted retry only for main-authorized retryable rows, preserving committed attention wording',async()=>{
 data.componentUpdates={running:false,plan,result:{...result,items:[{id:'backend',outcome:'committed-needs-attention',committed:true,retryable:false,message:'Selection was published, confirmation failed'},{id:'cachy',outcome:'failed-before-commit',committed:false,retryable:true}]}};await render();expect(document.body.textContent).toContain('Activated, needs attention');expect(button('Retry Nexus backend')).toBeUndefined();await click(button('Retry CachyOS'));expect(window.launcher.retryComponentUpdate).toHaveBeenCalledWith(plan.id,'cachy');expect(window.launcher.applyComponentUpdates).not.toHaveBeenCalled();
});
it('shows explicit restart guidance last without automatically restarting',async()=>{
 data.componentUpdates={running:false,plan,result:{...result,restartRequired:true}};await render();expect(document.body.textContent).toContain('No restart happens automatically');expect(window.launcher.restartLauncher).not.toHaveBeenCalled();
});
it('shows no-update and deferred plans without unnecessary apply or confirmation',async()=>{
 vi.mocked(window.launcher.planComponentUpdates).mockResolvedValue({...plan,items:plan.items.map(item=>({...item,state:'deferred',reason:'Update launcher then restart first'}))});await click(button('Update all components'));expect(document.querySelector('[role="dialog"]')).toBeNull();expect(window.launcher.applyComponentUpdates).not.toHaveBeenCalled();expect(document.body.textContent).toContain('Deferred');
});
it('blocks duplicate requests and other-activity admission while exposing main progress',async()=>{
 await render(true);await click(button('Update all components'));expect(window.launcher.planComponentUpdates).not.toHaveBeenCalled();await render();let done!:(value:ComponentUpdatePlan)=>void;vi.mocked(window.launcher.planComponentUpdates).mockReturnValue(new Promise(resolve=>done=resolve));await click(button('Update all components'));await click(button('Update all components'));expect(window.launcher.planComponentUpdates).toHaveBeenCalledOnce();await act(async()=>done({...plan,items:[]}));data.componentUpdates={running:true,phase:'Verifying runtime',plan};await render();expect(button('Update all components').disabled).toBe(true);expect(document.querySelector('[role="status"]')?.textContent).toBe('Verifying runtime');
});
it('discards an old-account plan while pending and never applies it',async()=>{
 let done!:(value:ComponentUpdatePlan)=>void;vi.mocked(window.launcher.planComponentUpdates).mockReturnValue(new Promise(resolve=>done=resolve));await click(button('Update all components'));data={...data,auth:{...data.auth,username:'different@example.test'}};await render();await act(async()=>done(plan));expect(document.querySelector('[role="dialog"]')).toBeNull();expect(window.launcher.applyComponentUpdates).not.toHaveBeenCalled();expect(busy).toHaveBeenLastCalledWith(false);
});
it('retains the completed result after its own backend update changes the binary path',async()=>{
 let done!:(value:ComponentUpdateBatchResult)=>void;vi.mocked(window.launcher.applyComponentUpdates).mockReturnValue(new Promise(resolve=>done=resolve));await click(button('Update all components'));await click(button('Apply updates'));data={...data,backend:{...data.backend,binaryPath:'/new/backend',version:'0.2.4'}};await render();await act(async()=>done(result));expect(document.body.textContent).toContain('Updated');
});

it.each(['account','root'])('hides an existing snapshot plan/result and retry when %s changes without a new snapshot status',async change=>{
 data.componentUpdates={running:false,plan,result:{...result,items:[{id:'backend',outcome:'failed-before-commit',committed:false,retryable:true,message:'Old-context failure'}]}};await render();expect(button('Retry Nexus backend')).toBeDefined();
 if(change==='account')data={...data,auth:{...data.auth,username:'new@example.test'}};else data={...data,settings:{...data.settings,runtimeRoot:'/different/runtime'}};
 await render();expect(button('Retry Nexus backend')).toBeUndefined();expect(document.querySelector('.component-update-results')).toBeNull();expect(document.body.textContent).not.toContain('Old-context failure');expect(window.launcher.retryComponentUpdate).not.toHaveBeenCalled();
});
