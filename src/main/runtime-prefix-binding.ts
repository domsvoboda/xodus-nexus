import {promises as fs} from 'node:fs';
import path from 'node:path';
import {gameRuntimeSelection,legacyRuntimePrefixOrigin,runtimeFamilies,runtimePrefixIdentity,type GameRuntimeSelection,type RuntimeFamily,type RuntimePrefixIdentity} from '../shared/runtime-selection.js';
import {resolveRuntimeFamily,type ResolvedRuntimeFamily} from './runtime-families.js';
import {legacyCachyosState} from './legacy-runtime-state.js';
export interface GameRuntimeContext {
  readonly selection:GameRuntimeSelection;
  /** Durable prefix location captured before any selection change. */
  readonly identity:Readonly<RuntimePrefixIdentity>;readonly gameId:string;
  readonly winePath:string;readonly compatibilityDataPath:string;readonly legacyPrefixRoot:string;readonly dataRoot:string;
  readonly managed?:Readonly<ResolvedRuntimeFamily>;
}
/** The persisted fields that may describe an existing game prefix. */
export interface GameRuntimeParameters {
  gameId:string;selection:unknown;runtimePrefixIdentity?:unknown;runtimeBuild?:unknown;runtimePrefixes?:unknown;
}
/** One mapping for launch, readiness and the settings entry point, so they can
 * never resolve a different prefix for the same persisted game record. */
export function gameRuntimeParameters(game:{id:string;runtime?:unknown;runtimePrefixIdentity?:unknown;runtimeBuild?:unknown;runtimePrefixes?:unknown}):GameRuntimeParameters {
  return {gameId:game.id,selection:game.runtime,runtimePrefixIdentity:game.runtimePrefixIdentity,runtimeBuild:game.runtimeBuild,runtimePrefixes:game.runtimePrefixes};
}
export interface PrefixPaths {readonly compatibilityDataPath:string;readonly legacyPrefixRoot:string}
/** Experimental layouts are only ever derived from a known family id plus the
 * family-wide 'prefixes' directory or an exact 64 hex build id. */
function experimentalPaths(dataRoot:string,gameId:string,family:RuntimeFamily,layout:'family'|'build',buildId?:string):PrefixPaths {
  const root=path.join(dataRoot,'runtime-prefixes',family,layout==='build'?String(buildId):'prefixes',gameId);
  return {compatibilityDataPath:path.join(root,'compatdata'),legacyPrefixRoot:path.join(root,'wine')};
}
/** Every derivation uses the same conservative id alphabet, so persisted or
 * renderer-supplied text can never escape the prefix store. */
function prefixGameId(value:string):string {
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(value))throw Error('Invalid game prefix identity.');
  return value;
}
/** Backend-owned path derivation. Identity layouts select a fixed location; no
 * renderer value can name a directory. */
export function runtimePrefixPaths(dataRoot:string,gameId:string,identity:RuntimePrefixIdentity):PrefixPaths {
  prefixGameId(gameId);
  if(identity.layout==='game')return {compatibilityDataPath:path.join(dataRoot,'compatdata',gameId),legacyPrefixRoot:path.join(dataRoot,'prefixes',gameId)};
  return identity.layout==='family'?experimentalPaths(dataRoot,gameId,identity.family,'family'):experimentalPaths(dataRoot,gameId,identity.family,'build',identity.origin.buildId);
}
async function prefixPresent(directory:string):Promise<boolean> {
  let stat;
  try { stat=await fs.lstat(directory); }
  catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT')return false; throw error; }
  // A symlink or an unexpected entry is still a prefix location; the binding
  // step rejects it instead of silently choosing another directory.
  if(stat.isSymbolicLink()||!stat.isDirectory())return true;
  return (await fs.readdir(directory)).length>0;
}
/** A prefix may hold either a Proton compatdata tree or a plain Wine prefix. */
async function prefixLocationPresent(paths:PrefixPaths):Promise<boolean> {
  return await prefixPresent(paths.compatibilityDataPath)||await prefixPresent(paths.legacyPrefixRoot);
}
const markerName='.nexus-runtime-family.json';
function plainObject(value:unknown):Record<string,unknown>|undefined {
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  const prototype=Object.getPrototypeOf(value) as unknown;
  return prototype===Object.prototype||prototype===null?value as Record<string,unknown>:undefined;
}
/** Parsed binding file, or undefined only when no file exists. A file that
 * parses to anything other than a plain object is returned as-is so validation
 * rejects it instead of treating it as unbound. */
