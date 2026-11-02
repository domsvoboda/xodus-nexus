import {constants,createReadStream,promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {gameRuntimeSelection,runtimeFamilies,runtimeFamilyLabels,type RuntimeFamily,type InstalledRuntimeFamily} from '../shared/runtime-selection.js';
const repositories:Record<RuntimeFamily,string>={nexus:'domsvoboda/nexus-runtime','nexus-cachyos':'domsvoboda/nexus-runtime-cachyos'};
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function fileDigest(file:string) {
  const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');
}
const hash=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const commit=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const within=(root:string,file:string)=>{const relative=path.relative(root,file);return Boolean(relative)&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
export interface ResolvedRuntimeFamily extends InstalledRuntimeFamily {
  readonly winePath:string;readonly root:string;readonly arch:'x64'|'arm64';readonly prefixSchema:1;readonly manifestSha256:string;
}
/** Read a receipt written by a verified managed installer, never a user-supplied
 * executable. A missing or damaged selected family cannot fall back to default. */
async function verifyRuntimeFamily(runtimeRoot:string,selection:unknown,arch:string=process.arch):Promise<Readonly<ResolvedRuntimeFamily>> {
  const id=gameRuntimeSelection(selection);
  if(id==='default')throw Error('Default runtime resolution requires the existing global runtime.');
  if(!['x64','arm64'].includes(arch))throw Error('Unsupported runtime architecture.');
  try {
    const managedRoot=await fs.realpath(runtimeRoot);
    const directory=path.join(runtimeRoot,'variants',id);
    if(!within(managedRoot,await fs.realpath(directory)))throw Error('Family directory leaves managed root');
    const pointer=JSON.parse(await fs.readFile(path.join(directory,'current.json'),'utf8'));
    if(pointer.schema!==1||pointer.family!==id||pointer.sourceRepository!==repositories[id]||!commit(pointer.sourceCommit)||!hash(pointer.manifestSha256)||!hash(pointer.buildId))throw Error('Invalid managed runtime receipt');
    const requestedRoot=path.join(directory,'releases',pointer.buildId);
    if(!(await fs.lstat(requestedRoot)).isDirectory())throw Error('Runtime root must be a real directory');
    const root=await fs.realpath(requestedRoot);
    const releases=await fs.realpath(path.join(directory,'releases'));
    if(!within(managedRoot,releases)||!within(releases,root))throw Error('Runtime build leaves its managed directory');
    if(!(await fs.lstat(path.join(root,'nexus-family.json'))).isFile())throw Error('Runtime manifest must be a regular file');
    const bytes=await fs.readFile(path.join(root,'nexus-family.json'));
    if(digest(bytes)!==pointer.manifestSha256)throw Error('Runtime manifest checksum mismatch');
    const manifest=JSON.parse(bytes.toString('utf8'));
    if(manifest.schema!==1||manifest.family!==id||manifest.sourceRepository!==repositories[id]||manifest.sourceCommit!==pointer.sourceCommit||manifest.buildId!==pointer.buildId||manifest.arch!==arch||manifest.prefixSchema!==1||!manifest.files||Array.isArray(manifest.files)||typeof manifest.files!=='object')throw Error('Runtime manifest identity mismatch');
    const loader=arch==='arm64'?'files/bin-arm64/wine':'files/bin/wine';
    const server=arch==='arm64'?'files/bin-arm64/wineserver':'files/bin/wineserver';
    // Installer manifests must cover the Proton entry point and complete payload.
    const critical=['proton',loader,server,loader+'.nexus-original','XODUS_NEXUS_PATCH.json',
      ...['PlayFabGameSave.dll','gaming-services-version.exe','package-registration.exe'].map(name=>'files/share/xodus-nexus/compat/'+name),
      ...['x86_64','i386'].flatMap(cpu=>['xgameruntime.dll','winhttp.dll','libnghttp2.dll'].map(name=>`files/lib/wine/${cpu}-windows/${name}`))];
    if(arch==='arm64')throw Error('Experimental managed variants require a separately reviewed ARM64 payload contract');
    for(const required of critical)if(!hash(manifest.files[required]))throw Error('Runtime launch file missing');
    for(const [name,expected] of Object.entries(manifest.files)) {
      if(!hash(expected)||!name||name.includes('\\')||name.split('/').some(part=>!part||part==='.'||part==='..')||path.isAbsolute(name))throw Error('Unsafe runtime manifest path');
      if(!(await fs.lstat(path.join(root,name))).isFile())throw Error('Runtime file inventory must name regular files');
      const target=await fs.realpath(path.join(root,name));
      if(!within(root,target)||(await fs.stat(target)).isFile()!==true||await fileDigest(target)!==expected)throw Error('Runtime payload checksum mismatch');
    }
    const symlinks=manifest.symlinks??{};
    const templateMapping=(name:string,target:unknown)=>name==='files/share/default_pfx/dosdevices/z:'&&target==='/';
    if(!symlinks||Array.isArray(symlinks)||typeof symlinks!=='object')throw Error('Invalid runtime symlink inventory');
    for(const [name,target] of Object.entries(symlinks)) {
      if(typeof target!=='string'||!target||path.isAbsolute(target)&&!templateMapping(name,target)||!name||name.includes('\\')||name.split('/').some(part=>!part||part==='.'||part==='..')||path.isAbsolute(name)||name in manifest.files)throw Error('Unsafe runtime symlink path');
      const file=path.join(root,name);
      if(!(await fs.lstat(file)).isSymbolicLink()||await fs.readlink(file)!==target||!within(root,await fs.realpath(path.dirname(file)))||!templateMapping(name,target)&&!within(root,await fs.realpath(file)))throw Error('Runtime symlink leaves verified payload');
    }
    const inventory:string[]=[];
    const walk=async(directory:string)=>{for(const item of await fs.readdir(directory,{withFileTypes:true})){
      const file=path.join(directory,item.name),name=path.relative(root,file).split(path.sep).join('/');
      if(item.isDirectory())await walk(file);else if(name!=='nexus-family.json')inventory.push(name);
    }};
    await walk(root);
    if(inventory.sort().join('\n')!==[...Object.keys(manifest.files),...Object.keys(symlinks)].sort().join('\n'))throw Error('Runtime payload inventory is incomplete');
    const metadata=JSON.parse(await fs.readFile(path.join(root,'XODUS_NEXUS_PATCH.json'),'utf8'));
    if(metadata.schema!==1||!hash(metadata.sourceLockSha256)||!metadata.sourceGraph||typeof metadata.sourceGraph!=='object'||metadata.sourceGraph.proton!==pointer.sourceCommit||metadata.sourceLockSha256!==manifest.sourceLockSha256)throw Error('Runtime source graph is not bound');
    if(!(await fs.stat(path.join(root,'files/share/default_pfx'))).isDirectory())throw Error('Runtime default prefix missing');
    const winePath=path.join(root,loader);
    for(const file of [winePath,path.join(root,'proton'),path.join(root,server)]) {
      if(!(await fs.lstat(file)).isFile())throw Error('Runtime launcher cannot be a symlink');
      await fs.access(file,constants.X_OK);
    }
    return Object.freeze({id,label:runtimeFamilyLabels[id],buildId:pointer.buildId,sourceCommit:pointer.sourceCommit,winePath,root,arch:arch as 'x64'|'arm64',prefixSchema:1,manifestSha256:pointer.manifestSha256});
  }catch(error){throw Error(`${runtimeFamilyLabels[id]} is unavailable or failed verification. Reinstall this selected runtime; the default was not used.`,{cause:error});}
}
// A cache hit still checks identities and the complete inventory, but never
// reads payload contents. Receipt/manifest/root changes, additions, removals,
// replacements and writes invalidate it. Never cache a concurrently changed scan.
const verified=new Map<string,{fingerprint:string;value:Readonly<ResolvedRuntimeFamily>}>();
const inFlight=new Map<string,Promise<Readonly<ResolvedRuntimeFamily>>>();
let fullPasses=0,cacheHits=0;
export const runtimeFamilyVerificationStats=()=>Object.freeze({fullPasses,cacheHits});
async function runtimeFingerprint(runtimeRoot:string,id:RuntimeFamily):Promise<string> {
  const hash=createHash('sha256');
  const add=(value:string)=>{hash.update(String(Buffer.byteLength(value)));hash.update(':');hash.update(value);};
  const root=await fs.realpath(runtimeRoot),directory=path.join(runtimeRoot,'variants',id);
  const canonical=await fs.realpath(directory);
  if(!within(root,canonical))throw Error('Family path leaves runtime root');
  add(root);add(canonical);
  const pointerFile=path.join(directory,'current.json');
  if(!(await fs.lstat(pointerFile)).isFile())throw Error('Receipt must be a regular file');
  const bytes=await fs.readFile(pointerFile);add(bytes.toString('utf8'));
  const pointer=JSON.parse(bytes.toString('utf8'));
  if(!hashId(pointer.buildId))throw Error('Invalid managed build identity');
  const release=path.join(directory,'releases',pointer.buildId);
  const identity=async(file:string)=>{
    const stat=await fs.lstat(file,{bigint:true});
    add(file);add([stat.dev,stat.ino,stat.mode,stat.nlink,stat.size,stat.mtimeNs,stat.ctimeNs].join(':'));
    if(stat.isSymbolicLink())add(await fs.readlink(file));
    return stat;
  };
  for(const file of [runtimeRoot,directory,path.join(directory,'releases'),pointerFile])await identity(file);
  const walk=async(file:string)=>{
    const stat=await identity(file);
    if(stat.isDirectory())for(const name of (await fs.readdir(file)).sort())await walk(path.join(file,name));
  };
  await walk(release);
  return hash.digest('hex');
}
const hashId=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export async function resolveRuntimeFamily(runtimeRoot:string,selection:unknown,arch:string=process.arch):Promise<Readonly<ResolvedRuntimeFamily>> {
  const id=gameRuntimeSelection(selection);
  if(id==='default')throw Error('Default runtime resolution requires the existing global runtime.');
  const key=JSON.stringify([path.resolve(runtimeRoot),id,arch]);
  const pending=inFlight.get(key);if(pending)return pending;
  const work=(async()=>{
    try {
      const before=await runtimeFingerprint(runtimeRoot,id);
      const previous=verified.get(key);
      if(previous?.fingerprint===before){
        if(await runtimeFingerprint(runtimeRoot,id)!==before)throw Error('Runtime changed during cached verification.');
        cacheHits++;return previous.value;
      }
      verified.delete(key);fullPasses++;
      const value=await verifyRuntimeFamily(runtimeRoot,id,arch);
      if(await runtimeFingerprint(runtimeRoot,id)!==before)throw Error('Runtime changed during verification. Retry after installation finishes.');
      verified.set(key,{fingerprint:before,value});
      while(verified.size>8)verified.delete(verified.keys().next().value!);
      return value;
    }catch(error){verified.delete(key);throw Error(`${runtimeFamilyLabels[id]} is unavailable or failed verification. Reinstall this selected runtime; the default was not used.`,{cause:error});}
  })();
  inFlight.set(key,work);
  try{return await work;}finally{if(inFlight.get(key)===work)inFlight.delete(key);}
}
export async function installedRuntimeFamilies(runtimeRoot:string,arch:string=process.arch):Promise<InstalledRuntimeFamily[]> {
  const results=await Promise.all(runtimeFamilies.map(async id=>{
    try{const value=await resolveRuntimeFamily(runtimeRoot,id,arch);return {id:value.id,label:value.label,buildId:value.buildId,sourceCommit:value.sourceCommit,manifestSha256:value.manifestSha256};}catch{return undefined;}
  }));
  return results.filter((value):value is InstalledRuntimeFamily=>Boolean(value));
}
