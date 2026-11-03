import {afterEach,expect,it,vi} from 'vitest';
import {promises as fs} from 'node:fs';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {RuntimeManager} from './runtime';import * as processModule from './process';
const execute=promisify(execFile),hash=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex'),roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
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
    const assets = new Map<string, Buffer>([[archiveName, archive], [checksumName, checksum], [sourceName, Buffer.from('not downloaded source')], [sourceSum, Buffer.from('not downloaded source sum')]]);
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

async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'legacy-update-'));roots.push(root);const runtimeRoot=path.join(root,'runtime'),old=await payload(root,'a','nexus'),remote=await payload(root,'b','nexus');remote.release.prerelease=false;old.release.prerelease=false;
 const oldRoot=path.join(runtimeRoot,'releases',path.basename(old.directory));await fs.mkdir(path.dirname(oldRoot),{recursive:true});await fs.cp(old.directory,oldRoot,{recursive:true,verbatimSymlinks:true});const wine=path.join(oldRoot,'files/bin/wine'),pointerFile=path.join(runtimeRoot,'current.json'),oldPointer=JSON.stringify({name:path.basename(oldRoot),winePath:wine,commit:old.release.tag_name,installedAt:'before'});await fs.writeFile(pointerFile,oldPointer);
 const save=path.join(root,'compatdata/game/pfx/progress');await fs.mkdir(path.dirname(save),{recursive:true});await fs.writeFile(save,'nonempty progress');const saveIno=(await fs.stat(save)).ino,oldWineIno=(await fs.stat(wine)).ino;await fs.symlink(wine,path.join(path.dirname(save),'runtime-link'));
 let configured=wine;const fetcher=vi.fn(async(input:RequestInfo|URL)=>{const url=String(input);if(url.includes('/releases/tags/'))return new Response(JSON.stringify(old.release));if(url.includes('/releases?'))return new Response(JSON.stringify([remote.release]));const bytes=remote.assets.get(url.split('/').pop()!);if(!bytes)throw Error('Unexpected closed fixture URL');return new Response(bytes);}) as unknown as typeof fetch;
 vi.spyOn(processModule,'run').mockImplementation(async command=>{if(path.basename(command)==='wine')return{code:0,output:'wine synthetic, never executed'};throw Error('Unexpected runtime execution');});
 const manager=new RuntimeManager(runtimeRoot,()=>{},()=>false,fetcher,'x64',()=>({launcher:'0.4.2',backend:'0.2.14'}));
 const callbacks={configuredWine:()=>configured,persistSelection:vi.fn(async(value:string)=>{configured=value;}),refreshAccount:vi.fn(async()=>{})};
 const preserved=async()=>{expect(await fs.readFile(save,'utf8')).toBe('nonempty progress');expect((await fs.stat(save)).ino).toBe(saveIno);expect((await fs.stat(wine)).ino).toBe(oldWineIno);expect(await fs.readlink(path.join(path.dirname(save),'runtime-link'))).toBe(wine);};
 return{root,runtimeRoot,old,remote,manager,callbacks,fetcher,pointerFile,oldPointer,preserved,setConfigured:(value:string)=>configured=value};
}
it('prepares and applies the exact trusted Standard release without changing prefix/save/root and records exact up-to-date identity',async()=>{
 const f=await fixture(),prepared=await f.manager.prepareLegacyManagedUpdate(f.callbacks.configuredWine());expect(prepared.skipReason).toBeUndefined();expect(prepared.target?.version).toBe(f.remote.release.tag_name);expect(Object.isFrozen(prepared.target)).toBe(true);
 expect((await f.manager.applyLegacyManagedUpdate(prepared.target,f.callbacks)).success).toBe(true);const pointer=JSON.parse(await fs.readFile(f.pointerFile,'utf8'));expect(pointer.candidateSha256).toBe(prepared.target!.candidateSha256);expect(pointer.sourceRepository).toBe('domsvoboda/nexus-runtime');expect(pointer.prerelease).toBe(false);expect(f.callbacks.persistSelection).toHaveBeenCalledOnce();expect(f.callbacks.refreshAccount).toHaveBeenCalledOnce();expect(f.manager.current.runtimeRoot).toBe(f.runtimeRoot);expect((await f.manager.prepareLegacyManagedUpdate(f.callbacks.configuredWine())).skipReason).toContain('already current');await f.preserved();
});
it('skips external custom Wine and unsupported preview without checking/downloading releases',async()=>{
 const f=await fixture();expect((await f.manager.prepareLegacyManagedUpdate('/custom/wine')).target).toBeUndefined();expect(f.fetcher).not.toHaveBeenCalled();await fs.writeFile(f.pointerFile,JSON.stringify({name:'proton-xodus-preview',winePath:f.callbacks.configuredWine(),commit:'unknown'}));expect((await f.manager.prepareLegacyManagedUpdate('')).target).toBeUndefined();expect(f.fetcher).not.toHaveBeenCalled();await f.preserved();
});
it('rejects forged targets and preserves a newly selected custom Wine after preparation',async()=>{
 const f=await fixture(),{target}=await f.manager.prepareLegacyManagedUpdate(f.callbacks.configuredWine());await expect(f.manager.applyLegacyManagedUpdate({...target},f.callbacks)).rejects.toThrow('Unknown prepared');f.setConfigured('/custom/new-wine');const result=await f.manager.applyLegacyManagedUpdate(target,f.callbacks);expect(result.committed).toBe(false);expect(f.callbacks.persistSelection).not.toHaveBeenCalled();expect(await fs.readFile(f.pointerFile,'utf8')).toBe(f.oldPointer);await f.preserved();
});
it('rechecks captured old pointer immediately before activation rather than overwriting another selection',async()=>{
 const f=await fixture(),{target}=await f.manager.prepareLegacyManagedUpdate(f.callbacks.configuredWine()),original=vi.mocked(f.fetcher).getMockImplementation()!,replacement=f.oldPointer+' ';
 vi.mocked(f.fetcher).mockImplementation(async(input,init)=>{if(String(input).endsWith('.tar.xz'))await fs.writeFile(f.pointerFile,replacement);return original(input,init);});
 const result=await f.manager.applyLegacyManagedUpdate(target,f.callbacks);expect(result.committed).toBe(false);expect(await fs.readFile(f.pointerFile,'utf8')).toBe(replacement);expect(f.callbacks.persistSelection).not.toHaveBeenCalled();await f.preserved();
});
it('keeps committed pointer truthfully visible when settings synchronization fails',async()=>{
 const f=await fixture(),{target}=await f.manager.prepareLegacyManagedUpdate(f.callbacks.configuredWine());f.callbacks.persistSelection.mockRejectedValue(Error('settings fixture failed'));const result=await f.manager.applyLegacyManagedUpdate(target,f.callbacks);expect(result.success).toBe(false);expect(result.committed).toBe(true);expect(result.error).toContain('runtime was activated');expect(JSON.parse(await fs.readFile(f.pointerFile,'utf8')).candidateSha256).toBe(target!.candidateSha256);expect(f.callbacks.refreshAccount).not.toHaveBeenCalled();expect(f.manager.busy).toBe(false);await f.preserved();
});