async function readMarker(directory:string):Promise<unknown> {
  let source:string;
  try { source=await fs.readFile(path.join(directory,markerName),'utf8'); }
  catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined; throw error; }
  try { return JSON.parse(source) as unknown; }
  catch { throw Error('Runtime prefix binding is unreadable. Existing prefix was preserved.'); }
}
/** Origin of an existing experimental prefix, taken from its own binding. The
 * binding must describe the layout that the directory name already implies, so
 * an adopted identity can never point at another location. */
async function boundExpectation(paths:PrefixPaths,family:RuntimeFamily,layout:'family'|'build',buildId?:string):Promise<RuntimePrefixIdentity|undefined> {
  const marker=plainObject(await readMarker(paths.compatibilityDataPath));
  if(!marker||marker.family!==family)return undefined;
  if(layout==='family')return marker.schema===2&&marker.layout==='family'?{layout:'family',family}:undefined;
  if(marker.schema!==1||marker.buildId!==buildId)return undefined;
  try {
    const identity=runtimePrefixIdentity({layout:'build',family,origin:{buildId:marker.buildId,sourceCommit:marker.sourceCommit,manifestSha256:marker.manifestSha256}});
    return identity.layout==='build'?identity:undefined;
  } catch { return undefined; }
}
interface PrefixCandidate extends PrefixPaths {readonly identity?:RuntimePrefixIdentity}
/** Known historical locations of this game's prefix. Never invents entries from
 * arbitrary directory names and never follows a path outside the prefix store. */
async function historicalPrefixes(dataRoot:string,gameId:string):Promise<PrefixCandidate[]> {
  const candidates:PrefixCandidate[]=[];
  for(const family of runtimeFamilies) {
    const directory=path.join(dataRoot,'runtime-prefixes',family);
    let entries:string[];
    try { entries=await fs.readdir(directory); }
    catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT')continue; throw error; }
    for(const entry of entries) {
      if(entry!=='prefixes'&&!/^[a-f0-9]{64}$/.test(entry))continue;
      const layout=entry==='prefixes'?'family':'build';
      const paths=layout==='family'?experimentalPaths(dataRoot,gameId,family,'family'):experimentalPaths(dataRoot,gameId,family,'build',entry);
      if(!await prefixLocationPresent(paths))continue;
      candidates.push({...paths,identity:await boundExpectation(paths,family,layout,layout==='build'?entry:undefined)});
    }
  }
  return candidates;
}
function multiplePrefixes():Error {
  return Error('This game has several existing runtime prefixes. Existing prefix location is ambiguous; the runtime selection and all existing prefixes/saves were preserved.');
}
/**
 * Resolve the durable prefix identity of a game.
 *
 * A persisted identity always wins. Otherwise the location that the persisted
 * selection already uses is adopted, so existing prefixes and saves stay at their
 * exact paths. When that location holds nothing, the single known historical
 * prefix of this game is adopted (no guessing, no copying or merging). Several
 * historical prefixes with none of them selected, or an experimental prefix
 * without a usable binding, fail closed and preserve every byte.
 */
export async function captureGamePrefixIdentity(options:{dataRoot:string;gameId:string;game:Omit<GameRuntimeParameters,'gameId'|'selection'> & {runtime?:unknown}}):Promise<RuntimePrefixIdentity> {
  prefixGameId(options.gameId);
  if(options.game.runtimePrefixIdentity!==undefined)return runtimePrefixIdentity(options.game.runtimePrefixIdentity);
  const state={runtime:options.game.runtime,runtimeBuild:options.game.runtimeBuild,runtimePrefixes:options.game.runtimePrefixes};
  const origin=legacyRuntimePrefixOrigin(state);
  if(await prefixLocationPresent(runtimePrefixPaths(options.dataRoot,options.gameId,origin)))return origin;
  const canonicalPresent=origin.layout!=='game'&&await prefixLocationPresent(runtimePrefixPaths(options.dataRoot,options.gameId,{layout:'game'}));
  const historical=await historicalPrefixes(options.dataRoot,options.gameId);
  if(canonicalPresent) {
    // The pre-0.5 per-game prefix exists but is not the current selection.
    if(historical.length)throw multiplePrefixes();
    return {layout:'game'};
  }
  if(!historical.length)return {layout:'game'};
  if(historical.length>1)throw multiplePrefixes();
  const identity=historical[0].identity;
  if(!identity)throw Error('An existing runtime prefix has no verifiable binding. Existing prefixes and saves were preserved.');
  return identity;
}
/** Capture once before prerequisite staging or launch. Later setting/pointer
 * changes cannot redirect this session, its prefix or its captured Stop runner. */
