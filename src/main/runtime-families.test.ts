import {gameRuntimeReadiness,type RuntimeReadinessState} from './game-runtime-readiness';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {approvedRuntimeSettings} from './runtime-settings';
import type {Game} from '../shared/types';
import {prepareProtonRunner} from './proton';
import {createHash} from 'node:crypto';
import {resolveRuntimeFamily,resolveRuntimeFamilyBuild,retainRuntimeFamilyBuild,installedRuntimeFamilies,runtimeFamilyVerificationStats} from './runtime-families';
import {resolveGameRuntime,bindRuntimePrefix} from './runtime-prefix-binding';
import {gameRuntimeSelection} from '../shared/runtime-selection';
let root:string,release:string;
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
async function approval(){const value=JSON.parse(await fs.readFile(path.join(root,'variants',family,'current.json'),'utf8'));return {buildId:value.buildId,manifestSha256:value.manifestSha256,sourceCommit:value.sourceCommit};}
const family='nexus-cachyos',buildId='b'.repeat(64),sourceCommit='a'.repeat(40),sourceRepository='domsvoboda/nexus-runtime-cachyos';
async function fixture() {
  const files:Record<string,string>={};
  const payload=['proton','files/bin/wine','files/bin/wineserver','files/bin/wine.nexus-original',
    ...['PlayFabGameSave.dll','gaming-services-version.exe','package-registration.exe'].map(name=>'files/share/xodus-nexus/compat/'+name),
    ...['x86_64','i386'].flatMap(cpu=>['xgameruntime.dll','winhttp.dll','libnghttp2.dll'].map(name=>`files/lib/wine/${cpu}-windows/${name}`))];
  for(const name of payload){const target=path.join(release,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,'synthetic inert fixture',{mode:0o755});files[name]=hash('synthetic inert fixture');}
  await fs.mkdir(path.join(release,'files/share/default_pfx'),{recursive:true});
  const metadata=JSON.stringify({schema:1,sourceLockSha256:'c'.repeat(64),sourceGraph:{proton:sourceCommit}});
  await fs.writeFile(path.join(release,'XODUS_NEXUS_PATCH.json'),metadata);files['XODUS_NEXUS_PATCH.json']=hash(metadata);
  const manifest=JSON.stringify({schema:1,family,buildId,sourceRepository,sourceCommit,arch:'x64',prefixSchema:1,sourceLockSha256:'c'.repeat(64),files});
  await fs.writeFile(path.join(release,'nexus-family.json'),manifest);
  await fs.writeFile(path.join(root,'variants',family,'current.json'),JSON.stringify({schema:1,family,buildId,sourceRepository,sourceCommit,manifestSha256:hash(manifest)}));
}
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'runtime-family-test-'));release=path.join(root,'variants',family,'releases',buildId);await fs.mkdir(release,{recursive:true});});
afterEach(async()=>{await fs.rm(root,{recursive:true,force:true});});
it('accepts only known IDs, defaults only an absent preference, rejects hostile persisted values',()=>{
 expect(gameRuntimeSelection(undefined)).toBe('default');
 for(const value of ['../nexus','/bin/wine','cachyos',null,{},''])expect(()=>gameRuntimeSelection(value)).toThrow();
});
it('only lists a complete verified managed installation',async()=>{
 expect(await installedRuntimeFamilies(root,'x64')).toEqual([]);await fixture();
 expect(await installedRuntimeFamilies(root,'x64')).toEqual([expect.objectContaining({id:family,buildId})]);
 await fs.writeFile(path.join(release,'files/bin/wine'),'changed');
 expect(await installedRuntimeFamilies(root,'x64')).toEqual([]);
 await expect(resolveRuntimeFamily(root,family,'x64')).rejects.toThrow('default was not used');
});
it('rejects an unlisted payload, changed metadata and incompatible architecture',async()=>{
 await fixture();await fs.writeFile(path.join(release,'unlisted'),'extra');
 await expect(resolveRuntimeFamily(root,family,'x64')).rejects.toThrow();
 await fs.unlink(path.join(release,'unlisted'));await expect(resolveRuntimeFamily(root,family,'arm64')).rejects.toThrow();
 await fs.appendFile(path.join(release,'XODUS_NEXUS_PATCH.json'),' ');await expect(resolveRuntimeFamily(root,family,'x64')).rejects.toThrow();
});
it('rejects executable symlink redirection even to matching bytes',async()=>{
 await fixture();const loader=path.join(release,'files/bin/wine');await fs.unlink(loader);await fs.symlink('wineserver',loader);
 await expect(resolveRuntimeFamily(root,family,'x64')).rejects.toThrow();
});
it('captures immutable independent sessions and preserves the default prefix path',async()=>{
 await fixture();const options={runtimeRoot:root,dataRoot:root,gameId:'test',defaultWine:'/default/wine',arch:'x64',approvedBuild:await approval()};
 const legacy=await resolveGameRuntime({...options,selection:undefined,separatePrefix:false});
 const variant=await resolveGameRuntime({...options,selection:family,separatePrefix:true});
 expect(legacy.compatibilityDataPath).toBe(path.join(root,'compatdata','test'));
 expect(variant.compatibilityDataPath).toContain(path.join('runtime-prefixes',family,buildId));
 expect(Object.isFrozen(variant)).toBe(true);expect(Object.isFrozen(variant.managed)).toBe(true);
 await fs.unlink(path.join(root,'variants',family,'current.json'));
 expect(variant.winePath).toBe(path.join(release,'files/bin/wine'));
 await expect(resolveGameRuntime({...options,selection:family,separatePrefix:true})).rejects.toThrow();
});
it('requires explicit separate prefix consent without mutating the legacy prefix or copying saves',async()=>{
 await fixture();await fs.mkdir(path.join(root,'compatdata','test'),{recursive:true});await fs.writeFile(path.join(root,'compatdata','test','save'),'original');
 const options={runtimeRoot:root,dataRoot:root,gameId:'test',selection:family,defaultWine:'/default/wine',arch:'x64',approvedBuild:await approval()};
 await expect(resolveGameRuntime({...options,separatePrefix:false})).rejects.toThrow('local saves');
 const context=await resolveGameRuntime({...options,separatePrefix:true});await bindRuntimePrefix(context);
 expect(await fs.readdir(context.compatibilityDataPath)).toEqual(['.nexus-runtime-family.json']);
 expect(await fs.readFile(path.join(root,'compatdata','test','save'),'utf8')).toBe('original');
 await bindRuntimePrefix(context);
 await fs.writeFile(path.join(context.compatibilityDataPath,'.nexus-runtime-family.json'),'{}');
 await expect(bindRuntimePrefix(context)).rejects.toThrow('mismatch');
});
it('does not adopt an unbound experimental prefix or another family in the default path',async()=>{
 await fixture();const context=await resolveGameRuntime({runtimeRoot:root,dataRoot:root,gameId:'test',selection:family,separatePrefix:true,approvedBuild:await approval(),defaultWine:'/default/wine',arch:'x64'});
 await fs.mkdir(context.compatibilityDataPath,{recursive:true});await fs.writeFile(path.join(context.compatibilityDataPath,'save'),'keep');
 await expect(bindRuntimePrefix(context)).rejects.toThrow('no runtime binding');
 const legacy=await resolveGameRuntime({runtimeRoot:root,dataRoot:root,gameId:'test',selection:'default',separatePrefix:false,defaultWine:'/default/wine'});
 await fs.mkdir(legacy.compatibilityDataPath,{recursive:true});await fs.writeFile(path.join(legacy.compatibilityDataPath,'.nexus-runtime-family.json'),JSON.stringify({family}));
 await expect(bindRuntimePrefix(legacy)).rejects.toThrow('another runtime');
});
it('rejects prefix symlinks and never writes into their target',async()=>{
 await fixture();const context=await resolveGameRuntime({runtimeRoot:root,dataRoot:root,gameId:'test',selection:family,separatePrefix:true,approvedBuild:await approval(),defaultWine:'/default/wine',arch:'x64'});
 const other=path.join(root,'untouched');await fs.mkdir(other);await fs.mkdir(path.dirname(context.compatibilityDataPath),{recursive:true});await fs.symlink(other,context.compatibilityDataPath);
 await expect(bindRuntimePrefix(context)).rejects.toThrow('symlinks');expect(await fs.readdir(other)).toEqual([]);
});
it('persists valid game selections and rejects malformed updates without changing existing state',async()=>{
 const {StateStore}=await import('./store');const store=new StateStore(path.join(root,'profile'));
 await store.upsertGame({id:'test',path:'/synthetic/game',title:'Synthetic',installState:'ready',addedAt:'2026-01-01'});
 await store.patchGame('test',{runtime:family,runtimeSeparatePrefix:true});
 const reloaded=new StateStore(path.join(root,'profile'));await reloaded.load();
 expect(reloaded.games[0]).toMatchObject({runtime:family,runtimeSeparatePrefix:true});
 await expect(store.patchGame('test',{runtime:'/bin/wine' as never})).rejects.toThrow('Unknown');
 await expect(store.patchGame('test',{runtimeSeparatePrefix:'yes' as never})).rejects.toThrow('Invalid');
 expect(store.games[0].runtime).toBe(family);
});

