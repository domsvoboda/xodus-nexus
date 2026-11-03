import { describe, expect, it, vi } from 'vitest';
import { ComponentUpdates, type PreparedComponentUpdate } from './component-updates.js';
import { ComponentUpdateAdmission } from './component-update-admission.js';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
function entry(id: string, component: 'backend' | 'runtime' | 'launcher' = 'runtime'): PreparedComponentUpdate { return { item: { id, component, label: id, state: 'ready' }, isCurrent: vi.fn(async () => true), apply: vi.fn(async () => ({ committed: true })) }; }
function fixture(entries: PreparedComponentUpdate[], changed = () => {}) { const idle = vi.fn(); const admission = new ComponentUpdateAdmission(idle); const updates = new ComponentUpdates(admission, async () => entries, changed, () => false); return { updates, admission, idle }; }
describe('component update coordinator', () => {
  it('orders backend, installed families then launcher and never overlaps child applies', async () => {
    const a = entry('backend', 'backend'), b = entry('standard'), c = entry('launcher', 'launcher'), order: string[] = []; let active = false;
    for (const e of [a,b,c]) e.apply = vi.fn(async owner => { expect(owner).toBeDefined(); expect(active).toBe(false); active = true; await Promise.resolve(); order.push(e.item.id); active = false; return { committed: true }; });
    const {updates} = fixture([c,b,a]); const plan = await updates.plan(); const result = await updates.apply(plan.id); expect(order).toEqual(['backend','standard','launcher']); expect(result.items.every(row => row.outcome === 'updated')).toBe(true);
  });
  it('blocks other mutations and concurrent batches throughout held child work, then releases', async () => {
    const e = entry('standard'), hold = deferred(); e.apply = vi.fn(async () => { await hold.promise; return { committed:true }; });
    const {updates,admission} = fixture([e]); const plan = await updates.plan(), pending = updates.apply(plan.id);
    expect(admission.busy).toBe(true); expect(() => admission.assertAllowed()).toThrow(); await expect(updates.apply(plan.id)).rejects.toThrow(); hold.resolve(); await pending; expect(admission.busy).toBe(false);
  });
  it('does not install missing, external or prerequisite-deferred items', async () => {
    const entries = ['skipped','unchanged','deferred'].map((state,i) => ({...entry(String(i)), item:{...entry(String(i)).item,state:state as 'skipped'|'unchanged'|'deferred',reason:'not eligible'}}));
    const {updates} = fixture(entries); const plan = await updates.plan(), result = await updates.apply(plan.id); expect(result.items.map(row => row.outcome)).toEqual(['skipped','unchanged','deferred']); for (const e of entries) expect(e.apply).not.toHaveBeenCalled();
  });
  it('rejects changed installed identity and stops before launcher', async () => {
    const a=entry('a'),b=entry('launcher','launcher'); a.isCurrent=vi.fn(async()=>false); const {updates}=fixture([a,b]);const plan=await updates.plan(),r=await updates.apply(plan.id); expect(r.items.map(row=>row.outcome)).toEqual(['stale','not-run']);expect(a.apply).not.toHaveBeenCalled();expect(b.apply).not.toHaveBeenCalled();
  });
  it('retries committed attention by reconciliation only, never reinstallation', async () => {
    const e=entry('a');e.apply=vi.fn(async()=>{throw Object.assign(Error('account refresh'),{committed:true});});e.reconcile=vi.fn(async()=>({})); const {updates}=fixture([e]);const plan=await updates.plan(),first=await updates.apply(plan.id);expect(first.items[0]).toMatchObject({outcome:'committed-needs-attention',retryable:true});const retry=await updates.apply(plan.id,'a');expect(retry.items[0].outcome).toBe('updated');expect(e.apply).toHaveBeenCalledOnce();expect(e.reconcile).toHaveBeenCalledOnce();
  });
  it('rechecks activity before child apply and retains the prior committed outcome', async () => {
    const a=entry('a'),b=entry('b');const {updates,idle}=fixture([a,b]);a.apply=vi.fn(async()=>{idle.mockImplementation(()=>{throw Error('closing');});return {committed:true};});const plan=await updates.plan(),r=await updates.apply(plan.id);expect(r.items[0].committed).toBe(true);expect(r.items[1].outcome).toBe('failed-before-commit');expect(b.apply).not.toHaveBeenCalled();
  });
  it('releases admission if progress notification throws', async () => {
    let fail=false;const {updates,admission}=fixture([entry('a')],()=>{if(fail)throw Error('notification');});const plan=await updates.plan();fail=true;await expect(updates.apply(plan.id)).rejects.toThrow('notification');expect(admission.busy).toBe(false);
  });
  it('hides stale plan and retry results after context changes, including remount reads', async () => {
    let context='A';const admission=new ComponentUpdateAdmission(()=>{}),e=entry('a');
    const updates=new ComponentUpdates(admission,async()=>[e],()=>{},()=>false,()=>context);
    const plan=await updates.plan();await updates.apply(plan.id);expect(updates.current.result).toBeDefined();context='B';
    expect(updates.current).toEqual({running:false});await expect(updates.apply(plan.id)).rejects.toThrow('context');expect(e.apply).toHaveBeenCalledOnce();
  });
  it('rejects unknown plans, nonretryable items and repeated application without work', async () => {
    const e=entry('a');const {updates,admission}=fixture([e]);await expect(updates.apply('foreign')).rejects.toThrow('stale');expect(admission.busy).toBe(false);const plan=await updates.plan();await updates.apply(plan.id);await expect(updates.apply(plan.id)).rejects.toThrow('already');await expect(updates.apply(plan.id,'a')).rejects.toThrow('cannot');expect(e.apply).toHaveBeenCalledOnce();
  });
});
