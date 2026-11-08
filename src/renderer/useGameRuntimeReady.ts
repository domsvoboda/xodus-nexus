import {useEffect,useRef,useState} from 'react';
import type {AppSnapshot,Game} from '../shared/types';
import {activeRuntimeIsCachyos} from '../shared/runtime-display';
/** Visible-game readiness follows the verified installed family current. Pending
 * and errors never borrow another build's availability. */
export function useGameRuntimeReady(game:Game|undefined,data:AppSnapshot):boolean {
  const managed=Boolean(game?.runtime&&game.runtime!=='default');
  const scope=JSON.stringify([game?.id,game?.runtime,game?.runtimePrefixIdentity,game?.runtimeSeparatePrefix,game?.runtimeBuild?.buildId,game?.runtimeBuild?.manifestSha256,game?.runtimeBuild?.sourceCommit,game?.runtimePrefixes,data.settings.runtimeRoot,data.settings.winePath,data.runtime.winePath,data.runtime.managedRevision,(data.runtime.variants??[]).map(item=>[item.id,item.buildId,item.manifestSha256,item.sourceCommit])]);
  const current=useRef({scope,version:0});
  if(current.current.scope!==scope)current.current={scope,version:current.current.version+1};
  const version=current.current.version;
  const epoch=useRef(0);
  const [result,setResult]=useState<{scope:string;version:number;ready:boolean}>();
  useEffect(()=>{
    const generation=++epoch.current;
    if(!game||!managed)return;
    let active=true;
    void Promise.resolve().then(()=>window.launcher.getGameRuntimeReadiness(game.id)).then(ready=>{
      if(active&&current.current.scope===scope&&current.current.version===version&&epoch.current===generation)setResult({scope,version,ready:ready===true});
    }).catch(()=>{if(active&&current.current.scope===scope&&current.current.version===version&&epoch.current===generation)setResult({scope,version,ready:false});});
    return()=>{active=false;epoch.current++;};
  },[scope,version,managed]);
  if(!game)return false;
  if(!managed) {
    const families=data.runtime.managedFamilies??[];
    // Prefer an installed managed Standard. If any other managed family exists
    // (CachyOS only), a default game is not ready, even when a legacy Standard
    // or custom Wine path is still present; the backend resolver requires
    // Standard in that combined state.
    if(families.some(item=>item.id==='nexus'&&Boolean(item.installed)))return true;
    if(families.some(item=>Boolean(item.installed)))return false;
    const legacyCachy=activeRuntimeIsCachyos(data.runtime)||/nexus-runtime-cachyos-/.test(data.settings.winePath);
    return Boolean(!legacyCachy&&(data.settings.winePath||data.runtime.winePath));
  }
  return result?.scope===scope&&result.version===version&&result.ready===true;
}