it('Stop uses its captured runtime and prefix after another launch is selected',async()=>{
 await fixture();
 const server=path.join(release,'files/bin/wineserver');
 const stopLog=path.join(root,'captured-stop.log');
 await fs.writeFile(server,`#!/bin/sh\nprintf '%s\\n' "$WINEPREFIX" >> '${stopLog}'\n`,{mode:0o755});
 const pointerFile=path.join(root,'variants',family,'current.json');
 const manifestFile=path.join(release,'nexus-family.json');
 const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));manifest.files['files/bin/wineserver']=hash(await fs.readFile(server));
 const bytes=JSON.stringify(manifest);await fs.writeFile(manifestFile,bytes);
 const pointer=JSON.parse(await fs.readFile(pointerFile,'utf8'));pointer.manifestSha256=hash(bytes);await fs.writeFile(pointerFile,JSON.stringify(pointer));
 const options={runtimeRoot:root,dataRoot:root,gameId:'test',defaultWine:'/default/wine',arch:'x64',approvedBuild:await approval()};
 const captured=await resolveGameRuntime({...options,selection:family,separatePrefix:true});await bindRuntimePrefix(captured);
 const system32=path.join(captured.compatibilityDataPath,'pfx/drive_c/windows/system32');await fs.mkdir(system32,{recursive:true});
 for(const name of ['libvkd3d-utils-1.dll','dxgi.dll','d3d12.dll'])await fs.writeFile(path.join(system32,name),'synthetic');
 const runner=await prepareProtonRunner(captured.winePath,captured.compatibilityDataPath,path.join(root,'synthetic-steam'));
 expect(runner).toBeDefined();
 await resolveGameRuntime({...options,selection:'default',separatePrefix:false});
 await fs.unlink(pointerFile); // Current selection/pointer cannot change a running Stop command.
 await promisify(execFileCallback)(runner!.stopPrefix.command,runner!.stopPrefix.args);
 expect((await fs.readFile(stopLog,'utf8')).trim()).toBe(path.join(captured.compatibilityDataPath,'pfx'));
 expect(await fs.readdir(path.join(root,'compatdata')).catch(()=>[])).toEqual([]);
});