export async function resolveGameRuntime(options:{runtimeRoot:string;dataRoot:string;defaultWine:string|undefined;arch?:string}&GameRuntimeParameters):Promise<Readonly<GameRuntimeContext>> {
  const selection=gameRuntimeSelection(options.selection);
  prefixGameId(options.gameId);
  const state={runtime:options.selection,runtimeBuild:options.runtimeBuild,runtimePrefixes:options.runtimePrefixes,runtimePrefixIdentity:options.runtimePrefixIdentity};
  const identity=await captureGamePrefixIdentity({dataRoot:options.dataRoot,gameId:options.gameId,game:state});
  const paths=runtimePrefixPaths(options.dataRoot,options.gameId,identity);
  const frozenIdentity=Object.freeze({...identity}) as Readonly<RuntimePrefixIdentity>;
  if(selection==='default') {
    // Standard is the default family for an unconfigured game. A verified
    // Standard receipt wins. The legacy global runtime is a migration fallback
    // only while no managed family is installed at all, so an installed
    // CachyOS family can never become the hidden default.
    const familyInstalled=async(id:RuntimeFamily)=>{try{return (await fs.lstat(path.join(options.runtimeRoot,'variants',id,'current.json'))).isFile();}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}};
    if(await familyInstalled('nexus')) {
      const managed=await resolveRuntimeFamily(options.runtimeRoot,'nexus',options.arch);
      return Object.freeze({selection,identity:frozenIdentity,gameId:options.gameId,winePath:managed.winePath,dataRoot:options.dataRoot,managed,...paths});
    }
    if(await familyInstalled('nexus-cachyos'))throw Error('Install the Standard runtime in Settings. A CachyOS installation is not the default runtime.');
    // The verified legacy CachyOS runner remains valid for an explicit migrated
    // per-game choice, but it must never become the hidden default for a new or
    // unconfigured game after the one-time migration. That needs Standard.
    const legacyCachy=await legacyCachyosState(options.runtimeRoot,options.defaultWine??'');
    if(legacyCachy)throw Error('Install the Standard runtime in Settings. The existing CachyOS runtime is not the default; choose CachyOS per game or install Standard.');
    if(!options.defaultWine)throw Error('Install the Standard runtime in Settings.');
    const canonical=async(file:string)=>fs.realpath(file).catch(error=>{if(error.code==='ENOENT')return path.resolve(file);throw error;});
    const managed=path.join(options.runtimeRoot,'variants');
    const inside=(root:string,file:string)=>{const relative=path.relative(root,file);return Boolean(relative)&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
    if(inside(managed,options.defaultWine)||inside(await canonical(managed),await canonical(options.defaultWine)))throw Error('Choose a managed runtime family for this game; a family runner cannot be the default Wine / Proton runtime.');
    return Object.freeze({selection,identity:frozenIdentity,gameId:options.gameId,winePath:options.defaultWine,dataRoot:options.dataRoot,...paths});
  }
  let managed: Readonly<ResolvedRuntimeFamily>;
  try {
    managed=await resolveRuntimeFamily(options.runtimeRoot,selection,options.arch);
  } catch(error) {
    // A migrated explicit CachyOS choice may predate managed CachyOS. Use the
    // existing strict legacy global CachyOS runner only when no managed CachyOS
    // receipt exists. It is never reported as a managed installation, and a
    // missing CachyOS selection never falls back to Standard.
    if(selection==='nexus-cachyos') {
      const receipt=path.join(options.runtimeRoot,'variants',selection,'current.json');
      const installed=await fs.lstat(receipt).then(stat=>stat.isFile(),()=>false);
      if(!installed) {
        const legacy=await legacyCachyosState(options.runtimeRoot,options.defaultWine??'');
        if(legacy)return Object.freeze({selection,identity:frozenIdentity,gameId:options.gameId,winePath:legacy.winePath,dataRoot:options.dataRoot,...paths});
      }
    }
    throw error;
  }
  return Object.freeze({selection,identity:frozenIdentity,gameId:options.gameId,winePath:managed.winePath,dataRoot:options.dataRoot,managed,...paths});
}

