import type {Game} from '../shared/types.js';
import {resolveGameRuntime} from './runtime-prefix-binding.js';
export interface RuntimeReadinessState {
  game?:Pick<Game,'id'|'runtime'|'runtimeSeparatePrefix'|'runtimeBuild'>;
  runtimeRoot:string;dataRoot:string;defaultWine:string|undefined;arch?:string;
}
function identity(state:RuntimeReadinessState):string {
  const game=state.game;
  return JSON.stringify([game?.id,game?.runtime,game?.runtimeSeparatePrefix,game?.runtimeBuild?.buildId,game?.runtimeBuild?.manifestSha256,game?.runtimeBuild?.sourceCommit,state.runtimeRoot,state.dataRoot,state.defaultWine,state.arch]);
}
/** Read-only readiness hint. No prefix binding, runtime execution or account
 * queries. Actual launch independently resolves and verifies its captured build. */
export async function gameRuntimeReadiness(read:()=>RuntimeReadinessState,resolve=resolveGameRuntime):Promise<boolean> {
  try {
    const state=structuredClone(read()),before=identity(state);
    if(!state.game)return false;
    await resolve({runtimeRoot:state.runtimeRoot,dataRoot:state.dataRoot,gameId:state.game.id,selection:state.game.runtime,separatePrefix:state.game.runtimeSeparatePrefix,approvedBuild:state.game.runtimeBuild,defaultWine:state.defaultWine,arch:state.arch});
    return before===identity(read());
  }catch{return false;}
}