it.each([{sourceRepository:'xodus-gaming/Proton'},{sourceCommit:'bad'},{family:'nexus'},{buildId:'../escape'},{manifestSha256:'0'.repeat(64)}])('rejects a mismatched or hostile installed receipt: %j',async patch=>{
 await fixture();const file=path.join(root,'variants',family,'current.json');const pointer=JSON.parse(await fs.readFile(file,'utf8'));
 await fs.writeFile(file,JSON.stringify({...pointer,...patch}));await expect(resolveRuntimeFamily(root,family,'x64')).rejects.toThrow('verification');
});

it('verifies inventoried internal directory symlinks while rejecting external targets',async()=>{
 await fixture();await fs.symlink('share',path.join(release,'files/shared-link'));
 const file=path.join(release,'nexus-family.json'),pointerFile=path.join(root,'variants',family,'current.json');
 const manifest=JSON.parse(await fs.readFile(file,'utf8'));manifest.symlinks={'files/shared-link':'share'};
 const bytes=JSON.stringify(manifest);await fs.writeFile(file,bytes);const pointer=JSON.parse(await fs.readFile(pointerFile,'utf8'));pointer.manifestSha256=hash(bytes);await fs.writeFile(pointerFile,JSON.stringify(pointer));
 expect((await resolveRuntimeFamily(root,family,'x64')).id).toBe(family);
 await fs.unlink(path.join(release,'files/shared-link'));await fs.symlink(root,path.join(release,'files/shared-link'));
 await expect(resolveRuntimeFamily(root,family,'x64')).rejects.toThrow();
});

