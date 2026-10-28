import type {AppSnapshot,LauncherApi} from '../shared/types';

/** Subscribe before the initial read so a late result cannot restore a previous account. */
export function watchChatDesktop(api:Pick<LauncherApi,'onSnapshot'|'getSnapshot'>,changed:(snapshot:AppSnapshot)=>void,failed:()=>void):()=>void{
  let alive=true,updated=false;
  const unsubscribe=api.onSnapshot(value=>{if(alive){updated=true;changed(value);}});
  void api.getSnapshot().then(value=>{if(alive&&!updated)changed(value);},()=>{if(alive&&!updated)failed();});
  return()=>{alive=false;unsubscribe();};
}