it('does not overwrite a custom or preview path merely because it is inside releases',async()=>{
 const f=await fixture();for(const name of ['custom-wine','nexus-runtime-preview-xgamesave-pr28'])expect((await f.manager.prepareLegacyManagedUpdate(path.join(f.runtimeRoot,'releases',name,'files/bin/wine'))).target).toBeUndefined();expect(f.fetcher).not.toHaveBeenCalled();await f.preserved();
});
it('requires genuine fixed-repository installed-tag channel evidence for an old pointer with no recorded channel',async()=>{
 const f=await fixture(),original=vi.mocked(f.fetcher).getMockImplementation()!;vi.mocked(f.fetcher).mockImplementation(async(input,init)=>String(input).includes('/releases/tags/')?new Response('not found',{status:404}):original(input,init));const prepared=await f.manager.prepareLegacyManagedUpdate(f.callbacks.configuredWine());expect(prepared.target).toBeUndefined();expect(prepared.skipReason).toContain('channel could not be verified');expect(await fs.readFile(f.pointerFile,'utf8')).toBe(f.oldPointer);await f.preserved();
});
it('supports an ordinary old managed install through an installed tag reference when release target is a branch',async()=>{
 const f=await fixture(),original=vi.mocked(f.fetcher).getMockImplementation()!;f.old.release.target_commitish='main';vi.mocked(f.fetcher).mockImplementation(async(input,init)=>String(input).includes('/git/ref/tags/')?new Response(JSON.stringify({object:{type:'commit',sha:f.old.commit}})):original(input,init));expect((await f.manager.prepareLegacyManagedUpdate(f.callbacks.configuredWine())).target?.channel).toBe('stable');await f.preserved();
});
