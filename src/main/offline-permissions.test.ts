import { describe, expect, it, vi } from 'vitest';
import { changeOfflinePermissions, readOfflinePermissions } from './offline-permissions.js';

const ok = (enabled: boolean, remaining: number, requestSuccess = true) =>
  JSON.stringify({ schema: 1, enabled, requestSuccess, remainingToggles: remaining, maxToggles: 3, periodDays: 365, nextChangeAt: null });

describe('offline permission backend calls', () => {
  it('reads status without changing anything and passes the confirmation only for changes', async () => {
    const run = vi.fn(async (args: string[]) => ({ code: 0, output: `${ok(false, 2)}\n`, log: ['NEXUS_OFFLINE_PC_V1 ok 200'] }));
    const status = await readOfflinePermissions(run);
    expect(status).toMatchObject({ enabled: false, remainingToggles: 2 });
    expect(run).toHaveBeenCalledWith([]);
    run.mockResolvedValueOnce({ code: 0, output: ok(true, 1), log: ['NEXUS_OFFLINE_PC_V1 ok 200'] });
    expect(await changeOfflinePermissions(run, true)).toMatchObject({ enabled: true, remainingToggles: 1 });
    expect(run).toHaveBeenLastCalledWith(['--set', 'true', '--confirm']);
    run.mockResolvedValueOnce({ code: 0, output: ok(false, 0), log: [] });
    await changeOfflinePermissions(run, false);
    expect(run).toHaveBeenLastCalledWith(['--set', 'false', '--confirm']);
  });
  it('hands the license cache to the backend so it can revoke stored licenses itself', async () => {
    const run = vi.fn(async (_args: string[]) => ({ code: 0, output: ok(false, 2), log: [] }));
    await readOfflinePermissions(run, '/data/license-cache');
    expect(run).toHaveBeenLastCalledWith(['--license-cache', '/data/license-cache']);
    await changeOfflinePermissions(run, false, '/data/license-cache');
    expect(run).toHaveBeenLastCalledWith(['--set', 'false', '--confirm', '--license-cache', '/data/license-cache']);
  });
  it('reports declined changes, transport failures and refusals with fixed messages', async () => {
    const declined = vi.fn(async () => ({ code: 1, output: ok(false, 0, false), log: ['NEXUS_OFFLINE_PC_V1 ok 200', 'NEXUS_OFFLINE_PC_V1 declined 200'] }));
    await expect(changeOfflinePermissions(declined, true)).rejects.toThrow('did not apply');
    const offline = vi.fn(async () => ({ code: 1, output: '', log: ['private@example.test', 'NEXUS_OFFLINE_PC_V1 request 0'] }));
    await expect(readOfflinePermissions(offline)).rejects.toThrow('could not be reached');
    await expect(readOfflinePermissions(offline)).rejects.not.toThrow('example.test');
    const refused = vi.fn(async () => ({ code: 1, output: '', log: ['NEXUS_OFFLINE_PC_V1 http 403'] }));
    await expect(readOfflinePermissions(refused)).rejects.toThrow('Sign in again');
    const silent = vi.fn(async () => ({ code: 2, output: '', log: [] }));
    await expect(readOfflinePermissions(silent)).rejects.toThrow('exited with code 2');
    const garbage = vi.fn(async () => ({ code: 0, output: 'no json here', log: ['NEXUS_OFFLINE_PC_V1 ok 200'] }));
    await expect(readOfflinePermissions(garbage)).rejects.toThrow('unreadable');
  });
  it('does not equate a zero exit status with an applied designation change', async () => {
    for(const response of [ok(false,2,false),ok(false,2,true)]) {
      const run=vi.fn(async()=>({code:0,output:response,log:[]}));
      await expect(changeOfflinePermissions(run,true)).rejects.toThrow('did not apply');
      expect(run).toHaveBeenCalledOnce();
    }
  });
});
