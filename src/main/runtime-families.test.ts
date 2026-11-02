import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {prepareProtonRunner} from './proton';
import {createHash} from 'node:crypto';
import {resolveRuntimeFamily,installedRuntimeFamilies} from './runtime-families';
import {resolveGameRuntime,bindRuntimePrefix} from './runtime-prefix-binding';
import {gameRuntimeSelection} from '../shared/runtime-selection';
let root:string,release:string;
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
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
 await fixture();const options={runtimeRoot:root,dataRoot:root,gameId:'test',defaultWine:'/default/wine',arch:'x64'};
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
 const options={runtimeRoot:root,dataRoot:root,gameId:'test',selection:family,defaultWine:'/default/wine',arch:'x64'};
 await expect(resolveGameRuntime({...options,separatePrefix:false})).rejects.toThrow('local saves');
 const context=await resolveGameRuntime({...options,separatePrefix:true});await bindRuntimePrefix(context);
 expect(await fs.readdir(context.compatibilityDataPath)).toEqual(['.nexus-runtime-family.json']);
 expect(await fs.readFile(path.join(root,'compatdata','test','save'),'utf8')).toBe('original');
 await bindRuntimePrefix(context);
 await fs.writeFile(path.join(context.compatibilityDataPath,'.nexus-runtime-family.json'),'{}');
 await expect(bindRuntimePrefix(context)).rejects.toThrow('mismatch');
});
it('does not adopt an unbound experimental prefix or another family in the default path',async()=>{
 await fixture();const context=await resolveGameRuntime({runtimeRoot:root,dataRoot:root,gameId:'test',selection:family,separatePrefix:true,defaultWine:'/default/wine',arch:'x64'});
 await fs.mkdir(context.compatibilityDataPath,{recursive:true});await fs.writeFile(path.join(context.compatibilityDataPath,'save'),'keep');
 await expect(bindRuntimePrefix(context)).rejects.toThrow('no runtime binding');
 const legacy=await resolveGameRuntime({runtimeRoot:root,dataRoot:root,gameId:'test',selection:'default',separatePrefix:false,defaultWine:'/default/wine'});
 await fs.mkdir(legacy.compatibilityDataPath,{recursive:true});await fs.writeFile(path.join(legacy.compatibilityDataPath,'.nexus-runtime-family.json'),JSON.stringify({family}));
 await expect(bindRuntimePrefix(legacy)).rejects.toThrow('another runtime');
});
it('rejects prefix symlinks and never writes into their target',async()=>{
 await fixture();const context=await resolveGameRuntime({runtimeRoot:root,dataRoot:root,gameId:'test',selection:family,separatePrefix:true,defaultWine:'/default/wine',arch:'x64'});
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
 const options={runtimeRoot:root,dataRoot:root,gameId:'test',defaultWine:'/default/wine',arch:'x64'};
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
