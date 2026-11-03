import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BackendManager, BackendMutationError } from './backend.js';
import { discoverBackend, installBackend, type BackendArtifact } from './backend-releases.js';
import { backendLock, backendRecipeSha256 } from './backend-package.js';
vi.mock('./backend-releases.js', () => ({ discoverBackend: vi.fn(), installBackend: vi.fn() }));
vi.mock('./process.js', () => ({ run: vi.fn(async () => ({ code: 0, output: '' })) }));
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const artifact = (version = '99.0.0'): BackendArtifact => ({ repository: 'domsvoboda/nexus-backend', tag: `backend-v${version}`, archiveUrl: 'https://example.invalid/unused', manifest: { version, commit: backendLock.commit, compatibility: backendLock.compatibility, recipeSha256: backendRecipeSha256 } } as BackendArtifact);
let root: string;
beforeEach(async () => { vi.resetAllMocks(); root = await fs.mkdtemp('/mnt/data/XodusNexus-work/builds/backend-update-outcomes-'); await fs.mkdir(path.join(root, 'xodus-backends')); vi.mocked(discoverBackend).mockResolvedValue(artifact()); vi.mocked(installBackend).mockResolvedValue(path.join(root, 'selected/xodus-cli')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
function manager() { const result = new BackendManager(root, '', () => {}, () => false); vi.spyOn(result, 'externalDownloadRunning').mockResolvedValue(false); return result; }
function refreshSelected(m: BackendManager) { return vi.spyOn(m, 'refresh').mockImplementation(async () => { expect(m.current.available).toBe(false); expect(m.current.capabilities.login).toBe(false); Object.assign((m as unknown as { status: object }).status, { available: true }); return m.current; }); }
describe('backend mutation boundaries', () => {
  it.each(['update', 'rebuild'] as const)('reserves %s before activity await and excludes both mutations', async operation => {
    const m = manager(), gate = deferred<boolean>(); vi.mocked(m.externalDownloadRunning).mockReturnValue(gate.promise);
    const pending = m[operation](() => {}).catch(e => e); expect(m.current.updating).toBe(true);
    await expect(m.update(() => {})).rejects.toThrow('already running'); await expect(m.rebuild(() => {})).rejects.toThrow('already running');
    gate.resolve(true); expect(await pending).toMatchObject({ committed: false, operation }); expect(m.current.updating).toBe(false); expect(installBackend).not.toHaveBeenCalled();
  });
  it.each(['update', 'rebuild'] as const)('releases %s reservation when first notification throws', async operation => {
    const m = manager(); const error = await m[operation](() => { throw Error('notify'); }).catch(e => e);
    expect(error).toBeInstanceOf(BackendMutationError); expect(error).toMatchObject({ committed: false, operation }); expect(m.current.updating).toBe(false); expect(discoverBackend).not.toHaveBeenCalled();
  });
  it('preserves the old pointer when installation fails', async () => {
    const m = manager(), pointer = path.join(root, 'xodus-backends/current.json'); await fs.writeFile(pointer, 'old-pointer'); vi.mocked(installBackend).mockRejectedValue(Error('download failed'));
    await expect(m.update(() => {})).rejects.toMatchObject({ committed: false }); expect(await fs.readFile(pointer, 'utf8')).toBe('old-pointer'); expect(m.current.updating).toBe(false);
  });
  it('reports committed activation and clears stale capabilities before failed refresh', async () => {
    const m = manager(); Object.assign((m as unknown as { status: object }).status, { available: true, capabilities: { login: true } });
    vi.spyOn(m, 'refresh').mockImplementation(async () => { expect(m.current.available).toBe(false); expect(m.current.capabilities.login).toBe(false); throw Error('probe failed'); });
    const error = await m.update(() => {}).catch(e => e); expect(error).toMatchObject({ committed: true, target: { binaryPath: path.join(root, 'selected/xodus-cli') } });
    expect(JSON.parse(await fs.readFile(path.join(root, 'xodus-backends/current.json'), 'utf8')).binaryPath).toBe(error.target.binaryPath); expect(m.current.available).toBe(false); expect(m.current.phase).toContain('activated'); expect(m.current.updating).toBe(false);
  });
  it('does not present a fallback external backend as successful selected activation', async () => {
    const m = manager(); vi.spyOn(m, 'refresh').mockImplementation(async () => {
      Object.assign((m as unknown as { status: object }).status, { available: true, source: 'external', binaryPath: '/external/other', capabilities: { login: true } }); return m.current;
    });
    await expect(m.update(() => {})).rejects.toMatchObject({ committed: true });
    expect(m.current.available).toBe(false); expect(m.current.capabilities.login).toBe(false); expect(m.current.source).toBe('managed'); expect(m.current.binaryPath).toBe(path.join(root, 'selected/xodus-cli'));
  });
  it('retains the activation failure and notification failure without leaking admission', async () => {
    const m = manager(); vi.mocked(installBackend).mockRejectedValue(Error('download failed')); let calls = 0;
    const error = await m.update(() => { if (++calls === 2) throw Error('notification failed'); }).catch(e => e);
    expect(error).toMatchObject({ committed: false }); expect(error.cause).toBeInstanceOf(AggregateError);
    expect(error.cause.errors.map((e: Error) => e.message)).toEqual(['download failed', 'notification failed']); expect(m.current.updating).toBe(false);
    vi.mocked(installBackend).mockResolvedValue(path.join(root, 'selected/xodus-cli')); refreshSelected(m); await expect(m.update(() => {})).resolves.toBeUndefined();
  });
  it('discards a delayed old refresh after a new pointer is published and reconciled', async () => {
    const m = manager(), entered = deferred<void>(), release = deferred<void>();
    await fs.writeFile(path.join(root, 'xodus-backends/current.json'), JSON.stringify({ binaryPath: '/old/xodus-cli', commit: 'old', recipeSha256: 'old-recipe' }));
    const internals = m as unknown as { validate(binary: string): Promise<{ commands: string[]; login: boolean; streaming: boolean }> };
    vi.spyOn(internals, 'validate').mockImplementation(async binary => { if (binary === '/old/xodus-cli') { entered.resolve(); await release.promise; } return { commands: [], login: true, streaming: true }; });
    const oldRefresh = m.refresh(); await entered.promise; await m.update(() => {}); release.resolve(); await oldRefresh;
    expect(m.current.binaryPath).toBe(path.join(root, 'selected/xodus-cli')); expect(m.current.commit).toBe(backendLock.commit); expect(m.current.recipeSha256).toBe(backendRecipeSha256);
  });
  it('keeps operation target A while concurrent discovery records newer B', async () => {
    const m = manager(), entered = deferred<void>(), release = deferred<void>(); refreshSelected(m);
    vi.mocked(discoverBackend).mockResolvedValueOnce(artifact('99.0.0')).mockResolvedValueOnce(artifact('100.0.0'));
    vi.mocked(installBackend).mockImplementation(async (_root, selected) => { expect(selected.manifest.version).toBe('99.0.0'); entered.resolve(); await release.promise; return path.join(root, 'selected/xodus-cli'); });
    const update = m.update(() => {}); await entered.promise; await m.checkUpdate(); release.resolve(); await update;
    expect(JSON.parse(await fs.readFile(path.join(root, 'xodus-backends/current.json'), 'utf8')).version).toBe('99.0.0'); expect(m.current.releaseVersion).toBe('100.0.0'); expect(m.current.updateAvailable).toBe(true);
  });
  it('reports a final notification failure as committed without disabling verified backend', async () => {
    const m = manager(); refreshSelected(m); let calls = 0;
    await expect(m.update(() => { if (++calls === 2) throw Error('final notify'); })).rejects.toMatchObject({ committed: true });
    expect(m.current.available).toBe(true); expect(m.current.updating).toBe(false); expect(m.current.phase).toContain('activated');
  });
});