async function reseal(change:(manifest:any)=>void) {
 const file=path.join(release,'nexus-family.json'),pointerFile=path.join(root,'variants',family,'current.json');
 const manifest=JSON.parse(await fs.readFile(file,'utf8'));change(manifest);const bytes=JSON.stringify(manifest);await fs.writeFile(file,bytes);
 const pointer=JSON.parse(await fs.readFile(pointerFile,'utf8'));pointer.manifestSha256=hash(bytes);await fs.writeFile(pointerFile,JSON.stringify(pointer));
}
it('accepts only the exact inventoried default-template Z mapping without dereferencing it',async()=>{
 await fixture();const link='files/share/default_pfx/dosdevices/z:';await fs.mkdir(path.dirname(path.join(release,link)));await fs.symlink('/',path.join(release,link));
 await reseal(manifest=>{manifest.symlinks={[link]:'/'};});
 expect((await resolveRuntimeFamily(root,family,'x64')).id).toBe(family);
 await fs.unlink(path.join(release,link));await fs.symlink('/tmp',path.join(release,link));
 await reseal(manifest=>{manifest.symlinks[link]='/tmp';});await expect(resolveRuntimeFamily(root,family,'x64')).rejects.toThrow();
});
it('rejects the same absolute target at another path and an escaped intermediate template directory',async()=>{
 await fixture();const link='files/share/default_pfx/z:';await fs.symlink('/',path.join(release,link));
 await reseal(manifest=>{manifest.symlinks={[link]:'/'};});await expect(resolveRuntimeFamily(root,family,'x64')).rejects.toThrow();
 await fs.unlink(path.join(release,link));const outside=path.join(root,'outside');await fs.mkdir(outside);await fs.symlink('/',path.join(outside,'z:'));
 await fs.symlink(outside,path.join(release,'files/share/default_pfx/dosdevices'));
 await reseal(manifest=>{manifest.symlinks={'files/share/default_pfx/dosdevices/z:':'/'};});await expect(resolveRuntimeFamily(root,family,'x64')).rejects.toThrow();
});
it('performs one full hash pass for concurrent and repeated unchanged requests, then invalidates changed files',async()=>{
 await fixture();const baseline=runtimeFamilyVerificationStats();
 await Promise.all(Array.from({length:8},()=>resolveRuntimeFamily(root,family,'x64')));
 for(let i=0;i<5;i++)await resolveRuntimeFamily(root,family,'x64');
 expect(runtimeFamilyVerificationStats().fullPasses-baseline.fullPasses).toBe(1);
 expect(runtimeFamilyVerificationStats().cacheHits-baseline.cacheHits).toBe(5);
 const file=path.join(release,'files/bin/wine');const original=await fs.readFile(file);await fs.writeFile(file,original);
 await resolveRuntimeFamily(root,family,'x64');expect(runtimeFamilyVerificationStats().fullPasses-baseline.fullPasses).toBe(2);
 await fs.writeFile(file,'modified');await expect(resolveRuntimeFamily(root,family,'x64')).rejects.toThrow();
 expect(runtimeFamilyVerificationStats().fullPasses-baseline.fullPasses).toBe(3);
});
it('invalidates receipt, inventory and symlink changes, and never caches a failing scan',async()=>{
 await fixture();await resolveRuntimeFamily(root,family,'x64');let baseline=runtimeFamilyVerificationStats().fullPasses;
 const pointer=path.join(root,'variants',family,'current.json');await fs.appendFile(pointer,' ');await resolveRuntimeFamily(root,family,'x64');
 expect(runtimeFamilyVerificationStats().fullPasses-baseline).toBe(1);
 await fs.writeFile(path.join(release,'extra'),'extra');await expect(resolveRuntimeFamily(root,family,'x64')).rejects.toThrow();await expect(resolveRuntimeFamily(root,family,'x64')).rejects.toThrow();
 expect(runtimeFamilyVerificationStats().fullPasses-baseline).toBe(3);
 await fs.unlink(path.join(release,'extra'));await fs.symlink('files',path.join(release,'extra-link'));await expect(resolveRuntimeFamily(root,family,'x64')).rejects.toThrow();
});
it('rejects a same-bytes write during full verification and does not cache the raced result',async()=>{
 await fixture();const baseline=runtimeFamilyVerificationStats().fullPasses;
 const original=fs.readFile.bind(fs);let changed=false;
 const spy=vi.spyOn(fs,'readFile').mockImplementation((async(file:any,...args:any[])=>{
   const result=await (original as any)(file,...args);
   if(String(file).endsWith('XODUS_NEXUS_PATCH.json')&&!changed){changed=true;const loader=path.join(release,'files/bin/wine');await fs.writeFile(loader,await original(loader));}
   return result;
 }) as typeof fs.readFile);
 try{await expect(resolveRuntimeFamily(root,family,'x64')).rejects.toThrow();}finally{spy.mockRestore();}
 expect(changed).toBe(true);await resolveRuntimeFamily(root,family,'x64');
 expect(runtimeFamilyVerificationStats().fullPasses-baseline).toBe(2);
});

it('rejects a default-runtime alias into a managed family but preserves ordinary default symlinks',async()=>{
 await fixture();const alias=path.join(root,'wine-alias');await fs.symlink(path.join(release,'files/bin/wine'),alias);
 const options={runtimeRoot:root,dataRoot:root,gameId:'test',selection:'default',separatePrefix:false,arch:'x64'};
 await expect(resolveGameRuntime({...options,defaultWine:alias})).rejects.toThrow('separate prefix');
 await fs.unlink(alias);const legacy=path.join(root,'legacy-wine');await fs.writeFile(legacy,'synthetic');await fs.symlink(legacy,alias);
 expect((await resolveGameRuntime({...options,defaultWine:alias})).winePath).toBe(alias);
});
it('rejects a changed cached fingerprint and forces a fresh full pass on retry',async()=>{
 await fixture();await resolveRuntimeFamily(root,family,'x64');const baseline=runtimeFamilyVerificationStats().fullPasses;
 const original=fs.readFile.bind(fs);let pointers=0;
 const spy=vi.spyOn(fs,'readFile').mockImplementation((async(file:any,...args:any[])=>{
  const result=await (original as any)(file,...args);
  if(String(file).endsWith('current.json')&&++pointers===2){const loader=path.join(release,'files/bin/wine');await fs.writeFile(loader,await original(loader));}
  return result;
 }) as typeof fs.readFile);
 try{await expect(resolveRuntimeFamily(root,family,'x64')).rejects.toThrow();}finally{spy.mockRestore();}
 await resolveRuntimeFamily(root,family,'x64');expect(runtimeFamilyVerificationStats().fullPasses-baseline).toBe(1);
});
it('rejects a release-root symlink even when its external payload has matching hashes',async()=>{
 await fixture();const moved=path.join(root,'outside-release');await fs.rename(release,moved);await fs.symlink(moved,release);
 await expect(resolveRuntimeFamily(root,family,'x64')).rejects.toThrow();
});

