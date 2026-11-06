import type {Game} from '../shared/types.js';
import {gameRuntimeSelection,runtimePrefixAnchors,runtimeBuildApproval} from '../shared/runtime-selection.js';
import {resolveRuntimeFamily} from './runtime-families.js';
import {captureGamePrefixIdentity} from './runtime-prefix-binding.js';
/** `runtimeSeparatePrefix` is accepted for compatibility with older callers and
 * stored state, but it never gates a family choice or a prefix location. */
export type RuntimeSettingsRequest=Partial<Pick<Game,'runtime'|'runtimeSeparatePrefix'>>;
/** Component roots exactly as the launcher resolves them: the prefix store is
 * the data root, and managed families live under its runtime root. */
export interface RuntimeSettingsPaths { runtimeRoot:string; dataRoot:string }
/**
 * Capture the durable prefix identity of the state that exists before the
 * change, then persist it atomically with the new selection. The chosen family
 * only selects the runtime runner; it never selects the prefix or the saves.
 * An ambiguous prefix history fails here, before anything is persisted.
 */
export async function approvedRuntimeSettings(current:Game,request:RuntimeSettingsRequest,paths:RuntimeSettingsPaths,resolve=resolveRuntimeFamily):Promise<Partial<Game>> {
  const selection=gameRuntimeSelection('runtime' in request?request.runtime:current.runtime);
  const separate='runtimeSeparatePrefix' in request?request.runtimeSeparatePrefix:current.runtimeSeparatePrefix;
  if(separate!==undefined&&typeof separate!=='boolean')throw Error('Invalid runtime prefix choice.');
  const previous=gameRuntimeSelection(current.runtime);
  const anchors=runtimePrefixAnchors(current.runtimePrefixes);
  // Keep the pre-0.5 build origin as backward-compatible path metadata.
  if(previous!=='default'&&!anchors[previous]&&current.runtimeBuild)anchors[previous]={layout:'build',origin:runtimeBuildApproval(current.runtimeBuild)};
  const identity=await captureGamePrefixIdentity({dataRoot:paths.dataRoot,gameId:current.id,game:current});
  // A new family must still be a verified installed build before it is persisted.
  if(selection!=='default'&&selection!==previous)await resolve(paths.runtimeRoot,selection);
  return {runtime:selection,runtimePrefixes:anchors,runtimePrefixIdentity:identity,runtimeBuild:undefined};
}
/** Fields whose values decide which prefix and saves a game uses. */
export function runtimeIdentityScope(game:Partial<Game>):string {
  return JSON.stringify([game.runtime,game.runtimePrefixIdentity,game.runtimeBuild,game.runtimePrefixes,game.runtimeSeparatePrefix]);
}
/** A held activity reservation: verifies idle again as the owner and releases. */
export interface RuntimeSettingsAdmission { admit:()=>void; release:()=>void }
/**
 * Persist a runtime change as one admitted mutation.
 *
 * A real family change reserves the process activity slot before the first
 * asynchronous step and keeps it through the persisted write, so a launch or a
 * component update cannot enter at any await in between. The rerun of the
 * admission is only an assertion that our own reservation is still valid; it is
 * not the lock. The persisted record is checked as well, so a change that
 * happened before the reservation cannot be overwritten.
 */
export async function guardedRuntimeSettings(options:{
  current:Game;request:RuntimeSettingsRequest;paths:RuntimeSettingsPaths;changing:boolean;
  reserve:()=>RuntimeSettingsAdmission;read:()=>Game|undefined;
  persist:(patch:Partial<Game>)=>Promise<Game>;
  approve?:(current:Game,request:RuntimeSettingsRequest,paths:RuntimeSettingsPaths)=>Promise<Partial<Game>>;
}):Promise<Game> {
  const approve=options.approve??((current,request,paths)=>approvedRuntimeSettings(current,request,paths));
  const write=async(approved:Partial<Game>):Promise<Game>=>{
    const latest=options.read();
    if(!latest||runtimeIdentityScope(latest)!==runtimeIdentityScope(options.current))throw Error('The game runtime selection changed. Try again.');
    return options.persist(approved);
  };
  // An unchanged runtime still persists the captured identity, and it must not
  // block an unrelated running game.
  if(!options.changing)return write(await approve(options.current,options.request,options.paths));
  const admission=options.reserve();
  try {
    const approved=await approve(options.current,options.request,options.paths);
    admission.admit();
    return await write(approved);
  } finally { admission.release(); }
}
