import {promises as fs} from 'node:fs';
import path from 'node:path';
import {gameRuntimeSelection,runtimePrefixAnchor,runtimeBuildApproval,type RuntimePrefixAnchor,type GameRuntimeSelection} from '../shared/runtime-selection.js';
import {resolveRuntimeFamily,type ResolvedRuntimeFamily} from './runtime-families.js';
export interface GameRuntimeContext {
  readonly selection:GameRuntimeSelection;readonly family:'default'|'nexus'|'nexus-cachyos';
  readonly winePath:string;readonly compatibilityDataPath:string;readonly legacyPrefixRoot:string;readonly dataRoot:string;
  readonly prefixAnchor?:Readonly<RuntimePrefixAnchor>;readonly managed?:Readonly<ResolvedRuntimeFamily>;
}
/** Capture once before prerequisite staging or launch. Later setting/pointer
 * changes cannot redirect this session, its prefix or its captured Stop runner. */
export async function resolveGameRuntime(options:{runtimeRoot:string;dataRoot:string;gameId:string;selection:unknown;separatePrefix:unknown;approvedBuild?:unknown;prefixAnchor?:unknown;defaultWine:string|undefined;arch?:string}):Promise<Readonly<GameRuntimeContext>> {
  const selection=gameRuntimeSelection(options.selection);
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(options.gameId))throw Error('Invalid game prefix identity.');
  if(selection==='default') {
    if(!options.defaultWine)throw Error('Select a default Wine / Proton runtime in Settings.');
    const canonical=async(file:string)=>fs.realpath(file).catch(error=>{if(error.code==='ENOENT')return path.resolve(file);throw error;});
    const managed=path.join(options.runtimeRoot,'variants');
    const inside=(root:string,file:string)=>{const relative=path.relative(root,file);return Boolean(relative)&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
    if(inside(managed,options.defaultWine)||inside(await canonical(managed),await canonical(options.defaultWine)))throw Error('Select managed runtime families per game with a separate prefix.');
    return Object.freeze({selection,family:'default',winePath:options.defaultWine,dataRoot:options.dataRoot,
      compatibilityDataPath:path.join(options.dataRoot,'compatdata',options.gameId),legacyPrefixRoot:path.join(options.dataRoot,'prefixes',options.gameId)});
  }
  if(options.separatePrefix!==true)throw Error('Choose a separate runtime prefix before using this family. Existing local saves remain in the old prefix.');
  const managed=await resolveRuntimeFamily(options.runtimeRoot,selection,options.arch);
  // Persisted pre-0.5 build metadata identifies an existing prefix, not its next runtime.
  const anchor=options.prefixAnchor!==undefined?runtimePrefixAnchor(options.prefixAnchor):options.approvedBuild!==undefined?{layout:'build' as const,origin:runtimeBuildApproval(options.approvedBuild)}:{layout:'family' as const};
  const root=path.join(options.dataRoot,'runtime-prefixes',selection,anchor.layout==='build'?anchor.origin.buildId:'prefixes',options.gameId);
  return Object.freeze({selection,family:selection,winePath:managed.winePath,dataRoot:options.dataRoot,managed,prefixAnchor:Object.freeze(anchor),
    compatibilityDataPath:path.join(root,'compatdata'),legacyPrefixRoot:path.join(root,'wine')});
}
/** No pfx/wineboot, copying, save migration or default pointer mutation. */
export async function bindRuntimePrefix(context:Readonly<GameRuntimeContext>):Promise<void> {
  const marker=path.join(context.compatibilityDataPath,'.nexus-runtime-family.json');
  if(context.managed) {
    const relative=path.relative(context.dataRoot,context.compatibilityDataPath);
    if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('Unsafe runtime prefix location.');
    let directory=context.dataRoot;
    for(const part of relative.split(path.sep)) {
      directory=path.join(directory,part);
      try{if(!(await fs.lstat(directory)).isDirectory())throw Error('Runtime prefix path cannot contain symlinks.');}
      catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')break;throw error;}
    }
    try{if(!(await fs.lstat(marker)).isFile())throw Error('Runtime prefix binding must be a regular file.');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  const anchor=context.prefixAnchor;
  const expected=context.managed?(anchor?.layout==='build'?{schema:1,family:context.family,buildId:anchor.origin.buildId,sourceCommit:anchor.origin.sourceCommit,manifestSha256:anchor.origin.manifestSha256,prefixSchema:context.managed.prefixSchema,arch:context.managed.arch}:{schema:2,family:context.family,layout:'family',prefixSchema:context.managed.prefixSchema,arch:context.managed.arch}):undefined;
  try {
    const current=JSON.parse(await fs.readFile(marker,'utf8'));
    if(!expected) {if(current.family!=='default')throw Error('The default prefix belongs to another runtime family.');return;}
    if(Object.keys(current).length!==Object.keys(expected).length||Object.entries(expected).some(([key,value])=>current[key]!==value))throw Error('Runtime prefix binding mismatch. Existing prefix was preserved.');
    return;
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(!expected)return; // Preserve the existing, unbound legacy default prefix.
  // An unbound nonempty experimental prefix has unknown provenance, never adopt it.
  const entries=await fs.readdir(context.compatibilityDataPath).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  if(entries.length)throw Error('Experimental prefix has no runtime binding. Existing files were preserved.');
  await fs.mkdir(context.compatibilityDataPath,{recursive:true,mode:0o700});
  await fs.writeFile(marker,JSON.stringify(expected),{flag:'wx',mode:0o600});
}