async function switchBuild(id:string) {
 const next=path.join(root,'variants',family,'releases',id);await fs.cp(release,next,{recursive:true});
 const file=path.join(next,'nexus-family.json');const manifest=JSON.parse(await fs.readFile(file,'utf8'));manifest.buildId=id;
 const bytes=JSON.stringify(manifest);await fs.writeFile(file,bytes);
 await fs.writeFile(path.join(root,'variants',family,'current.json'),JSON.stringify({schema:1,family,buildId:id,sourceRepository,sourceCommit,manifestSha256:hash(bytes)}));
 return {buildId:id,sourceCommit,manifestSha256:hash(bytes)};
}
const savedGame=():Game=>({id:'test',path:'/synthetic/game',title:'Synthetic',installState:'ready',addedAt:'2026-01-01'});
it('follows verified current B with the same new-family prefix and existing saves, while captured A remains immutable',async()=>{
 await fixture();let game=savedGame();Object.assign(game,await approvedRuntimeSettings(game,{runtime:family,runtimeSeparatePrefix:true},root));
 const options=()=>({runtimeRoot:root,dataRoot:root,gameId:game.id,selection:game.runtime,separatePrefix:game.runtimeSeparatePrefix,prefixAnchor:game.runtimePrefixes?.[family],defaultWine:'/default/wine',arch:'x64'});
 const a=await resolveGameRuntime(options());await bindRuntimePrefix(a);const save=path.join(a.compatibilityDataPath,'save');await fs.writeFile(save,'real synthetic progress');const ino=(await fs.stat(save)).ino;
 await retainRuntimeFamilyBuild(root,family,'x64');await switchBuild('d'.repeat(64));
 const b=await resolveGameRuntime(options());await bindRuntimePrefix(b);expect(b.winePath).not.toBe(a.winePath);expect(b.compatibilityDataPath).toBe(a.compatibilityDataPath);expect(a.managed?.buildId).toBe(buildId);expect(b.managed?.buildId).toBe('d'.repeat(64));
 expect(await fs.readFile(save,'utf8')).toBe('real synthetic progress');expect((await fs.stat(save)).ino).toBe(ino);
 const noResolve=vi.fn(()=>{throw Error('Ordinary Save must not need a new build approval');});
 expect((await approvedRuntimeSettings(game,{},root,noResolve)).runtimePrefixes).toEqual(game.runtimePrefixes);expect(noResolve).not.toHaveBeenCalled();
});
it('preserves old build-specific prefix origin across default and back without moving or resetting progress',async()=>{
 await fixture();const origin=await approval();let game={...savedGame(),runtime:family,runtimeSeparatePrefix:true,runtimeBuild:origin} as Game;
 const old=await resolveGameRuntime({runtimeRoot:root,dataRoot:root,gameId:game.id,selection:family,separatePrefix:true,approvedBuild:origin,defaultWine:'/default/wine',arch:'x64'});await bindRuntimePrefix(old);
 const save=path.join(old.compatibilityDataPath,'save');await fs.writeFile(save,'old progress');const marker=await fs.readFile(path.join(old.compatibilityDataPath,'.nexus-runtime-family.json'),'utf8');
 Object.assign(game,await approvedRuntimeSettings(game,{runtime:'default'},root));expect(game.runtimeBuild).toBeUndefined();expect(game.runtimePrefixes?.[family]).toEqual({layout:'build',origin});
 await switchBuild('d'.repeat(64));Object.assign(game,await approvedRuntimeSettings(game,{runtime:family,runtimeSeparatePrefix:true},root));
 const next=await resolveGameRuntime({runtimeRoot:root,dataRoot:root,gameId:game.id,selection:family,separatePrefix:true,prefixAnchor:game.runtimePrefixes?.[family],defaultWine:'/default/wine',arch:'x64'});await bindRuntimePrefix(next);
 expect(next.compatibilityDataPath).toBe(old.compatibilityDataPath);expect(next.winePath).not.toBe(old.winePath);expect(await fs.readFile(save,'utf8')).toBe('old progress');expect(await fs.readFile(path.join(next.compatibilityDataPath,'.nexus-runtime-family.json'),'utf8')).toBe(marker);
 const {StateStore}=await import('./store');const store=new StateStore(path.join(root,'profile'));await store.upsertGame(game);await store.patchGame(game.id,{title:'Renamed'});const loaded=new StateStore(path.join(root,'profile'));await loaded.load();expect(loaded.games[0].runtimePrefixes).toEqual(game.runtimePrefixes);
});
it('requires first family consent, accepts updates without fresh consent, and ignores renderer-forged prefix identities',async()=>{
 await fixture();const game=savedGame();await expect(approvedRuntimeSettings(game,{runtime:family},root)).rejects.toThrow('separate prefix');
 const patch=await approvedRuntimeSettings(game,{runtime:family,runtimeSeparatePrefix:true,runtimePrefixes:{[family]:{layout:'build',origin:await approval()}}} as never,root);
 expect(patch.runtimePrefixes).toEqual({[family]:{layout:'family'}});expect(patch.runtimeBuild).toBeUndefined();
 Object.assign(game,patch);await switchBuild('d'.repeat(64));expect((await approvedRuntimeSettings(game,{},root)).runtimePrefixes).toEqual(game.runtimePrefixes);
 await expect(fs.stat(path.join(root,'runtime-prefixes'))).rejects.toMatchObject({code:'ENOENT'});
});
it('same-family ordinary Save preserves compatibility origin even when current runtime is unavailable',async()=>{
 await fixture();const origin=await approval(),game={...savedGame(),runtime:family,runtimeSeparatePrefix:true,runtimeBuild:origin} as Game;
 await fs.unlink(path.join(root,'variants',family,'current.json'));
 const patch=await approvedRuntimeSettings(game,{},root);expect(patch.runtimePrefixes).toEqual({[family]:{layout:'build',origin}});
 await expect(resolveGameRuntime({runtimeRoot:root,dataRoot:root,gameId:game.id,selection:family,separatePrefix:true,prefixAnchor:patch.runtimePrefixes?.[family],defaultWine:'/default/wine',arch:'x64'})).rejects.toThrow();
});

