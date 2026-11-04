import type {Settings} from '../shared/types';

export type StorageSettingsPatch = Pick<Settings,'installRoot'|'market'|'parallelDownloads'|'runtimeRoot'|'winePath'>;

/** Save only the visible storage fields. The hidden legacy external Xodus root
 * and unrelated preferences are never re-applied from a stale form. */
export function storageSettingsPatch(settings: Settings): StorageSettingsPatch {
 return {
  installRoot: settings.installRoot,
  market: settings.market,
  parallelDownloads: settings.parallelDownloads,
  runtimeRoot: settings.runtimeRoot,
  winePath: settings.winePath,
 };
}

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
