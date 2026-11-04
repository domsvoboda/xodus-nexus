import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RuntimeManager } from './runtime.js';
import { prepareManagedComponentUpdates } from './component-update-runtime.js';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'component-runtime-'));roots.push(root);
 const pointer=path.join(root,'variants/nexus/current.json');await fs.mkdir(path.dirname(pointer),{recursive:true});await fs.writeFile(pointer,'old');
 const installed={id:'nexus',label:'Nexus',buildId:'A',sourceCommit:'old-source',manifestSha256:'old-manifest'};
 const state:any={runtimeRoot:root,managedFamilies:[{id:'nexus',installed,channel:'stable',version:'old'}]};
 const target={tag:'new',commit:'new-source',candidateSha256:'captured-sha',prerelease:false};
 const runtime:any={get current(){return structuredClone(state);},refreshFamilies:vi.fn(async()=>state.managedFamilies.map((row:any)=>row.installed)),checkManagedRuntimeUpdate:vi.fn(async()=>({updateAvailable:true,available:{candidateSha256:'captured-sha'}})),managedTarget:vi.fn(()=>target),installPreparedManagedRuntime:vi.fn(async()=>({success:true,committed:true,buildId:'B',durability:'confirmed'}))};
 return {root,pointer,state,target,runtime:runtime as RuntimeManager,raw:runtime};
}
describe('managed component adapter',()=>{
 it('never installs an absent optional family or assigns an unknown release channel',async()=>{
  const f=await fixture();f.state.managedFamilies[0].channel=undefined;const entries=await prepareManagedComponentUpdates(f.runtime,()=>{});expect(entries.map(e=>e.item.state)).toEqual(['skipped','skipped']);expect(f.raw.checkManagedRuntimeUpdate).not.toHaveBeenCalled();expect(f.raw.installPreparedManagedRuntime).not.toHaveBeenCalled();
 });
 it('captures exact installed selection and candidate, never global settings or optional installation',async()=>{
  const f=await fixture(),entries=await prepareManagedComponentUpdates(f.runtime,()=>{});expect(entries[0].item.state).toBe('ready');expect(entries[1].item.state).toBe('skipped');expect(await entries[0].isCurrent()).toBe(true);
  const result=await entries[0].apply({identity:Symbol()});expect(result.committed).toBe(true);expect(f.raw.installPreparedManagedRuntime).toHaveBeenCalledWith('nexus',f.target,{allowCachyos:false,allowPrerelease:false},expect.any(Function));
 });
 it('rejects changed pointer bytes or root before child installation',async()=>{
  const f=await fixture(),entries=await prepareManagedComponentUpdates(f.runtime,()=>{});await fs.writeFile(f.pointer,'replacement');expect(await entries[0].isCurrent()).toBe(false);await expect(entries[0].apply({identity:Symbol()})).rejects.toThrow('changed');expect(f.raw.installPreparedManagedRuntime).not.toHaveBeenCalled();
 });
 it('keeps unknown durability committed attention manual, never reinstallation retry',async()=>{
  const f=await fixture();f.raw.installPreparedManagedRuntime.mockResolvedValue({success:false,committed:true,buildId:'B',durability:'unknown',error:'directory sync'});const entries=await prepareManagedComponentUpdates(f.runtime,()=>{});
  await expect(entries[0].apply({identity:Symbol()})).rejects.toMatchObject({committed:true,retryable:false});expect(f.raw.installPreparedManagedRuntime).toHaveBeenCalledOnce();
 });
 it('clearly defers prerequisites against installed versions rather than pretending scheduled updates are installed',async()=>{
  const f=await fixture();f.raw.checkManagedRuntimeUpdate.mockResolvedValue({error:'Backend 99 required'});const entries=await prepareManagedComponentUpdates(f.runtime,()=>{});expect(entries[0].item.state).toBe('deferred');expect(entries[0].item.reason).toContain('Check again after updating');expect(f.raw.installPreparedManagedRuntime).not.toHaveBeenCalled();
 });
});