async function installNextFixture() {
 const previous=release;
 const next='d'.repeat(64);release=path.join(root,'variants',family,'releases',next);
 await fs.cp(previous,release,{recursive:true});
 const manifestFile=path.join(release,'nexus-family.json');
 const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));manifest.buildId=next;
 const bytes=JSON.stringify(manifest);await fs.writeFile(manifestFile,bytes);
 const pointer=JSON.parse(await fs.readFile(path.join(root,'variants',family,'current.json'),'utf8'));
 Object.assign(pointer,{buildId:next,manifestSha256:hash(bytes)});
 await fs.writeFile(path.join(root,'variants',family,'current.json'),JSON.stringify(pointer));
 return previous;
}
it('retains A for rollback but next launch follows B with the same compatibility prefix',async()=>{
 await fixture();const a=await approval();const options={runtimeRoot:root,dataRoot:root,gameId:'retained',selection:family,separatePrefix:true,defaultWine:'/default/wine',arch:'x64',approvedBuild:a};
 const old=await resolveGameRuntime(options);await bindRuntimePrefix(old);await fs.writeFile(path.join(old.compatibilityDataPath,'save'),'A progress');await retainRuntimeFamilyBuild(root,family,'x64');await installNextFixture();
 const next=await resolveGameRuntime(options);await bindRuntimePrefix(next);expect(next.winePath).not.toBe(old.winePath);expect(next.compatibilityDataPath).toBe(old.compatibilityDataPath);expect(await fs.readFile(path.join(next.compatibilityDataPath,'save'),'utf8')).toBe('A progress');
 expect((await resolveRuntimeFamilyBuild(root,family,a,'x64')).winePath).toBe(old.winePath);
 await fs.writeFile(path.join(root,'variants',family,'current.json'),JSON.stringify({schema:1,family,sourceRepository,...a}));
 expect((await resolveGameRuntime(options)).winePath).toBe(old.winePath);
});
it('does not reconstruct missing A receipts from an approved identity or an existing release directory',async()=>{
 await fixture();const a=await approval();await installNextFixture();
 await expect(resolveRuntimeFamilyBuild(root,family,a,'x64')).rejects.toThrow();
});
it('keeps matching legacy current usable read-only, without fabricating retained receipts',async()=>{
 await fixture();expect((await resolveRuntimeFamilyBuild(root,family,await approval(),'x64')).buildId).toBe(buildId);
 await expect(fs.access(path.join(root,'variants',family,'receipts'))).rejects.toThrow();
});
it('fails closed for corrupt retained receipt even if matching current still exists',async()=>{
 await fixture();const a=await approval();await retainRuntimeFamilyBuild(root,family,'x64');
 const receipt=path.join(root,'variants',family,'receipts',buildId+'.json');
 await fs.writeFile(receipt,'{');await expect(resolveRuntimeFamilyBuild(root,family,a,'x64')).rejects.toThrow();
 await expect(retainRuntimeFamilyBuild(root,family,'x64')).rejects.toThrow('Conflicting');
 expect(await fs.readFile(receipt,'utf8')).toBe('{');
});
it('isolates retained cache from current and invalidates changed retained payload or receipt',async()=>{
 await fixture();const a=await approval();await retainRuntimeFamilyBuild(root,family,'x64');const previous=await installNextFixture();
 expect((await resolveRuntimeFamily(root,family,'x64')).buildId).not.toBe(buildId);
 expect((await resolveRuntimeFamilyBuild(root,family,a,'x64')).buildId).toBe(buildId);
 const receipt=path.join(root,'variants',family,'receipts',buildId+'.json');const original=await fs.readFile(receipt,'utf8');
 await fs.writeFile(receipt,original.replace(sourceRepository,'attacker/runtime'));
 await expect(resolveRuntimeFamilyBuild(root,family,a,'x64')).rejects.toThrow();
 await fs.writeFile(receipt,original);await resolveRuntimeFamilyBuild(root,family,a,'x64');
 await fs.appendFile(path.join(previous,'files/bin/wine'),'changed');
 await expect(resolveRuntimeFamilyBuild(root,family,a,'x64')).rejects.toThrow();
 expect((await resolveRuntimeFamily(root,family,'x64')).buildId).not.toBe(buildId);
});
it('rejects retained receipt and directory symlinks rather than falling back to current',async()=>{
 await fixture();const a=await approval();await retainRuntimeFamilyBuild(root,family,'x64');
 const directory=path.join(root,'variants',family,'receipts'),receipt=path.join(directory,buildId+'.json');
 await fs.unlink(receipt);await fs.symlink('../current.json',receipt);
 await expect(resolveRuntimeFamilyBuild(root,family,a,'x64')).rejects.toThrow();
 await expect(retainRuntimeFamilyBuild(root,family,'x64')).rejects.toThrow();
 await fs.unlink(receipt);await fs.rmdir(directory);await fs.symlink('.',directory);
 await expect(resolveRuntimeFamilyBuild(root,family,a,'x64')).rejects.toThrow();
 await expect(retainRuntimeFamilyBuild(root,family,'x64')).rejects.toThrow();
});
it('publishes no partial receipt when publication fails, and supports concurrent idempotent retention',async()=>{
 await fixture();const link=vi.spyOn(fs,'link').mockRejectedValueOnce(Object.assign(Error('synthetic full disk'),{code:'ENOSPC'}));
 await expect(retainRuntimeFamilyBuild(root,family,'x64')).rejects.toThrow('synthetic full disk');link.mockRestore();
 const directory=path.join(root,'variants',family,'receipts');expect(await fs.readdir(directory)).toEqual([]);
 const results=await Promise.all([retainRuntimeFamilyBuild(root,family,'x64'),retainRuntimeFamilyBuild(root,family,'x64')]);
 expect(results.map(item=>item.buildId)).toEqual([buildId,buildId]);
 expect(await fs.readdir(directory)).toEqual([buildId+'.json']);
 expect((await resolveRuntimeFamily(root,family,'x64')).buildId).toBe(buildId);
});
it('uses the same retained receipt contract for the standard managed family without changing legacy default',async()=>{
 await fixture();const directory=path.join(root,'variants','nexus');await fs.rename(path.join(root,'variants',family),directory);
 const manifestFile=path.join(directory,'releases',buildId,'nexus-family.json');
 const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));Object.assign(manifest,{family:'nexus',sourceRepository:'domsvoboda/nexus-runtime'});
 const bytes=JSON.stringify(manifest);await fs.writeFile(manifestFile,bytes);
 const receipt=path.join(directory,'current.json');const pointer=JSON.parse(await fs.readFile(receipt,'utf8'));
 Object.assign(pointer,{family:'nexus',sourceRepository:'domsvoboda/nexus-runtime',manifestSha256:hash(bytes)});await fs.writeFile(receipt,JSON.stringify(pointer));
 await fs.writeFile(path.join(root,'current.json'),'legacy-default-pointer');
 const retained=await retainRuntimeFamilyBuild(root,'nexus','x64');await fs.unlink(receipt);
 expect((await resolveRuntimeFamilyBuild(root,'nexus',retained,'x64')).buildId).toBe(buildId);
 expect(await fs.readFile(path.join(root,'current.json'),'utf8')).toBe('legacy-default-pointer');
});
it('fails closed when retained A payload disappears while current B remains valid',async()=>{
 await fixture();const a=await approval();await retainRuntimeFamilyBuild(root,family,'x64');const previous=await installNextFixture();
 await fs.rm(previous,{recursive:true});
 await expect(resolveRuntimeFamilyBuild(root,family,a,'x64')).rejects.toThrow('default was not used');
 expect((await resolveRuntimeFamily(root,family,'x64')).buildId).not.toBe(buildId);
});