interface PrefixMarker { readonly [key:string]:unknown }
/** Recorded prefix contract. The creating family is deliberately absent, so a
 * family switch neither rewrites nor invalidates an existing marker. */
function expectedMarker(context:Readonly<GameRuntimeContext>):PrefixMarker {
  const managed=context.managed;
  const contract=managed?{prefixSchema:managed.prefixSchema,arch:managed.arch}:{};
  const identity=context.identity;
  if(identity.layout==='game')return {schema:3,layout:'game',gameId:context.gameId,...contract};
  if(identity.layout==='family')return {schema:2,layout:'family',family:identity.family,...contract};
  return {schema:1,family:identity.family,buildId:identity.origin.buildId,sourceCommit:identity.origin.sourceCommit,manifestSha256:identity.origin.manifestSha256,...contract};
}
type MarkerContract={prefixSchema:number;arch:string}|'absent'|'invalid';
function markerContract(marker:Record<string,unknown>):MarkerContract {
  const prefixSchema=marker.prefixSchema,arch=marker.arch;
  if(prefixSchema===undefined&&arch===undefined)return 'absent';
  if(typeof prefixSchema!=='number'||!Number.isInteger(prefixSchema)||prefixSchema<1)return 'invalid';
  if(typeof arch!=='string'||!/^[a-z0-9_]{1,16}$/.test(arch))return 'invalid';
  return {prefixSchema,arch};
}
/**
 * The origin fields of a marker must match exactly. The recorded prefix contract
 * must always be well formed: legacy schema 1 and 2 markers must carry it, while
 * schema 3 may omit it when the prefix was created without a managed payload. A
 * current managed runner is compared against a recorded contract; a default Wine
 * runner validates its shape but does not pretend to verify its values.
 */
function markerMatches(current:unknown,expected:PrefixMarker):boolean {
  const marker=plainObject(current);
  if(!marker||marker.schema!==expected.schema)return false;
  for(const [key,value] of Object.entries(expected)) {
    if(key==='prefixSchema'||key==='arch')continue;
    if(marker[key]!==value)return false;
  }
  for(const key of Object.keys(marker)) if(!(key in expected)&&key!=='prefixSchema'&&key!=='arch')return false;
  const contract=markerContract(marker);
  if(contract==='invalid')return false;
  if(contract==='absent')return expected.schema===3;
  if(expected.prefixSchema===undefined)return true;
  return contract.prefixSchema===expected.prefixSchema&&contract.arch===expected.arch;
}
/** No pfx/wineboot, copying, save migration or default pointer mutation. */
export async function bindRuntimePrefix(context:Readonly<GameRuntimeContext>):Promise<void> {
  const marker=path.join(context.compatibilityDataPath,markerName);
  // Experimental layouts keep the original protection even when a default Wine
  // runner uses them; the canonical per-game prefix keeps its pre-0.5 behaviour.
  if(context.managed||context.identity.layout!=='game') {
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
  const expected=expectedMarker(context);
  const current=await readMarker(context.compatibilityDataPath);
  if(current!==undefined) {
    if(!markerMatches(current,expected))throw Error('Runtime prefix binding mismatch. Existing prefix was preserved.');
    return;
  }
  // A canonical prefix is a pre-0.5 default prefix: preserved unbound, never
  // adopted into another location and never rewritten.
  if(context.identity.layout==='game'&&await prefixPresent(context.compatibilityDataPath))return;
  // An unbound experimental prefix has unknown provenance, never adopt it. This
  // check applies to every runner, including the default Wine one.
  const entries=await fs.readdir(context.compatibilityDataPath).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  if(entries.length)throw Error('Experimental prefix has no runtime binding. Existing files were preserved.');
  // A default Wine runner has no managed contract, so it never invents a marker
  // for an experimental layout; an empty prefix stays unbound for a managed run.
  if(!context.managed)return;
  await fs.mkdir(context.compatibilityDataPath,{recursive:true,mode:0o700});
  await fs.writeFile(marker,JSON.stringify(expected),{flag:'wx',mode:0o600});
}
