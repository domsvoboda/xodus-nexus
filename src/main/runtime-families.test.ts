import {gameRuntimeReadiness,type RuntimeReadinessState} from './game-runtime-readiness';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {approvedRuntimeSettings,guardedRuntimeSettings,type RuntimeSettingsRequest,type RuntimeSettingsPaths} from './runtime-settings';
import type {Game} from '../shared/types';
import {prepareProtonRunner} from './proton';
import {createHash} from 'node:crypto';
import {resolveRuntimeFamily,resolveRuntimeFamilyBuild,retainRuntimeFamilyBuild,installedRuntimeFamilies,runtimeFamilyVerificationStats} from './runtime-families';
import {resolveGameRuntime,bindRuntimePrefix,captureGamePrefixIdentity,gameRuntimeParameters} from './runtime-prefix-binding';
import {gameRuntimeAvailable,gameRuntimeSelection,runtimePrefixIdentity} from '../shared/runtime-selection';
let root:string,release:string;
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const digest=async(file:string)=>hash(await fs.readFile(file));
const present=async(file:string)=>fs.access(file).then(()=>true,()=>false);
async function approval(){const value=JSON.parse(await fs.readFile(path.join(root,'variants',family,'current.json'),'utf8'));return {buildId:value.buildId,manifestSha256:value.manifestSha256,sourceCommit:value.sourceCommit};}
const family='nexus-cachyos',buildId='b'.repeat(64),sourceCommit='a'.repeat(40),sourceRepository='domsvoboda/nexus-runtime-cachyos';
async function fixture(install = true) {
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
  if(install)await fs.writeFile(path.join(root,'variants',family,'current.json'),JSON.stringify({schema:1,family,buildId,sourceRepository,sourceCommit,manifestSha256:hash(manifest)}));
}
/** Copies the verified fixture to the other managed family so both family
 * runners are installed and verifiable in the same data root. */
