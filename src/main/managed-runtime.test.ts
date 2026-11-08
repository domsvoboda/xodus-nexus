import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RuntimeManager } from './runtime';
import { ManagedRuntimeManager } from './managed-runtime';
import { resolveRuntimeFamily, resolveRuntimeFamilyBuild } from './runtime-families';
import * as pointer from './runtime-pointer-commit';
const execute = promisify(execFile), hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex'), roots: string[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map(root => fs.rm(root, {
        recursive: true, force: true
    })));
});
const policy = {
    allowCachyos: true, allowPrerelease: true
};
async function payload(root: string, letter: string, family = 'nexus-cachyos') {
    const repository = 'domsvoboda/' + (family === 'nexus' ? 'nexus-runtime' : 'nexus-runtime-cachyos');
    const commit = letter.repeat(40), name = (family === 'nexus' ? 'nexus-runtime' : 'nexus-runtime-cachyos') + '-11.0-experimental-g' + commit.slice(0, 8), directory = path.join(root, 'remote-' + letter, name), files: Record<string, string> = {}, graph = {
        proton: commit, wine: 'c'.repeat(40), xgameruntime: 'd'.repeat(40), xml2Source: {
            commit: 'e'.repeat(40)
        }, modules: {
            dxvk: 'f'.repeat(40)
        }
    };
    const required = ['proton', 'files/bin/wine', 'files/bin/wineserver', 'files/bin/wine.nexus-original', ...['PlayFabGameSave.dll', 'gaming-services-version.exe', 'package-registration.exe'].map(n => 'files/share/xodus-nexus/compat/' + n), ...['x86_64', 'i386'].flatMap(cpu => ['xgameruntime.dll', 'winhttp.dll', 'libnghttp2.dll'].map(n => `files/lib/wine/${cpu}-windows/${n}`))];
    for (const file of required) {
        await fs.mkdir(path.dirname(path.join(directory, file)), {
            recursive: true
        });
        const bytes = 'inert synthetic ' + letter + ' ' + file;
        await fs.writeFile(path.join(directory, file), bytes, {
            mode: 0o755
        });
        files[file] = hash(bytes);
    }
    await fs.mkdir(path.join(directory, 'files/share/default_pfx/dosdevices'), {
        recursive: true
    });
    await fs.symlink('/', path.join(directory, 'files/share/default_pfx/dosdevices/z:'));
    const metadata = JSON.stringify({
        schema: 1, sourceLockSha256: '1'.repeat(64), sourceGraph: graph, requiresBackendVersion: '0.2.13', requiresLauncherVersion: '0.4.1'
    });
    await fs.writeFile(path.join(directory, 'XODUS_NEXUS_PATCH.json'), metadata);
    files['XODUS_NEXUS_PATCH.json'] = hash(metadata);
    const identity = {
        schema: 1, family, sourceRepository: repository, sourceCommit: commit, arch: 'x64', prefixSchema: 1, sourceLockSha256: '1'.repeat(64), files, symlinks: {
            'files/share/default_pfx/dosdevices/z:': '/'
        }
    };
    const buildId = hash(JSON.stringify(identity));
    await fs.writeFile(path.join(directory, 'nexus-family.json'), JSON.stringify({
        ...identity, buildId
    }));
    const archiveName = name + '-x86_64.tar.xz', archiveFile = path.join(root, archiveName);
    await execute('tar', ['-cJf', archiveFile, '-C', path.dirname(directory), name]);
    const archive = await fs.readFile(archiveFile), checksumName = name + '-x86_64.sha512sum', checksum = Buffer.from(createHash('sha512').update(archive).digest('hex') + '  ' + archiveName + '\n'), sourceName = name + '-source.tar.xz', sourceSum = name + '-source.sha512sum';
    const sourceBytes = Buffer.from('synthetic corresponding source'), sourceChecksum = Buffer.from(createHash('sha512').update(sourceBytes).digest('hex') + '  ' + sourceName + '\n');
    const assets = new Map<string, Buffer>([[archiveName, archive], [checksumName, checksum], [sourceName, sourceBytes], [sourceSum, sourceChecksum]]);
    const candidate = {
        schema: 1, kind: 'runtime', repository, commit, ref: 'refs/heads/main', runId: '123', files: [...assets].map(([name, bytes]) => ({
            name, sha256: hash(bytes), size: bytes.length
        })), sourceGraph: graph, requiresBackendVersion: '0.2.13', requiresLauncherVersion: '0.4.1', validation: {
            nativeGateCount: 12, treeSha256: '2'.repeat(64), resultsSha256: '3'.repeat(64), realGameTest: false, stableApproved: false
        }
    };
    const bytes = Buffer.from(JSON.stringify(candidate));
    assets.set('candidate.json', bytes);
    const tag = (family === 'nexus' ? 'runtime' : 'runtime-cachyos') + '-11.0-20261103-g' + commit.slice(0, 8), release = {
        tag_name: tag, target_commitish: commit, draft: false, prerelease: true, published_at: '2026-11-03T12:43:55Z', assets: [...assets].map(([name, bytes]) => ({
            name, size: bytes.length, browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${name}`
        }))
    };
    return {
        buildId, commit, archiveName, archiveFile, assets, release, bytes, candidate, directory
    };
}
/** Genuine local build output: no CI runId, explicit local non-promotable flags. */
async function localPayload(root: string, letter: string, family = 'nexus-cachyos') {
    const remote = await payload(root, letter, family);
    const candidate = { ...remote.candidate, localBuild: true, diagnosticOnly: true, promotable: false } as Record<string, unknown>;
    delete candidate.runId;
    const bytes = Buffer.from(JSON.stringify(candidate));
    remote.assets.set('candidate.json', bytes);
    return { ...remote, candidate, bytes };
}
async function fixture(family = 'nexus-cachyos') {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-install-'));
    roots.push(root);
    const runtimeRoot = path.join(root, 'runtime'), save = path.join(root, 'compatdata/game/pfx/save.dat');
    await fs.mkdir(path.dirname(save), {
        recursive: true
    });
    await fs.writeFile(save, 'preserve progress');
    const beforeSave = await fs.stat(save);
    await fs.mkdir(runtimeRoot, {
        recursive: true
    });
    const legacy = path.join(runtimeRoot, 'current.json');
    await fs.writeFile(legacy, 'legacy default untouched');
    const saveLink = path.join(path.dirname(save), 'runtime-link');
    await fs.symlink(legacy, saveLink);
    let remote = await payload(root, 'a', family);
    let held: Promise<void> | undefined;
    let entered: (() => void) | undefined;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/releases?'))
            return new Response(JSON.stringify([remote.release]));
        const name = url.split('/').pop()!;
        if (name.endsWith('-source.tar.xz') || name.endsWith('-source.sha512sum'))
            throw Error('Source archive must not be downloaded');
        if (name === remote.archiveName && held) {
            entered?.();
            await held;
        }
        const bytes = remote.assets.get(name);
        if (!bytes)
            throw Error('Unexpected closed request ' + url);
        return new Response(bytes);
    }) as unknown as typeof fetch;
    const manager = new RuntimeManager(runtimeRoot, () => {
    }, () => false, fetcher, 'x64', () => ({
        launcher: '0.4.2', backend: '0.2.14'
    }));
    const check = () => manager.checkManagedRuntime(family, policy), install = async () => {
        const status = await check();
        expect(status.error).toBeUndefined();
        return manager.installManagedRuntime(family, status.available!.candidateSha256, policy);
    };
    const preserved = async () => {
        expect(await fs.readFile(save, 'utf8')).toBe('preserve progress');
        expect((await fs.stat(save)).ino).toBe(beforeSave.ino);
        expect(await fs.readlink(saveLink)).toBe(legacy);
        expect(await fs.readFile(legacy, 'utf8')).toBe('legacy default untouched');
        expect(manager.current.winePath).toBeUndefined();
    };
    return {
        root, runtimeRoot, manager, fetcher, check, install, preserved, get remote() {
            return remote;
        }, setRemote: (next: typeof remote) => {
            remote = next;
        }, hold: () => {
            let resume!: () => void;
            held = new Promise<void>(r => resume = r);
            const waiting = new Promise<void>(r => entered = r);
            return {
                waiting, resume
            };
        }
    };
}
it('installs A then B, retains verified A, keeps default and nonempty saves unchanged, invalidates same-identity readiness', async () => {
    const f = await fixture();
    expect((await f.install()).success).toBe(true);
    const a = await resolveRuntimeFamily(f.runtimeRoot, 'nexus-cachyos', 'x64'), oldWine = await fs.stat(a.winePath);
    await f.preserved();
    f.setRemote(await payload(f.root, 'b'));
    const status = await f.manager.checkManagedRuntime('nexus-cachyos', {
        allowCachyos: false, allowPrerelease: true
    });
    expect(status.channel).toBe('prerelease');
    expect(status.updateAvailable).toBe(true);
    expect((await f.manager.installManagedRuntime('nexus-cachyos', status.available!.candidateSha256, {
        allowCachyos: false, allowPrerelease: true
    })).success).toBe(true);
    expect((await resolveRuntimeFamily(f.runtimeRoot, 'nexus-cachyos', 'x64')).buildId).toBe(f.remote.buildId);
    expect((await resolveRuntimeFamilyBuild(f.runtimeRoot, 'nexus-cachyos', a, 'x64')).buildId).toBe(a.buildId);
    expect((await fs.stat(a.winePath)).ino).toBe(oldWine.ino);
    const revision = f.manager.current.managedRevision!;
    expect((await f.install()).success).toBe(true);
    expect(f.manager.current.managedRevision).toBe(revision + 1);
    expect((await f.check()).updateAvailable).toBe(false);
    await f.preserved();
});
it('rejects stale targets, explicit prerelease opt-out and missing first CachyOS permission', async () => {
    const f = await fixture();
    const denied = await f.manager.checkManagedRuntime('nexus-cachyos', {
        allowCachyos: false, allowPrerelease: true
    });
    expect(denied.available).toBeUndefined();
    expect(denied.error).toContain('opt-in');
    const target = await f.check();
    expect((await f.manager.installManagedRuntime('nexus-cachyos', '0'.repeat(64), policy)).committed).toBe(false);
    expect((await f.manager.installManagedRuntime('nexus-cachyos', target.available!.candidateSha256, {
        allowCachyos: true, allowPrerelease: false
    })).committed).toBe(false);
    await f.preserved();
});
it('holds actual manager reservation through archive download and prevents root/settings races', async () => {
    const f = await fixture(), status = await f.check(), gate = f.hold();
    const job = f.manager.installManagedRuntime('nexus-cachyos', status.available!.candidateSha256, policy);
    await gate.waiting;
    expect(f.manager.busy).toBe(true);
    expect(() => f.manager.setRoot(path.join(f.root, 'other'))).toThrow();
    expect(() => f.manager.reserveSettingsChange()).toThrow();
    await expect(f.manager.installNexus(() => {
    })).rejects.toThrow();
    gate.resume();
    expect((await job).success).toBe(true);
    expect(f.manager.busy).toBe(false);
    await f.preserved();
});
it('fails safely for same-build payload corruption without replacing or deleting it', async () => {
    const f = await fixture();
    await f.install();
    const a = await resolveRuntimeFamily(f.runtimeRoot, 'nexus-cachyos', 'x64');
    await fs.writeFile(a.winePath, 'preserve corrupt evidence');
    const result = await f.install();
    expect(result.success).toBe(false);
    expect(result.committed).toBe(false);
    expect(result.error).toContain('preserved');
    expect(await fs.readFile(a.winePath, 'utf8')).toBe('preserve corrupt evidence');
    await f.preserved();
});
it('can recover to distinct verified B while preserving invalid old pointer as untrusted evidence', async () => {
    const f = await fixture();
    await f.install();
    const current = path.join(f.runtimeRoot, 'variants/nexus-cachyos/current.json');
    await fs.writeFile(current, 'invalid old pointer');
    f.setRemote(await payload(f.root, 'b'));
    expect((await f.install()).success).toBe(true);
    const evidence = path.join(f.runtimeRoot, 'variants/nexus-cachyos/preserved', hash('invalid old pointer') + '.json');
    expect(await fs.readFile(evidence, 'utf8')).toBe('invalid old pointer');
    await f.preserved();
});
it('rejects validly downloaded but candidate-mismatched embedded graph before changing active selection', async () => {
    const f = await fixture();
    f.remote.candidate.sourceGraph.modules.dxvk = '0'.repeat(40);
    const bytes = Buffer.from(JSON.stringify(f.remote.candidate));
    f.remote.assets.set('candidate.json', bytes);
    f.remote.release.assets.find(a => a.name === 'candidate.json')!.size = bytes.length;
    const result = await f.install();
    expect(result.success).toBe(false);
    expect(result.error).toContain('source graph');
    await expect(fs.access(path.join(f.runtimeRoot, 'variants/nexus-cachyos/current.json'))).rejects.toThrow();
    await f.preserved();
});
it('reports visible commit with unknown durability instead of pretending the old selection survived', async () => {
    const f = await fixture(), real = pointer.commitRuntimePointer;
    vi.spyOn(pointer, 'commitRuntimePointer').mockImplementation((root, record) => real(root, record, {
        ...fs, open: async (file, flags, mode) => {
            const handle = await fs.open(file, flags, mode);
            return file === root ? {
                writeFile: async () => {
                }, sync: async () => {
                    throw Error('injected directory sync');
                }, close: () => handle.close()
            } : handle;
        }
    }));
    const result = await f.install();
    expect(result.success).toBe(false);
    expect(result.committed).toBe(true);
    expect(result.durability).toBe('unknown');
    expect((await resolveRuntimeFamily(f.runtimeRoot, 'nexus-cachyos', 'x64')).buildId).toBe(f.remote.buildId);
    expect(f.manager.busy).toBe(false);
    await f.preserved();
});
it('clears checking after initial status callback failure and guarantees lease release despite completion/notify exceptions', async () => {
    const f = await fixture();
    let released = 0, broken = true;
    const raw = new ManagedRuntimeManager({
        root: () => f.runtimeRoot, reserve: () => ({
            root: f.runtimeRoot, release: () => {
                released++;
            }
        }), versions: () => ({
            launcher: '0.4.2', backend: '0.2.14'
        }), completed: () => {
            broken = true;
            throw Error('completion failure');
        }, notify: () => {
            if (broken)
                throw Error('notify failure');
        }, fetcher: f.fetcher, arch: 'x64'
    });
    expect((await raw.check('nexus-cachyos', policy)).checking).toBe(false);
    broken = false;
    const status = await raw.check('nexus-cachyos', policy);
    broken = false;
    const result = await raw.install('nexus-cachyos', status.available!.candidateSha256, policy);
    expect(result.success).toBe(false);
    expect(released).toBe(1);
    expect(result.committed).toBe(true);
    expect(result.error).toContain('completion failure');
    expect(result.error).toContain('notify failure');
});
it('installs the standard managed family without changing legacy selection or requiring Cachy opt-in', async () => {
    const f = await fixture('nexus');
    const status = await f.manager.checkManagedRuntime('nexus', {
        allowCachyos: false, allowPrerelease: true
    });
    expect(status.error).toBeUndefined();
    const result = await f.manager.installManagedRuntime('nexus', status.available!.candidateSha256, {
        allowCachyos: false, allowPrerelease: true
    });
    expect(result.success).toBe(true);
    expect((await resolveRuntimeFamily(f.runtimeRoot, 'nexus', 'x64')).buildId).toBe(f.remote.buildId);
    await f.preserved();
});
it('selects supported latest metadata before parsing irrelevant legacy or incompatible historic releases', async () => {
    const f = await fixture(), original = vi.mocked(f.fetcher).getMockImplementation()!;
    const legacy = {
        ...f.remote.release, tag_name: 'runtime-cachyos-old', published_at: '2026-10-01T00:00:00Z', assets: []
    }, old = {
        ...f.remote.release, published_at: '2026-10-02T00:00:00Z', assets: [f.remote.release.assets.find(a => a.name === 'candidate.json')]
    };
    vi.mocked(f.fetcher).mockImplementation(async (input, init) => String(input).includes('/releases?') ? new Response(JSON.stringify([legacy, old, f.remote.release])) : original(input, init));
    expect((await f.check()).available).toBeDefined();
});
it('does not fall back past a malformed newest supported candidate', async () => {
    const f = await fixture();
    const broken = {
        ...f.remote.release, published_at: '2026-11-04T00:00:00Z', assets: f.remote.release.assets.filter(a => !a.name.endsWith('-source.sha512sum'))
    };
    vi.mocked(f.fetcher).mockResolvedValue(new Response(JSON.stringify([f.remote.release, broken])));
    const status = await f.check();
    expect(status.available).toBeUndefined();
    expect(status.error).toBeTruthy();
});
it('does not reconcile stale A status after B has committed', async () => {
    const f = await fixture();
    await f.install();
    const raw = (f.manager as any).managed as ManagedRuntimeManager, original = (raw as any).installed.bind(raw);
    let resume!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => resume = r), waiting = new Promise<void>(r => entered = r);
    let held = true;
    vi.spyOn(raw as any, 'installed').mockImplementation(async (...args: any[]) => {
        const value = await original(...args);
        if (held && args[0] === 'nexus-cachyos') {
            held = false;
            entered();
            await gate;
        }
        return value;
    });
    const old = raw.refresh();
    await waiting;
    f.setRemote(await payload(f.root, 'b'));
    expect((await f.install()).success).toBe(true);
    resume();
    await old;
    expect(raw.current.find(s => s.id === 'nexus-cachyos')?.installed?.buildId).toBe(f.remote.buildId);
});

it('checks updates within the recorded prerelease channel even when a stable release is newer',async()=>{
 const f=await fixture();await f.install();f.setRemote(await payload(f.root,'b'));const stable=await payload(f.root,'c');stable.release.prerelease=false;stable.release.published_at='2026-11-05T00:00:00Z';const original=vi.mocked(f.fetcher).getMockImplementation()!;
 vi.mocked(f.fetcher).mockImplementation(async(input,init)=>String(input).includes('/releases?')?new Response(JSON.stringify([stable.release,f.remote.release])):original(input,init));
 const checked=await f.manager.checkManagedRuntimeUpdate('nexus-cachyos','prerelease');expect(checked.available?.sourceCommit).toBe(f.remote.commit);await expect(f.manager.checkManagedRuntimeUpdate('nexus-cachyos','stable')).rejects.toThrow('channel changed');await f.preserved();
});

it('does not fall back past a newest candidate with an unknown channel flag',async()=>{
 const f=await fixture();await f.install();f.setRemote(await payload(f.root,'b'));const malformed=await payload(f.root,'c');delete (malformed.release as {prerelease?:boolean}).prerelease;malformed.release.published_at='2026-11-05T00:00:00Z';const original=vi.mocked(f.fetcher).getMockImplementation()!;
 vi.mocked(f.fetcher).mockImplementation(async(input,init)=>String(input).includes('/releases?')?new Response(JSON.stringify([malformed.release,f.remote.release])):original(input,init));
 const checked=await f.manager.checkManagedRuntimeUpdate('nexus-cachyos','prerelease');expect(checked.available).toBeUndefined();expect(checked.error).toContain('prerelease');await f.preserved();
});

it('installs an exact issued target after a later check selects another release, never the replacement',async()=>{
 const f=await fixture();await f.install();f.setRemote(await payload(f.root,'b'));await f.manager.checkManagedRuntimeUpdate('nexus-cachyos','prerelease');const prepared=f.manager.managedTarget('nexus-cachyos')!;
 const selectedCommit=prepared.commit,old=f.remote;f.setRemote(await payload(f.root,'c'));await f.manager.checkManagedRuntime('nexus-cachyos',policy);expect(f.manager.managedTarget('nexus-cachyos')!.commit).not.toBe(selectedCommit);
 const latest=f.remote,original=vi.mocked(f.fetcher).getMockImplementation()!;
 vi.mocked(f.fetcher).mockImplementation(async(input,init)=>{const name=String(input).split('/').pop()!;const bytes=old.assets.get(name);return bytes?new Response(bytes):original(input,init);});
 const forged=await f.manager.installPreparedManagedRuntime('nexus-cachyos',{...prepared},policy);expect(forged.committed).toBe(false);expect(forged.success).toBe(false);
 const result=await f.manager.installPreparedManagedRuntime('nexus-cachyos',prepared,policy);expect(result.success).toBe(true);const installed=f.manager.current.managedFamilies!.find(row=>row.id==='nexus-cachyos')!.installed!;expect(installed.sourceCommit).toBe(selectedCommit);expect(installed.displayWinePath).toBe((await resolveRuntimeFamily(f.runtimeRoot,'nexus-cachyos','x64')).winePath);expect(latest.commit).not.toBe(selectedCommit);await f.preserved();
});

it('imports a verified local build output through the same family contract without a network release', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-local-import-'));
    roots.push(root);
    const runtimeRoot = path.join(root, 'runtime'); await fs.mkdir(runtimeRoot, { recursive: true });
    const remote = await localPayload(root, 'a');
    const directory = path.join(root, 'local-build'); await fs.mkdir(directory);
    for (const [name, bytes] of remote.assets) await fs.writeFile(path.join(directory, name), bytes);
    const fetcher = vi.fn(async () => { throw Error('Local import must not use the network'); }) as unknown as typeof fetch;
    const manager = new RuntimeManager(runtimeRoot, () => {}, () => false, fetcher, 'x64', () => ({ launcher: '0.5.0', backend: '0.2.14' }));
    const result = await manager.importManagedRuntime('nexus-cachyos', directory, policy);
    expect(result).toMatchObject({ family: 'nexus-cachyos', success: true, committed: true, durability: 'confirmed' });
    const installed = await resolveRuntimeFamily(runtimeRoot, 'nexus-cachyos', 'x64');
    expect(installed.buildId).toBe(remote.buildId);
    const pointer = JSON.parse(await fs.readFile(path.join(runtimeRoot, 'variants/nexus-cachyos/current.json'), 'utf8'));
    expect(pointer.releaseTag).toMatch(/^runtime-cachyos-local-g[a-f0-9]{8}$/);
    expect(pointer.prerelease).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
});

it('rejects a local inventory byte change between the candidate snapshot and copied staging', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-local-tamper-'));
    roots.push(root);
    const runtimeRoot = path.join(root, 'runtime'); await fs.mkdir(runtimeRoot, { recursive: true });
    const remote = await localPayload(root, 'a');
    const directory = path.join(root, 'local-build'); await fs.mkdir(directory);
    for (const [name, bytes] of remote.assets) await fs.writeFile(path.join(directory, name), bytes);
    const original = fs.copyFile.bind(fs);
    vi.spyOn(fs, 'copyFile').mockImplementation(async (source, destination, mode) => {
        await original(source, destination, mode as never);
        if (String(destination).endsWith(remote.archiveName)) await fs.writeFile(destination, Buffer.from('changed after copy'));
    });
    const fetcher = vi.fn(async () => { throw Error('Local import must not use the network'); }) as unknown as typeof fetch;
    const manager = new RuntimeManager(runtimeRoot, () => {}, () => false, fetcher, 'x64', () => ({ launcher: '0.5.0', backend: '0.2.14' }));
    const result = await manager.importManagedRuntime('nexus-cachyos', directory, policy);
    expect(result).toMatchObject({ family: 'nexus-cachyos', success: false, committed: false });
    await expect(fs.access(path.join(runtimeRoot, 'variants/nexus-cachyos/current.json'))).rejects.toThrow();
    await expect(resolveRuntimeFamily(runtimeRoot, 'nexus-cachyos', 'x64')).rejects.toThrow();
});

it('rejects a symlinked local inventory input and leaves no active receipt', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-local-symlink-'));
    roots.push(root);
    const runtimeRoot = path.join(root, 'runtime'); await fs.mkdir(runtimeRoot, { recursive: true });
    const remote = await localPayload(root, 'a');
    const directory = path.join(root, 'local-build'); await fs.mkdir(directory);
    for (const [name, bytes] of remote.assets) await fs.writeFile(path.join(directory, name), bytes);
    const archive = path.join(directory, remote.archiveName), real = path.join(root, 'real-archive');
    await fs.rename(archive, real); await fs.symlink(real, archive);
    const fetcher = vi.fn(async () => { throw Error('Local import must not use the network'); }) as unknown as typeof fetch;
    const manager = new RuntimeManager(runtimeRoot, () => {}, () => false, fetcher, 'x64', () => ({ launcher: '0.5.0', backend: '0.2.14' }));
    const result = await manager.importManagedRuntime('nexus-cachyos', directory, policy);
    expect(result).toMatchObject({ family: 'nexus-cachyos', success: false, committed: false });
    await expect(fs.access(path.join(runtimeRoot, 'variants/nexus-cachyos/current.json'))).rejects.toThrow();
    await expect(resolveRuntimeFamily(runtimeRoot, 'nexus-cachyos', 'x64')).rejects.toThrow();
});