it('reports unavailable for missing or corrupt current B despite retaining A for rollback',async()=>{
 await fixture();const a=await approval();await retainRuntimeFamilyBuild(root,family,'x64');const previous=await installNextFixture();
 const state:RuntimeReadinessState={game:{id:'readiness',runtime:family,runtimeSeparatePrefix:true,runtimeBuild:a},runtimeRoot:root,dataRoot:root,defaultWine:undefined,arch:'x64'};
 const current=path.join(root,'variants',family,'current.json');await fs.writeFile(current,'{corrupt B');
 expect(await gameRuntimeReadiness(()=>state)).toBe(false);await fs.unlink(current);expect(await gameRuntimeReadiness(()=>state)).toBe(false);
 await fs.appendFile(path.join(previous,'files/bin/wine'),'corrupt A');expect(await gameRuntimeReadiness(()=>state)).toBe(false);
 await fs.rm(previous,{recursive:true});expect(await gameRuntimeReadiness(()=>state)).toBe(false);
 await expect(fs.access(path.join(root,'runtime-prefixes'))).rejects.toThrow();
});
it.each(['approval','runtimeRoot'])('rejects readiness if %s changes during verification',async changed=>{
 await fixture();const state:RuntimeReadinessState={game:{id:'readiness',runtime:family,runtimeSeparatePrefix:true,runtimeBuild:await approval()},runtimeRoot:root,dataRoot:root,defaultWine:undefined,arch:'x64'};
 let resume!:()=>void;const held=new Promise<void>(resolve=>resume=resolve);
 const result=gameRuntimeReadiness(()=>state,async options=>{await held;return resolveGameRuntime(options);});
 if(changed==='approval')state.game={...state.game!,runtimeBuild:{...state.game!.runtimeBuild!,buildId:'d'.repeat(64)}};else state.runtimeRoot+='-changed';
 resume();expect(await result).toBe(false);
});

