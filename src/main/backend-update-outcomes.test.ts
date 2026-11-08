import {createHash} from 'node:crypto';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BackendManager, BackendMutationError } from './backend.js';
import { discoverBackend, installBackend, type BackendArtifact } from './backend-releases.js';
import { backendLock, backendRecipeSha256 } from './backend-package.js';
vi.mock('./backend-releases.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./backend-releases.js')>();
  return { ...actual, discoverBackend: vi.fn(), installBackend: vi.fn() };
});
vi.mock('./process.js', () => ({ run: vi.fn(async () => ({ code: 0, output: '' })) }));
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const artifact = (version = '99.0.0'): BackendArtifact => ({ repository: 'domsvoboda/nexus-backend', tag: `backend-v${version}`, archiveUrl: 'https://example.invalid/unused', manifest: { version, commit: backendLock.commit, compatibility: backendLock.compatibility, recipeSha256: backendRecipeSha256 } } as BackendArtifact);
let root: string;
beforeEach(async () => { vi.resetAllMocks(); root = await fs.mkdtemp(path.join(os.tmpdir(),'backend-update-outcomes-')); await fs.mkdir(path.join(root, 'xodus-backends')); vi.mocked(discoverBackend).mockResolvedValue(artifact()); vi.mocked(installBackend).mockResolvedValue(path.join(root, 'selected/xodus-cli')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
function manager() { const result = new BackendManager(root, '', () => {}, () => false); vi.spyOn(result, 'externalDownloadRunning').mockResolvedValue(false); return result; }
function refreshSelected(m: BackendManager) { return vi.spyOn(m, 'refresh').mockImplementation(async () => { expect(m.current.available).toBe(false); expect(m.current.capabilities.login).toBe(false); Object.assign((m as unknown as { status: object }).status, { available: true }); return m.current; }); }
describe('backend mutation boundaries', () => {
  it('reserves update before activity await and excludes a second mutation', async () => {
    const m = manager(), gate = deferred<boolean>(); vi.mocked(m.externalDownloadRunning).mockReturnValue(gate.promise);
    const pending = m.update(() => {}).catch(e => e); expect(m.current.updating).toBe(true);
    await expect(m.update(() => {})).rejects.toThrow('already running');
    gate.resolve(true); expect(await pending).toMatchObject({ committed: false, operation: 'update' }); expect(m.current.updating).toBe(false); expect(installBackend).not.toHaveBeenCalled();
  });
  it('releases update reservation when first notification throws', async () => {
    const m = manager(); const error = await m.update(() => { throw Error('notify'); }).catch(e => e);
    expect(error).toBeInstanceOf(BackendMutationError); expect(error).toMatchObject({ committed: false, operation: 'update' }); expect(m.current.updating).toBe(false); expect(discoverBackend).not.toHaveBeenCalled();
  });
  it('does not expose a source-build backend mutation', () => {
    expect((manager() as unknown as {rebuild?: unknown}).rebuild).toBeUndefined();
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
  it('never downgrades a local backend to an older published release, but offers the exact official same version', async () => {
    const m=manager(), pointer=path.join(root,'xodus-backends/current.json');
    await fs.writeFile(pointer,JSON.stringify({binaryPath:'/local/xodus-cli',commit:'e7884a27f698c7447b96b431b2935f9ed50677f5',delivery:'local',version:'0.2.15'}));
    Object.assign((m as unknown as {status:object}).status,{available:true,source:'managed',binaryPath:'/local/xodus-cli'});
    vi.mocked(discoverBackend).mockResolvedValue(artifact('0.2.14'));
    expect((await m.checkUpdate()).updateAvailable).toBe(false);
    vi.mocked(discoverBackend).mockResolvedValue(artifact('0.2.15'));
    expect((await m.checkUpdate()).updateAvailable).toBe(true);
  });
  it('prepares no install for an absent, external or locally built backend', async () => {
    const m=manager(); for (const source of ['none','external','managed']) {
      Object.assign((m as unknown as {status:object}).status,{available:source!=='none',source});
      await fs.writeFile(path.join(root,'xodus-backends/current.json'),JSON.stringify({binaryPath:'/local',delivery:'local'}));
      expect((await m.prepareComponentUpdate(()=>{})).item.state).toBe('skipped');
    }
    expect(discoverBackend).not.toHaveBeenCalled(); expect(installBackend).not.toHaveBeenCalled();
  });
  it('applies only its prepared target and rejects a pointer changed after planning', async () => {
    const m=manager(),pointer=path.join(root,'xodus-backends/current.json');
    await fs.writeFile(pointer,JSON.stringify({binaryPath:'/old',delivery:'release',version:'1.0.0'}));
    Object.assign((m as unknown as {status:object}).status,{available:true,source:'managed',binaryPath:'/old'});
    const prepared=await m.prepareComponentUpdate(()=>{});expect(prepared.item.state).toBe('ready');
    await fs.writeFile(pointer,'changed');expect(await prepared.isCurrent()).toBe(false);
    await expect(prepared.apply({identity:Symbol()})).rejects.toMatchObject({committed:false});expect(installBackend).not.toHaveBeenCalled();
  });
  it('preserves newer discovery completed before a frozen plan begins applying',async()=>{
    const m=manager();await fs.writeFile(path.join(root,'xodus-backends/current.json'),JSON.stringify({binaryPath:'/old',delivery:'release',version:'1.0.0'}));Object.assign((m as unknown as {status:object}).status,{available:true,source:'managed',binaryPath:'/old'});
    vi.mocked(discoverBackend).mockResolvedValueOnce(artifact('99.0.0')).mockResolvedValueOnce(artifact('100.0.0'));
    const prepared=await m.prepareComponentUpdate(()=>{});await m.checkUpdate();refreshSelected(m);await prepared.apply({identity:Symbol()});expect(m.current.version).toBe('99.0.0');expect(m.current.releaseVersion).toBe('100.0.0');expect(m.current.updateAvailable).toBe(true);
  });
  it.each(['binary','service','recipe','delivery'])('rejects changed %s during committed backend reconciliation',async change=>{
    const m=manager(),pointer=path.join(root,'xodus-backends/current.json'),directory=path.join(root,'xodus-backends/releases/verified');await fs.mkdir(directory,{recursive:true});
    const files:Record<string,string>={};for(const name of ['xodus-cli','xodus-service','LICENSE']){const bytes=Buffer.from('verified-'+name);await fs.writeFile(path.join(directory,name),bytes);files[name]=createHash('sha256').update(bytes).digest('hex');}
    const selected=artifact();selected.manifest.files=files as typeof selected.manifest.files;vi.mocked(discoverBackend).mockResolvedValue(selected);vi.mocked(installBackend).mockResolvedValue(path.join(directory,'xodus-cli'));
    await fs.writeFile(pointer,JSON.stringify({binaryPath:'/old',delivery:'release',version:'1.0.0'}));Object.assign((m as unknown as {status:object}).status,{available:true,source:'managed',binaryPath:'/old'});
    vi.spyOn(m,'refresh').mockImplementation(async()=>{Object.assign((m as unknown as {status:object}).status,{available:true});return m.current;});
    let calls=0;const prepared=await m.prepareComponentUpdate(()=>{if(++calls===2)throw Error('notify after commit');});await expect(prepared.apply({identity:Symbol()})).rejects.toMatchObject({committed:true});await expect(prepared.reconcile!({identity:Symbol()})).resolves.toEqual({});
    if(change==='binary'||change==='service')await fs.writeFile(path.join(directory,change==='binary'?'xodus-cli':'xodus-service'),'corrupted');else{const actual=JSON.parse(await fs.readFile(pointer,'utf8'));if(change==='recipe')actual.recipeSha256='changed';else actual.delivery='local';await fs.writeFile(pointer,JSON.stringify(actual));}
    await expect(prepared.reconcile!({identity:Symbol()})).rejects.toMatchObject({retryable:false});expect(installBackend).toHaveBeenCalledOnce();
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
