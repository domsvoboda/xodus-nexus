import type {Game} from '../shared/types.js';
import {gameRuntimeSelection,runtimeBuildApproval,sameRuntimeBuild,type RuntimeBuildApproval} from '../shared/runtime-selection.js';
import {resolveRuntimeFamily} from './runtime-families.js';
export type RuntimeSettingsRequest=Partial<Pick<Game,'runtime'|'runtimeSeparatePrefix'>> & {runtimeApproveBuild?:boolean;runtimeExpectedBuild?:RuntimeBuildApproval};
/** Explicit compare-and-set. Expected hashes are only a stale-form precondition;
 * persist exclusively the once-resolved, verified server descriptor. */
export async function approvedRuntimeSettings(current:Game,request:RuntimeSettingsRequest,runtimeRoot:string,resolve=resolveRuntimeFamily):Promise<Partial<Game>> {
  const selection=gameRuntimeSelection('runtime' in request?request.runtime:current.runtime);
  const separate='runtimeSeparatePrefix' in request?request.runtimeSeparatePrefix:current.runtimeSeparatePrefix;
  if(separate!==undefined&&typeof separate!=='boolean')throw Error('Invalid runtime prefix choice.');
  if(request.runtimeApproveBuild!==undefined&&typeof request.runtimeApproveBuild!=='boolean')throw Error('Invalid explicit runtime build approval.');
  if(selection==='default')return {runtime:selection,runtimeSeparatePrefix:false,runtimeBuild:undefined};
  if(separate!==true)throw Error('Explicit separate prefix choice is required. Existing local saves remain in the old prefix.');
  if(selection===current.runtime&&request.runtimeApproveBuild!==true) {
    // Ordinary title/locale Save never refreshes a prior build's permission.
    return {runtime:selection,runtimeSeparatePrefix:true,runtimeBuild:runtimeBuildApproval(current.runtimeBuild)};
  }
  if(request.runtimeApproveBuild!==true)throw Error('Fresh explicit approval of the installed runtime build is required.');
  const verified=await resolve(runtimeRoot,selection);
  if(!sameRuntimeBuild(request.runtimeExpectedBuild,verified))throw Error('The installed runtime build changed while settings were open. Review it and approve a new separate prefix again.');
  return {runtime:selection,runtimeSeparatePrefix:true,runtimeBuild:runtimeBuildApproval(verified)};
}