it('preserves independent family anchors and saves through family1 to family2 to family1',async()=>{
 await fixture();const second='nexus';const secondRoot=path.join(root,'variants',second);await fs.cp(path.join(root,'variants',family),secondRoot,{recursive:true});
 const manifestFile=path.join(secondRoot,'releases',buildId,'nexus-family.json');const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));manifest.family=second;manifest.sourceRepository='domsvoboda/nexus-runtime';const bytes=JSON.stringify(manifest);await fs.writeFile(manifestFile,bytes);await fs.writeFile(path.join(secondRoot,'current.json'),JSON.stringify({schema:1,family:second,buildId,sourceRepository:manifest.sourceRepository,sourceCommit,manifestSha256:hash(bytes)}));
 let game=savedGame();const context=()=>resolveGameRuntime({runtimeRoot:root,dataRoot:root,gameId:game.id,selection:game.runtime,separatePrefix:game.runtimeSeparatePrefix,prefixAnchor:game.runtimePrefixes?.[game.runtime as typeof family],defaultWine:'/default/wine',arch:'x64'});
 Object.assign(game,await approvedRuntimeSettings(game,{runtime:family,runtimeSeparatePrefix:true},root));const first=await context();await bindRuntimePrefix(first);await fs.writeFile(path.join(first.compatibilityDataPath,'save'),'family1');
 await expect(approvedRuntimeSettings(game,{runtime:second},root)).rejects.toThrow('Explicit separate prefix');
 Object.assign(game,await approvedRuntimeSettings(game,{runtime:second,runtimeSeparatePrefix:true},root));const other=await context();await bindRuntimePrefix(other);await fs.writeFile(path.join(other.compatibilityDataPath,'save'),'family2');
 Object.assign(game,await approvedRuntimeSettings(game,{runtime:family,runtimeSeparatePrefix:true},root));expect((await context()).compatibilityDataPath).toBe(first.compatibilityDataPath);expect(Object.keys(game.runtimePrefixes!)).toHaveLength(2);expect(await fs.readFile(path.join(first.compatibilityDataPath,'save'),'utf8')).toBe('family1');expect(await fs.readFile(path.join(other.compatibilityDataPath,'save'),'utf8')).toBe('family2');
});
it('rejects an old marker conflicting with its persisted origin without rewriting it or its save',async()=>{
 await fixture();const origin=await approval(),options={runtimeRoot:root,dataRoot:root,gameId:'old',selection:family,separatePrefix:true,approvedBuild:origin,defaultWine:'/default/wine',arch:'x64'};
 const a=await resolveGameRuntime(options);await bindRuntimePrefix(a);const marker=path.join(a.compatibilityDataPath,'.nexus-runtime-family.json');const invalid=JSON.stringify({...JSON.parse(await fs.readFile(marker,'utf8')),manifestSha256:'0'.repeat(64)});await fs.writeFile(marker,invalid);await fs.writeFile(path.join(a.compatibilityDataPath,'save'),'preserve');await switchBuild('d'.repeat(64));const b=await resolveGameRuntime(options);await expect(bindRuntimePrefix(b)).rejects.toThrow('mismatch');expect(await fs.readFile(marker,'utf8')).toBe(invalid);expect(await fs.readFile(path.join(a.compatibilityDataPath,'save'),'utf8')).toBe('preserve');
});
