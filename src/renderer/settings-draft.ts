import type {Settings} from '../shared/types';

/** Snapshots clone settings even when only operation or shortcut status changed. */
export function reconcileSettingsDraft(draft:Settings,previous:Settings,next:Settings):Settings {
 let result=draft;
 const keys=new Set([...Object.keys(previous),...Object.keys(next)] as (keyof Settings)[]);
 for(const key of keys){
  if(Object.is(previous[key],next[key]))continue;
  if(result===draft)result={...draft};
  if(Object.prototype.hasOwnProperty.call(next,key))Object.assign(result,{[key]:next[key]});
  else delete result[key];
 }
 return result;
}
