import { describe, expect, it, vi } from 'vitest';
import { ComponentUpdateAdmission } from './component-update-admission.js';
describe('component update admission', () => {
  it('reserves synchronously, rejects foreign owners, and expires released ownership', () => {
    const idle = vi.fn(), gate = new ComponentUpdateAdmission(idle), owner = gate.reserve();
    expect(gate.busy).toBe(true); expect(idle).toHaveBeenCalledOnce();
    expect(() => gate.reserve()).toThrow('progress'); expect(() => gate.assertAllowed()).toThrow('progress');
    expect(() => gate.assertAllowed({ identity: owner.identity })).toThrow('progress');
    expect(() => gate.assertAllowed(owner)).not.toThrow(); gate.release(owner);
    expect(gate.busy).toBe(false); expect(() => gate.assertAllowed(owner)).toThrow('expired');
    const next = gate.reserve(); expect(() => gate.release(owner)).toThrow(); gate.release(next);
  });
  it('never bypasses activity checks with the valid owner', () => {
    let active = false; const gate = new ComponentUpdateAdmission(() => { if (active) throw Error('active'); });
    active = true; expect(() => gate.reserve()).toThrow('active'); expect(gate.busy).toBe(false);
    active = false; const owner = gate.reserve(); active = true;
    expect(() => gate.assertActivity(owner)).toThrow('active'); gate.release(owner); expect(gate.busy).toBe(false);
  });
});
