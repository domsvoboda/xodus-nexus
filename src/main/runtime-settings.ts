import type {Game} from '../shared/types.js';
import {gameRuntimeSelection,runtimePrefixAnchors,runtimeBuildApproval} from '../shared/runtime-selection.js';
import {resolveRuntimeFamily} from './runtime-families.js';
export type RuntimeSettingsRequest=Partial<Pick<Game,'runtime'|'runtimeSeparatePrefix'>>;
export async function approvedRuntimeSettings(current:Game,request:RuntimeSettingsRequest,runtimeRoot:string,resolve=resolveRuntimeFamily):Promise<Partial<Game>> {
  const selection=gameRuntimeSelection('runtime' in request?request.runtime:current.runtime);
  const separate='runtimeSeparatePrefix' in request?request.runtimeSeparatePrefix:current.runtimeSeparatePrefix;
  if(separate!==undefined&&typeof separate!=='boolean')throw Error('Invalid runtime prefix choice.');
  const anchors=runtimePrefixAnchors(current.runtimePrefixes);
  const previous=gameRuntimeSelection(current.runtime);
  if(previous!=='default'&&!anchors[previous]&&current.runtimeBuild)anchors[previous]={layout:'build',origin:runtimeBuildApproval(current.runtimeBuild)};
  if(selection==='default')return {runtime:selection,runtimeSeparatePrefix:false,runtimeBuild:undefined,runtimePrefixes:anchors};
  if(selection!==previous&&!anchors[selection]&&request.runtimeSeparatePrefix!==true)throw Error('Explicit separate prefix choice is required for a new runtime family.');
  if(separate!==true)throw Error('Explicit separate prefix choice is required. Existing local saves remain in the old prefix.');
  if(selection!==previous||current.runtimeSeparatePrefix!==true)await resolve(runtimeRoot,selection);
  anchors[selection]??={layout:'family'};
  return {runtime:selection,runtimeSeparatePrefix:true,runtimeBuild:undefined,runtimePrefixes:anchors};
}