async function secondFamily(id:'nexus'|'nexus-cachyos'='nexus') {
  const repository='domsvoboda/nexus-runtime';
  const directory=path.join(root,'variants',id);await fs.cp(path.join(root,'variants',family),directory,{recursive:true});
  const manifestFile=path.join(directory,'releases',buildId,'nexus-family.json');
  const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));manifest.family=id;manifest.sourceRepository=repository;
  const bytes=JSON.stringify(manifest);await fs.writeFile(manifestFile,bytes);
  await fs.writeFile(path.join(directory,'current.json'),JSON.stringify({schema:1,family:id,buildId,sourceRepository:repository,sourceCommit,manifestSha256:hash(bytes)}));
  return path.join(directory,'releases',buildId,'files/bin/wine');
}
/** Pre-0.5 family-wide experimental prefix with its exact legacy marker. */
async function legacyFamilyPrefix(gameId:string,id:'nexus'|'nexus-cachyos'=family) {
  const rootPath=path.join(root,'runtime-prefixes',id,'prefixes',gameId),compatibilityDataPath=path.join(rootPath,'compatdata');
  await fs.mkdir(compatibilityDataPath,{recursive:true});
  await fs.writeFile(path.join(compatibilityDataPath,'.nexus-runtime-family.json'),JSON.stringify({schema:2,layout:'family',family:id,prefixSchema:1,arch:'x64'}));
  await fs.writeFile(path.join(compatibilityDataPath,'save'),`${id} progress`);
  return {compatibilityDataPath,legacyPrefixRoot:path.join(rootPath,'wine')};
}
/** Pre-0.5 build-specific experimental prefix with its exact legacy marker. */
async function legacyBuildPrefix(gameId:string,origin:{buildId:string;sourceCommit:string;manifestSha256:string},id:'nexus'|'nexus-cachyos'=family) {
  const compatibilityDataPath=path.join(root,'runtime-prefixes',id,origin.buildId,gameId,'compatdata');
  await fs.mkdir(compatibilityDataPath,{recursive:true});
  await fs.writeFile(path.join(compatibilityDataPath,'.nexus-runtime-family.json'),JSON.stringify({schema:1,family:id,buildId:origin.buildId,sourceCommit:origin.sourceCommit,manifestSha256:origin.manifestSha256,prefixSchema:1,arch:'x64'}));
  await fs.writeFile(path.join(compatibilityDataPath,'save'),'legacy build progress');
  return {compatibilityDataPath};
}
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'runtime-family-test-'));paths={runtimeRoot:root,dataRoot:root};release=path.join(root,'variants',family,'releases',buildId);await fs.mkdir(release,{recursive:true});});
afterEach(async()=>{await fs.rm(root,{recursive:true,force:true});});
it('accepts only known IDs, defaults only an absent preference, rejects hostile persisted values',()=>{
 expect(gameRuntimeSelection(undefined)).toBe('default');
 for(const value of ['../nexus','/bin/wine','cachyos',null,{},''])expect(()=>gameRuntimeSelection(value)).toThrow();
});
it('only lists a complete verified managed installation',async()=>{
 expect(await installedRuntimeFamilies(root,'x64')).toEqual([]);await fixture();
 expect(await installedRuntimeFamilies(root,'x64')).toEqual([expect.objectContaining({id:family,buildId,displayWinePath:path.join(release,'files/bin/wine')})]);
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
it('never uses an installed CachyOS family as the default runtime',async()=>{
 await fixture();
 await expect(resolveGameRuntime({runtimeRoot:root,dataRoot:root,gameId:'test',defaultWine:'/default/wine',arch:'x64',selection:'default'})).rejects.toThrow('Install the Standard runtime');
});
it('keeps the legacy default runner only while no managed family is installed',async()=>{
 await fixture(false);
 const context=await resolveGameRuntime({runtimeRoot:root,dataRoot:root,gameId:'test',defaultWine:'/default/wine',arch:'x64',selection:'default'});
 expect(context.winePath).toBe('/default/wine');expect(context.managed).toBeUndefined();
});
it('captures immutable independent sessions and resolves the installed Standard family for a default game',async()=>{
 await fixture();const standardRelease=await secondFamily('nexus');const options={runtimeRoot:root,dataRoot:root,gameId:'test',defaultWine:'/default/wine',arch:'x64'};
 const legacy=await resolveGameRuntime({...options,selection:undefined});
 expect(legacy.winePath).toBe(standardRelease);
 const variant=await resolveGameRuntime({...options,selection:family});
 expect(legacy.compatibilityDataPath).toBe(path.join(root,'compatdata','test'));
 // A game without an existing prefix resolves the same per-game location for every family.
 expect(variant.compatibilityDataPath).toBe(legacy.compatibilityDataPath);
 expect(Object.isFrozen(variant)).toBe(true);expect(Object.isFrozen(variant.managed)).toBe(true);
 expect(variant.winePath).toBe(path.join(release,'files/bin/wine'));
 await fs.unlink(path.join(root,'variants',family,'current.json'));
 expect(variant.winePath).toBe(path.join(release,'files/bin/wine'));
 await expect(resolveGameRuntime({...options,selection:family})).rejects.toThrow();
});
it('chooses a managed family without separate-prefix consent and never touches the legacy prefix',async()=>{
 await fixture();const canonical=path.join(root,'compatdata','test');
 await fs.mkdir(canonical,{recursive:true});await fs.writeFile(path.join(canonical,'save'),'original');
 const game=savedGame();
 const patch=await approve(game,{runtime:family,runtimeSeparatePrefix:false});
 expect(patch.runtimePrefixIdentity).toEqual({layout:'game'});
 expect(patch.runtimeSeparatePrefix).toBeUndefined();
 Object.assign(game,patch);
 const context=await resolveGameRuntime({runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64',...gameRuntimeParameters(game)});
 expect(context.compatibilityDataPath).toBe(canonical);
 await bindRuntimePrefix(context);await bindRuntimePrefix(context);
 // A pre-0.5 default prefix is preserved unbound: no marker is invented for it.
 expect(await present(path.join(canonical,'.nexus-runtime-family.json'))).toBe(false);
 expect(await fs.readFile(path.join(canonical,'save'),'utf8')).toBe('original');
 expect(await present(path.join(root,'runtime-prefixes'))).toBe(false);
 await expect(approve(game,{runtime:family,runtimeSeparatePrefix:'yes' as never})).rejects.toThrow('Invalid');
});
it('keeps one stable per-game prefix and byte-identical saves across default, CachyOS and Standard',async()=>{
 await fixture();const standardRelease=await secondFamily('nexus');
 let game=savedGame();
 const context=async()=>resolveGameRuntime({runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64',...gameRuntimeParameters(game)});
 // The first managed run creates the canonical prefix and records its contract.
 Object.assign(game,await approve(game,{runtime:family}));
 const first=await context();expect(first.compatibilityDataPath).toBe(path.join(root,'compatdata','test'));
 await bindRuntimePrefix(first);
 const marker=path.join(first.compatibilityDataPath,'.nexus-runtime-family.json');
 const markerBytes=await fs.readFile(marker,'utf8');
 expect(JSON.parse(markerBytes)).toMatchObject({schema:3,layout:'game',gameId:'test'});
 const save=path.join(first.compatibilityDataPath,'pfx/drive_c/save');await fs.mkdir(path.dirname(save),{recursive:true});await fs.writeFile(save,'synthetic progress');
 const originalBytes=await digest(save),inode=(await fs.stat(save)).ino;
 for(const choice of ['default',family,'nexus','default',family] as const) {
   Object.assign(game,await approve(game,{runtime:choice}));
   const current=await context();await bindRuntimePrefix(current);
   expect(current.compatibilityDataPath).toBe(first.compatibilityDataPath);
   expect(await digest(save)).toBe(originalBytes);
   expect((await fs.stat(save)).ino).toBe(inode);
   // The origin marker is never rewritten or invalidated by a family switch.
   expect(await fs.readFile(marker,'utf8')).toBe(markerBytes);
   expect(current.winePath).toBe(choice==='default'||choice==='nexus'?standardRelease:path.join(release,'files/bin/wine'));
 }
 expect(game.runtimePrefixIdentity).toEqual({layout:'game'});
 expect(await present(path.join(root,'runtime-prefixes'))).toBe(false);
 const {StateStore}=await import('./store');const store=new StateStore(path.join(root,'profile'));
 await store.upsertGame(game);const loaded=new StateStore(path.join(root,'profile'));await loaded.load();
 expect(loaded.games[0].runtimePrefixIdentity).toEqual({layout:'game'});
});
it('keeps an existing legacy family prefix at its exact path and marker through another family, default and back',async()=>{
 await fixture();const standardRelease=await secondFamily('nexus');
 const origin=await approval(),legacy=await legacyBuildPrefix('test',origin);
 let game={...savedGame(),runtime:family,runtimeBuild:origin} as Game;
 const context=async()=>resolveGameRuntime({runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64',...gameRuntimeParameters(game)});
 const first=await context();expect(first.compatibilityDataPath).toBe(legacy.compatibilityDataPath);
 await bindRuntimePrefix(first);
 const marker=path.join(legacy.compatibilityDataPath,'.nexus-runtime-family.json');
 const markerBytes=await fs.readFile(marker,'utf8'),saveBytes=await digest(path.join(legacy.compatibilityDataPath,'save'));
 Object.assign(game,await approve(game,{runtime:'nexus'}));
 expect(game.runtimePrefixIdentity).toEqual({layout:'build',family,origin});expect(game.runtimeBuild).toBeUndefined();
 const other=await context();await bindRuntimePrefix(other);
 expect(other.compatibilityDataPath).toBe(legacy.compatibilityDataPath);expect(other.winePath).toBe(standardRelease);
 Object.assign(game,await approve(game,{runtime:'default'}));
 const canonical=await context();await bindRuntimePrefix(canonical);
 expect(canonical.compatibilityDataPath).toBe(legacy.compatibilityDataPath);expect(canonical.winePath).toBe(standardRelease);
 Object.assign(game,await approve(game,{runtime:family}));
 const back=await context();await bindRuntimePrefix(back);
 expect(back.compatibilityDataPath).toBe(legacy.compatibilityDataPath);
 expect(await fs.readFile(marker,'utf8')).toBe(markerBytes);
 expect(await digest(path.join(legacy.compatibilityDataPath,'save'))).toBe(saveBytes);
 // No family-specific or canonical copy is created next to the preserved prefix.
 expect(await present(path.join(root,'compatdata'))).toBe(false);
 const {StateStore}=await import('./store');const store=new StateStore(path.join(root,'profile'));
 await store.upsertGame(game);
 const loaded=new StateStore(path.join(root,'profile'));await loaded.load();
 expect(loaded.games[0].runtimePrefixIdentity).toEqual({layout:'build',family,origin});
});
it('reuses the pre-0.5 legacy default prefix for a managed family without moving or rewriting it',async()=>{
 await fixture();await secondFamily('nexus');const canonical=path.join(root,'compatdata','test');
 await fs.mkdir(path.join(canonical,'pfx'),{recursive:true});await fs.writeFile(path.join(canonical,'pfx/save'),'legacy progress');
 const originalBytes=await digest(path.join(canonical,'pfx/save'));
 const game=savedGame();
 const context=await resolveGameRuntime({runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64',...gameRuntimeParameters(game)});
 expect(context.compatibilityDataPath).toBe(canonical);
 await bindRuntimePrefix(context);
 expect(await present(path.join(canonical,'.nexus-runtime-family.json'))).toBe(false);
 expect(await digest(path.join(canonical,'pfx/save'))).toBe(originalBytes);
 const patch=await approve(game,{runtime:family});
 expect(patch.runtimePrefixIdentity).toEqual({layout:'game'});
});
it('does not adopt an unbound experimental prefix and rejects a foreign binding on the per-game prefix',async()=>{
 await fixture();
 const legacy=await legacyFamilyPrefix('test'),marker=path.join(legacy.compatibilityDataPath,'.nexus-runtime-family.json');
 await fs.unlink(marker);
 // The selection owns this exact directory, so it is resolved but its missing
 // binding is never adopted and its files are preserved.
 const adopted=await resolveGameRuntime({runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64',gameId:'test',selection:family,runtimePrefixes:{[family]:{layout:'family'}}});
 expect(adopted.compatibilityDataPath).toBe(legacy.compatibilityDataPath);
 await expect(bindRuntimePrefix(adopted)).rejects.toThrow('no runtime binding');
 expect(await fs.readFile(path.join(legacy.compatibilityDataPath,'save'),'utf8')).toBe(`${family} progress`);
 const canonical=path.join(root,'compatdata','other');await fs.mkdir(canonical,{recursive:true});
 await fs.writeFile(path.join(canonical,'.nexus-runtime-family.json'),JSON.stringify({schema:2,layout:'family',family}));
 const perGame=await resolveGameRuntime({runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64',gameId:'other',selection:family});
 await expect(bindRuntimePrefix(perGame)).rejects.toThrow('mismatch');
});
it('rejects legacy bindings with a missing, partial or malformed prefix contract',async()=>{
 await fixture();const origin=await approval(),legacy=await legacyBuildPrefix('test',origin);
 const marker=path.join(legacy.compatibilityDataPath,'.nexus-runtime-family.json');
 const base=JSON.parse(await fs.readFile(marker,'utf8'));
 const invalid:Record<string,unknown>[]=[];
 const missing={...base};delete missing.prefixSchema;delete missing.arch;invalid.push(missing);
 invalid.push({...base,arch:undefined});
 invalid.push({...base,prefixSchema:undefined});
 invalid.push({...base,prefixSchema:'1'});
 invalid.push({...base,prefixSchema:0});
 invalid.push({...base,prefixSchema:1.5});
 invalid.push({...base,arch:''});
 invalid.push({...base,arch:42});
 invalid.push({...base,arch:['x64']});
 invalid.push({...base,arch:null});
 invalid.push(null as never);
 invalid.push([] as never);
 invalid.push('binding' as never);
 for(const forged of invalid) {
   await fs.writeFile(marker,JSON.stringify(forged));
   const bytes=await fs.readFile(marker,'utf8');
   const context=await resolveGameRuntime({runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64',gameId:'test',selection:family,runtimeBuild:origin});
   await expect(bindRuntimePrefix(context)).rejects.toThrow('mismatch');
   expect(await fs.readFile(marker,'utf8')).toBe(bytes);
 }
 // A well-formed legacy binding is accepted and left byte-identical.
 await fs.writeFile(marker,JSON.stringify(base));
 const context=await resolveGameRuntime({runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64',gameId:'test',selection:family,runtimeBuild:origin});
 await bindRuntimePrefix(context);
 expect(await fs.readFile(marker,'utf8')).toBe(JSON.stringify(base));
 expect(await fs.readFile(path.join(legacy.compatibilityDataPath,'save'),'utf8')).toBe('legacy build progress');
});
it('validates a recorded contract shape without pretending a default Wine runner verified it',async()=>{
 await fixture();const origin=await approval(),legacy=await legacyBuildPrefix('test',origin);
 const pointerFile=path.join(root,'variants',family,'current.json'),pointerBytes=await fs.readFile(pointerFile);await fs.unlink(pointerFile);
 const marker=path.join(legacy.compatibilityDataPath,'.nexus-runtime-family.json');
 const base=JSON.parse(await fs.readFile(marker,'utf8'));
 const context=()=>resolveGameRuntime({runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64',gameId:'test',selection:'default',runtimeBuild:origin});
 // A default runner keeps the recorded contract untouched and does not rewrite it.
 await bindRuntimePrefix(await context());
 expect(await fs.readFile(marker,'utf8')).toBe(JSON.stringify(base));
 // An unknown but well-formed contract is preserved as-is for a default runner.
 const future={...base,prefixSchema:2,arch:'arm64'};await fs.writeFile(marker,JSON.stringify(future));
 await bindRuntimePrefix(await context());
 expect(await fs.readFile(marker,'utf8')).toBe(JSON.stringify(future));
 // A managed runner compares the recorded contract exactly.
 await fs.writeFile(pointerFile,pointerBytes);
 const managed=await resolveGameRuntime({runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64',gameId:'test',selection:family,runtimeBuild:origin});
 await expect(bindRuntimePrefix(managed)).rejects.toThrow('mismatch');
});
it('rejects prefix symlinks and never writes into their target',async()=>{
 await fixture();
 const context=await resolveGameRuntime({runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64',gameId:'test',selection:family});
 const other=path.join(root,'untouched');await fs.mkdir(other);await fs.mkdir(path.dirname(context.compatibilityDataPath),{recursive:true});await fs.symlink(other,context.compatibilityDataPath);
 await expect(bindRuntimePrefix(context)).rejects.toThrow('symlinks');expect(await fs.readdir(other)).toEqual([]);
});
it('keeps experimental prefix protection when the game switches to the default runner',async()=>{
 await fixture();const origin=await approval(),legacy=await legacyBuildPrefix('test',origin);
 const pointerFile=path.join(root,'variants',family,'current.json');await fs.unlink(pointerFile);
 const marker=path.join(legacy.compatibilityDataPath,'.nexus-runtime-family.json');
 // A symlinked binding is rejected even though the current runner is the default Wine.
 const real=path.join(root,'real-binding');await fs.writeFile(real,JSON.stringify({schema:1,family,buildId:origin.buildId,sourceCommit:origin.sourceCommit,manifestSha256:origin.manifestSha256,prefixSchema:1,arch:'x64'}));
 await fs.unlink(marker);await fs.symlink(real,marker);
 const symlinkedMarker=await resolveGameRuntime({runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64',gameId:'test',selection:'default',runtimeBuild:origin});
 expect(symlinkedMarker.compatibilityDataPath).toBe(legacy.compatibilityDataPath);
 await expect(bindRuntimePrefix(symlinkedMarker)).rejects.toThrow('regular file');
 expect(await fs.readFile(real,'utf8')).toContain(origin.buildId);
 // A symlinked prefix directory is rejected as well, with its target untouched.
 await fs.unlink(marker);await fs.writeFile(marker,await fs.readFile(real,'utf8'));
 const moved=path.join(root,'moved-prefix');await fs.rename(legacy.compatibilityDataPath,moved);await fs.symlink(moved,legacy.compatibilityDataPath);
 const symlinkedPrefix=await resolveGameRuntime({runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64',gameId:'test',selection:'default',runtimeBuild:origin});
 await expect(bindRuntimePrefix(symlinkedPrefix)).rejects.toThrow('symlinks');
 expect(await fs.readFile(path.join(moved,'save'),'utf8')).toBe('legacy build progress');
});
it('persists valid game selections and rejects malformed identities without changing existing state',async()=>{
 const {StateStore}=await import('./store');const store=new StateStore(path.join(root,'profile'));
 await store.upsertGame({id:'test',path:'/synthetic/game',title:'Synthetic',installState:'ready',addedAt:'2026-01-01'});
 await store.patchGame('test',{runtime:family,runtimePrefixIdentity:{layout:'game'}});
 const reloaded=new StateStore(path.join(root,'profile'));await reloaded.load();
 expect(reloaded.games[0]).toMatchObject({runtime:family,runtimePrefixIdentity:{layout:'game'}});
 await expect(store.patchGame('test',{runtime:'/bin/wine' as never})).rejects.toThrow('Unknown');
 await expect(store.patchGame('test',{runtimeSeparatePrefix:'yes' as never})).rejects.toThrow('Invalid');
 for(const forged of [{layout:'build',family:'../escape'},{layout:'build',family:'nexus',origin:{}},{layout:'/tmp/prefix'}])
   await expect(store.patchGame('test',{runtimePrefixIdentity:forged as never})).rejects.toThrow();
 expect(store.games[0].runtimePrefixIdentity).toEqual({layout:'game'});
 expect(store.games[0].runtime).toBe(family);
});
it('rejects a malformed persisted identity and ignores renderer-supplied prefix paths',async()=>{
 await fixture();
 const options={runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64',gameId:'test',selection:family};
 for(const forged of [{layout:'build',family:'../escape'},{layout:'family',family:'/bin/sh'},{layout:'/tmp/prefix'},'../prefix'])
   await expect(resolveGameRuntime({...options,runtimePrefixIdentity:forged})).rejects.toThrow('Invalid runtime prefix identity');
 // An injected path is not part of the identity model and cannot redirect the prefix.
 const injected=path.join(root,'renderer-prefix');
 const context=await resolveGameRuntime({...options,runtimePrefixIdentity:{layout:'game',path:injected}});
 expect(context.compatibilityDataPath).toBe(path.join(root,'compatdata','test'));
 await bindRuntimePrefix(context);
 expect(await present(injected)).toBe(false);
 expect(runtimePrefixIdentity({layout:'game',path:injected})).toEqual({layout:'game'});
});
it('rejects a hostile persisted game id before any prefix path is derived',async()=>{
 await fixture();
 await expect(captureGamePrefixIdentity({dataRoot:root,gameId:'../escape',game:{runtime:family}})).rejects.toThrow('Invalid game prefix identity');
 await expect(resolveGameRuntime({runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',gameId:'../escape',selection:family})).rejects.toThrow('Invalid game prefix identity');
 await expect(present(path.join(path.dirname(root),'escape'))).resolves.toBe(false);
});
it('adopts the single existing historical prefix and keeps it stable across default, CachyOS and Standard',async()=>{
 await fixture();const standardRelease=await secondFamily('nexus');
 const cached=await legacyFamilyPrefix('test',family);
 const save=path.join(cached.compatibilityDataPath,'save'),originalBytes=await digest(save);
 // Current selection is default and has no prefix of its own: the one known
 // historical prefix is adopted without guessing, copying or merging.
 let game={...savedGame(),runtime:'default'} as Game;
 expect(await captureGamePrefixIdentity({dataRoot:root,gameId:'test',game:game})).toEqual({layout:'family',family});
 const context=async()=>resolveGameRuntime({runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64',...gameRuntimeParameters(game)});
 Object.assign(game,await approve(game,{runtime:'default'}));
 expect(game.runtimePrefixIdentity).toEqual({layout:'family',family});
 for(const choice of ['default',family,'nexus'] as const) {
   Object.assign(game,await approve(game,{runtime:choice}));
   const current=await context();await bindRuntimePrefix(current);
   expect(current.compatibilityDataPath).toBe(cached.compatibilityDataPath);
   expect(await digest(save)).toBe(originalBytes);
   expect(current.winePath).toBe(choice==='default'||choice==='nexus'?standardRelease:path.join(release,'files/bin/wine'));
 }
 expect(await present(path.join(root,'compatdata'))).toBe(false);
});
it('fails closed on several existing prefixes that the current selection does not use, preserving every byte',async()=>{
 await fixture();await secondFamily('nexus');
 const cached=await legacyFamilyPrefix('test',family),standard=await legacyFamilyPrefix('test','nexus');
 const cachedBytes=await digest(path.join(cached.compatibilityDataPath,'save')),standardBytes=await digest(path.join(standard.compatibilityDataPath,'save'));
 const markerBytes=await fs.readFile(path.join(cached.compatibilityDataPath,'.nexus-runtime-family.json'),'utf8');
 const game={...savedGame(),runtime:'default',runtimePrefixes:{[family]:{layout:'family'},nexus:{layout:'family'}}} as Game;
 await expect(captureGamePrefixIdentity({dataRoot:root,gameId:'test',game})).rejects.toThrow('several existing runtime prefixes');
 await expect(resolveGameRuntime({runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64',...gameRuntimeParameters(game)})).rejects.toThrow('several existing runtime prefixes');
 await expect(approve(game,{runtime:'default'})).rejects.toThrow('several existing runtime prefixes');
 // A launch, a settings save and readiness all refuse before anything is written.
 expect(await gameRuntimeReadiness(()=>({game,runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64'}))).toBe(false);
 expect(await digest(path.join(cached.compatibilityDataPath,'save'))).toBe(cachedBytes);
 expect(await digest(path.join(standard.compatibilityDataPath,'save'))).toBe(standardBytes);
 expect(await fs.readFile(path.join(cached.compatibilityDataPath,'.nexus-runtime-family.json'),'utf8')).toBe(markerBytes);
 expect(await present(path.join(root,'compatdata'))).toBe(false);
 // The capture rule itself is unchanged: a persisted record whose own selection
 // owns an existing prefix resolves that prefix. Recovering such a legacy
 // ambiguity needs deliberate prefix recovery, not the family selector, because
 // capture runs on the current record before a new choice is persisted.
 const owned={...game,runtime:family};
 expect(await captureGamePrefixIdentity({dataRoot:root,gameId:'test',game:owned})).toEqual({layout:'family',family});
 expect((await resolveGameRuntime({runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64',...gameRuntimeParameters(owned)})).compatibilityDataPath).toBe(cached.compatibilityDataPath);
 expect(await fs.readFile(path.join(standard.compatibilityDataPath,'save'),'utf8')).toBe('nexus progress');
});
it('keeps the unbound experimental prefix rejection when the default runner is selected',async()=>{
 await fixture();const legacy=await legacyFamilyPrefix('test',family);
 const pointerFile=path.join(root,'variants',family,'current.json');await fs.unlink(pointerFile);
 const marker=path.join(legacy.compatibilityDataPath,'.nexus-runtime-family.json');
 const saveBytes=await digest(path.join(legacy.compatibilityDataPath,'save'));
 await fs.unlink(marker);
 // The persisted identity keeps the exact experimental location; the runner is
 // the default Wine one, which must not bypass the unknown-provenance check.
 const context=await resolveGameRuntime({runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64',gameId:'test',selection:'default',runtimePrefixIdentity:{layout:'family',family}});
 expect(context.compatibilityDataPath).toBe(legacy.compatibilityDataPath);
 expect(context.managed).toBeUndefined();
 await expect(bindRuntimePrefix(context)).rejects.toThrow('no runtime binding');
 expect(await fs.readFile(path.join(legacy.compatibilityDataPath,'save'),'utf8')).toBe(`${family} progress`);
 expect(await digest(path.join(legacy.compatibilityDataPath,'save'))).toBe(saveBytes);
 expect(await present(marker)).toBe(false);
 // An empty experimental prefix stays unbound and no marker is invented.
 const empty=path.join(root,'runtime-prefixes',family,'prefixes','empty','compatdata');
 const emptyContext=await resolveGameRuntime({runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64',gameId:'empty',selection:'default',runtimePrefixIdentity:{layout:'family',family}});
 await bindRuntimePrefix(emptyContext);
 expect(await present(empty)).toBe(false);
 // A genuinely bound prefix still works with the default runner, marker untouched.
 const bound=await legacyFamilyPrefix('bound');
 const boundMarker=path.join(bound.compatibilityDataPath,'.nexus-runtime-family.json');
 const boundBytes=await fs.readFile(boundMarker,'utf8');
 const boundContext=await resolveGameRuntime({runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64',gameId:'bound',selection:'default',runtimePrefixIdentity:{layout:'family',family}});
 await bindRuntimePrefix(boundContext);
 expect(await fs.readFile(boundMarker,'utf8')).toBe(boundBytes);
 expect(await fs.readFile(path.join(bound.compatibilityDataPath,'save'),'utf8')).toBe(`${family} progress`);
});
it('never adopts a historical prefix whose binding describes another location',async()=>{
 await fixture();const origin=await approval();
 // A build binding inside the family-wide directory must not be adopted as a build prefix.
 const misplaced=path.join(root,'runtime-prefixes',family,'prefixes','test','compatdata');
 await fs.mkdir(misplaced,{recursive:true});
 await fs.writeFile(path.join(misplaced,'.nexus-runtime-family.json'),JSON.stringify({schema:1,family,buildId:origin.buildId,sourceCommit:origin.sourceCommit,manifestSha256:origin.manifestSha256,prefixSchema:1,arch:'x64'}));
 await fs.writeFile(path.join(misplaced,'save'),'misplaced progress');
 await expect(captureGamePrefixIdentity({dataRoot:root,gameId:'test',game:{runtime:'default'}})).rejects.toThrow('no verifiable binding');
 // A build directory whose binding names a different build is refused as well.
 const mismatchBuild='e'.repeat(64),directory=path.join(root,'runtime-prefixes',family,mismatchBuild,'other','compatdata');
 await fs.mkdir(directory,{recursive:true});
 await fs.writeFile(path.join(directory,'.nexus-runtime-family.json'),JSON.stringify({schema:1,family,buildId:origin.buildId,sourceCommit:origin.sourceCommit,manifestSha256:origin.manifestSha256,prefixSchema:1,arch:'x64'}));
 await fs.writeFile(path.join(directory,'save'),'other progress');
 await expect(captureGamePrefixIdentity({dataRoot:root,gameId:'other',game:{runtime:'default'}})).rejects.toThrow('no verifiable binding');
 // Both locations and their bytes stay untouched.
 expect(await fs.readFile(path.join(misplaced,'save'),'utf8')).toBe('misplaced progress');
 expect(await fs.readFile(path.join(directory,'save'),'utf8')).toBe('other progress');
});
it('prefers the canonical prefix when a legacy family directory holds no prefix',async()=>{
 await fixture();const empty=path.join(root,'runtime-prefixes',family,'prefixes','test');await fs.mkdir(empty,{recursive:true});
 expect(await captureGamePrefixIdentity({dataRoot:root,gameId:'test',game:{runtime:family,runtimePrefixes:{[family]:{layout:'family'}}}})).toEqual({layout:'game'});
 expect(await fs.readdir(empty)).toEqual([]);
});
it('adopts a prefix that exists only as the legacy plain Wine root',async()=>{
 await fixture(false);
 await fs.mkdir(path.join(root,'prefixes','test'),{recursive:true});
 await fs.writeFile(path.join(root,'prefixes','test','save'),'plain wine progress');
 const game=savedGame();
 const context=await resolveGameRuntime({runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64',...gameRuntimeParameters(game)});
 expect(context.identity).toEqual({layout:'game'});
 expect(context.compatibilityDataPath).toBe(path.join(root,'compatdata','test'));
 expect(context.legacyPrefixRoot).toBe(path.join(root,'prefixes','test'));
 await bindRuntimePrefix(context);
 expect(await fs.readFile(path.join(root,'prefixes','test','save'),'utf8')).toBe('plain wine progress');
});
it('ignores unknown entries in the experimental prefix tree instead of adopting them',async()=>{
 await fixture();
 const arbitrary=path.join(root,'runtime-prefixes',family,'renderer-forged','test');
 await fs.mkdir(path.join(arbitrary,'compatdata'),{recursive:true});
 await fs.writeFile(path.join(arbitrary,'compatdata','save'),'unrelated');
 await fs.writeFile(path.join(arbitrary,'compatdata','.nexus-runtime-family.json'),JSON.stringify({schema:2,layout:'family',family,prefixSchema:1,arch:'x64'}));
 expect(await captureGamePrefixIdentity({dataRoot:root,gameId:'test',game:{runtime:'default'}})).toEqual({layout:'game'});
 expect(await fs.readFile(path.join(arbitrary,'compatdata','save'),'utf8')).toBe('unrelated');
});
it('accepts an unrecorded prefix contract but rejects a partial or invalid one',async()=>{
 await fixture();
 const canonical=path.join(root,'compatdata','test'),marker=path.join(canonical,'.nexus-runtime-family.json');
 await fs.mkdir(canonical,{recursive:true});await fs.writeFile(path.join(canonical,'save'),'progress');
 const context=()=>resolveGameRuntime({runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64',gameId:'test',selection:family});
 for(const forged of [{schema:3,layout:'game',gameId:'test',prefixSchema:1},{schema:3,layout:'game',gameId:'test',arch:'x64'},{schema:3,layout:'game',gameId:'test',prefixSchema:'1',arch:'x64'},{schema:3,layout:'game',gameId:'test',prefixSchema:1,arch:7},{schema:3,layout:'game',gameId:'other',prefixSchema:1,arch:'x64'}]) {
   await fs.writeFile(marker,JSON.stringify(forged));
   await expect(bindRuntimePrefix(await context())).rejects.toThrow('mismatch');
 }
 // A prefix created without a managed payload records no contract and stays usable.
 const unrecorded=JSON.stringify({schema:3,layout:'game',gameId:'test'});
 await fs.writeFile(marker,unrecorded);
 const managed=await context();await bindRuntimePrefix(managed);
 expect(await fs.readFile(marker,'utf8')).toBe(unrecorded);
 expect(await fs.readFile(path.join(canonical,'save'),'utf8')).toBe('progress');
});
it('does not gate a family choice on separate-prefix consent',()=>{
 const installed={id:family,label:'CachyOS',buildId,sourceCommit,manifestSha256:hash('x')};
 expect(gameRuntimeAvailable(family,false,[installed])).toBe(true);
 expect(gameRuntimeAvailable(family,true,[])).toBe(false);
 expect(gameRuntimeAvailable('default',false,[])).toBe(false);
 expect(gameRuntimeAvailable(undefined,true,[installed])).toBe(true);
});

it('Stop uses its captured runtime and prefix after another launch is selected',async()=>{
 await fixture();await secondFamily('nexus');
 const server=path.join(release,'files/bin/wineserver');
 const stopLog=path.join(root,'captured-stop.log');
 await fs.writeFile(server,`#!/bin/sh\nprintf '%s\\n' "$WINEPREFIX" >> '${stopLog}'\n`,{mode:0o755});
 const pointerFile=path.join(root,'variants',family,'current.json');
 const manifestFile=path.join(release,'nexus-family.json');
 const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));manifest.files['files/bin/wineserver']=hash(await fs.readFile(server));
 const bytes=JSON.stringify(manifest);await fs.writeFile(manifestFile,bytes);
 const pointer=JSON.parse(await fs.readFile(pointerFile,'utf8'));pointer.manifestSha256=hash(bytes);await fs.writeFile(pointerFile,JSON.stringify(pointer));
 const options={runtimeRoot:root,dataRoot:root,gameId:'test',defaultWine:'/default/wine',arch:'x64'};
 const captured=await resolveGameRuntime({...options,selection:family});await bindRuntimePrefix(captured);
 const system32=path.join(captured.compatibilityDataPath,'pfx/drive_c/windows/system32');await fs.mkdir(system32,{recursive:true});
 for(const name of ['libvkd3d-utils-1.dll','dxgi.dll','d3d12.dll'])await fs.writeFile(path.join(system32,name),'synthetic');
 const runner=await prepareProtonRunner(captured.winePath,captured.compatibilityDataPath,path.join(root,'synthetic-steam'));
 expect(runner).toBeDefined();
 await resolveGameRuntime({...options,selection:'default'});
 await fs.unlink(pointerFile); // Current selection/pointer cannot change a running Stop command.
 await promisify(execFileCallback)(runner!.stopPrefix.command,runner!.stopPrefix.args);
 expect((await fs.readFile(stopLog,'utf8')).trim()).toBe(path.join(captured.compatibilityDataPath,'pfx'));
 expect(await fs.readdir(path.join(root,'compatdata'))).toEqual(['test']);
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
 await fixture(false);const alias=path.join(root,'wine-alias');await fs.symlink(path.join(release,'files/bin/wine'),alias);
 const options={runtimeRoot:root,dataRoot:root,gameId:'test',selection:'default',arch:'x64'};
 await expect(resolveGameRuntime({...options,defaultWine:alias})).rejects.toThrow('cannot be the default Wine');
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
let paths:RuntimeSettingsPaths;
const approve=(game:Game,request:RuntimeSettingsRequest,resolve=resolveRuntimeFamily)=>approvedRuntimeSettings(game,request,paths,resolve);
it('follows verified current B with the same per-game prefix and existing saves, while captured A remains immutable',async()=>{
 await fixture();let game=savedGame();Object.assign(game,await approve(game,{runtime:family}));
 const options=()=>({runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64',...gameRuntimeParameters(game)});
 const a=await resolveGameRuntime(options());await bindRuntimePrefix(a);const save=path.join(a.compatibilityDataPath,'save');await fs.writeFile(save,'real synthetic progress');const ino=(await fs.stat(save)).ino;
 await retainRuntimeFamilyBuild(root,family,'x64');await switchBuild('d'.repeat(64));
 const b=await resolveGameRuntime(options());await bindRuntimePrefix(b);expect(b.winePath).not.toBe(a.winePath);expect(b.compatibilityDataPath).toBe(a.compatibilityDataPath);expect(a.managed?.buildId).toBe(buildId);expect(b.managed?.buildId).toBe('d'.repeat(64));
 expect(await fs.readFile(save,'utf8')).toBe('real synthetic progress');expect((await fs.stat(save)).ino).toBe(ino);
 const noResolve=vi.fn(()=>{throw Error('Ordinary Save must not need a new build approval');});
 const patch=await approve(game,{},noResolve);
 expect(patch.runtimePrefixIdentity).toEqual(game.runtimePrefixIdentity);expect(noResolve).not.toHaveBeenCalled();
});
it('retains A for rollback but next launch follows B with the same preserved prefix',async()=>{
 await fixture();const a=await approval();await legacyBuildPrefix('retained',a);
 const game={...savedGame(),id:'retained',runtime:family,runtimeBuild:a} as Game;
 const options={runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64',...gameRuntimeParameters(game)};
 const old=await resolveGameRuntime(options);await bindRuntimePrefix(old);
 expect(old.compatibilityDataPath).toBe(path.join(root,'runtime-prefixes',family,a.buildId,'retained','compatdata'));
 await fs.writeFile(path.join(old.compatibilityDataPath,'save'),'A progress');
 await retainRuntimeFamilyBuild(root,family,'x64');await installNextFixture();
 const next=await resolveGameRuntime(options);await bindRuntimePrefix(next);
 expect(next.winePath).not.toBe(old.winePath);expect(next.compatibilityDataPath).toBe(old.compatibilityDataPath);expect(await fs.readFile(path.join(next.compatibilityDataPath,'save'),'utf8')).toBe('A progress');
 expect((await resolveRuntimeFamilyBuild(root,family,a,'x64')).winePath).toBe(old.winePath);
 await fs.writeFile(path.join(root,'variants',family,'current.json'),JSON.stringify({schema:1,family,sourceRepository,...a}));
 expect((await resolveGameRuntime(options)).winePath).toBe(old.winePath);
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
it.each(['approval','runtimeRoot','identity'])('rejects readiness if %s changes during verification',async changed=>{
 await fixture();const state:RuntimeReadinessState={game:{id:'readiness',runtime:family,runtimeSeparatePrefix:true,runtimeBuild:await approval()},runtimeRoot:root,dataRoot:root,defaultWine:undefined,arch:'x64'};
 let resume!:()=>void;const held=new Promise<void>(resolve=>resume=resolve);
 const result=gameRuntimeReadiness(()=>state,async options=>{await held;return resolveGameRuntime(options);});
 if(changed==='approval')state.game={...state.game!,runtimeBuild:{...state.game!.runtimeBuild!,buildId:'d'.repeat(64)}};
 else if(changed==='identity')state.game={...state.game!,runtimePrefixIdentity:{layout:'game'}};
 else state.runtimeRoot+='-changed';
 resume();expect(await result).toBe(false);
});
it('readiness and launch resolve the same per-game prefix for the same persisted record',async()=>{
 await fixture();const legacy=await legacyBuildPrefix('readiness',await approval());
 const game={...savedGame(),id:'readiness',runtime:family} as Game;
 expect(await gameRuntimeReadiness(()=>({game,runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64'}))).toBe(true);
 const context=await resolveGameRuntime({runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64',...gameRuntimeParameters(game)});
 // Both entry points adopt the single existing historical prefix, never a new one.
 expect(context.compatibilityDataPath).toBe(legacy.compatibilityDataPath);
});
it('holds the activity reservation from before the async verification through the persisted write',async()=>{
 await fixture();const game=savedGame();
 let held=false,launchAttempts=0;
 const reserve=()=>{
   expect(held).toBe(false);held=true;
   return {
     admit:()=>{expect(held).toBe(true);},
     release:()=>{expect(held).toBe(true);held=false;},
   };
 };
 // A launch or component update entry point fails while the reservation is held.
 const enterLaunch=()=>{launchAttempts++;if(held)throw Error('Component updates are in progress.');};
 const persist=vi.fn(async(patch:Partial<Game>)=>{expect(held).toBe(true);return {...game,...patch};});
 let resume!:()=>void;const pending=new Promise<void>(resolve=>{resume=resolve;});
 const approve=vi.fn(async()=>{await pending;expect(held).toBe(true);enterLaunch;return {runtime:family,runtimePrefixIdentity:{layout:'game'} as const};});
 const running=guardedRuntimeSettings({current:game,request:{runtime:family},paths,changing:true,reserve,read:()=>game,persist,approve});
 await Promise.resolve();
 // The reservation is already held while the verification is still pending.
 expect(held).toBe(true);expect(()=>enterLaunch()).toThrow('Component updates are in progress.');
 resume();
 const saved=await running;
 expect(saved.runtime).toBe(family);expect(persist).toHaveBeenCalledTimes(1);
 expect(held).toBe(false);expect(launchAttempts).toBe(1);
});
it('releases the reservation when verification or the persisted record check fails',async()=>{
 await fixture();const game=savedGame();
 let held=false;
 const reserve=()=>({admit:()=>{},release:()=>{held=false;}});
 held=true;
 await expect(guardedRuntimeSettings({current:game,request:{runtime:family},paths,changing:true,reserve,read:()=>({...game,runtime:'default',runtimePrefixIdentity:{layout:'game'}}),persist:async()=>game,approve:async()=>({runtime:family})})).rejects.toThrow('changed');
 expect(held).toBe(false);
 held=true;
 await expect(guardedRuntimeSettings({current:game,request:{runtime:family},paths,changing:true,reserve,read:()=>game,persist:async()=>game,approve:async()=>{throw Error('default was not used');}})).rejects.toThrow('default was not used');
 expect(held).toBe(false);
 // A reservation that cannot be acquired blocks the change before any write.
 await expect(guardedRuntimeSettings({current:game,request:{runtime:family},paths,changing:true,reserve:()=>{throw Error('Another Xodus operation is active. Wait for it to finish or stop it first.');},read:()=>game,persist:async()=>game,approve:async()=>({runtime:family})})).rejects.toThrow('operation is active');
});
it('does not reserve activity for an unchanged runtime but still refuses a changed record',async()=>{
 await fixture();const game=savedGame();
 let reserved=0;
 const reserve=()=>{reserved++;return {admit:()=>{},release:()=>{}};};
 const saved=await guardedRuntimeSettings({current:game,request:{runtime:'default'},paths,changing:false,reserve,read:()=>game,persist:async(patch)=>({...game,...patch}),approve:async()=>({runtime:'default',runtimePrefixIdentity:{layout:'game'}})});
 expect(saved.runtimePrefixIdentity).toEqual({layout:'game'});
 expect(reserved).toBe(0);
 await expect(guardedRuntimeSettings({current:game,request:{runtime:'default'},paths,changing:false,reserve,read:()=>({...game,runtimePrefixIdentity:{layout:'family',family}}),persist:async()=>game,approve:async()=>({runtime:'default'})})).rejects.toThrow('changed');
 expect(reserved).toBe(0);
});
it('persists the captured identity atomically with the selection and survives reload',async()=>{
 await fixture();await secondFamily('nexus');const {StateStore}=await import('./store');
 const store=new StateStore(path.join(root,'profile'));
 await store.upsertGame(savedGame());
 const saved=await store.patchGame('test',await approve(store.games[0],{runtime:family}));
 expect(saved.runtime).toBe(family);expect(saved.runtimePrefixIdentity).toEqual({layout:'game'});
 const reloaded=new StateStore(path.join(root,'profile'));await reloaded.load();
 const loaded=reloaded.games[0];
 expect(loaded.runtimePrefixIdentity).toEqual({layout:'game'});
 // The reloaded record resolves the same prefix even though the selection changed.
 expect((await resolveGameRuntime({runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64',...gameRuntimeParameters(loaded)})).compatibilityDataPath).toBe(path.join(root,'compatdata','test'));
 Object.assign(loaded,await approve(loaded,{runtime:'default'}));
 expect((await resolveGameRuntime({runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64',...gameRuntimeParameters(loaded)})).compatibilityDataPath).toBe(path.join(root,'compatdata','test'));
});
it('rejects an old marker conflicting with its persisted origin without rewriting it or its save',async()=>{
 await fixture();const origin=await approval(),legacy=await legacyBuildPrefix('old',origin);
 const marker=path.join(legacy.compatibilityDataPath,'.nexus-runtime-family.json');
 const invalid=JSON.stringify({...JSON.parse(await fs.readFile(marker,'utf8')),manifestSha256:'0'.repeat(64)});
 await fs.writeFile(marker,invalid);
 await switchBuild('d'.repeat(64));
 const context=await resolveGameRuntime({runtimeRoot:root,dataRoot:root,defaultWine:'/default/wine',arch:'x64',gameId:'old',selection:family,runtimeBuild:origin});
 expect(context.compatibilityDataPath).toBe(legacy.compatibilityDataPath);
 await expect(bindRuntimePrefix(context)).rejects.toThrow('mismatch');
 expect(await fs.readFile(marker,'utf8')).toBe(invalid);
 expect(await fs.readFile(path.join(legacy.compatibilityDataPath,'save'),'utf8')).toBe('legacy build progress');
});
