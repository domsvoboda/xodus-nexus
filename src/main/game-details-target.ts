import type {Game,GameDetailsScope} from '../shared/types.js';

/** A resolved read-only detail request. `scope` is presentation only and never
 * an ownership, license or installation decision. */
export interface GameDetailsRequest {game?:Game;productId?:string;scope?:GameDetailsScope}

/** Catalog details are read-only and never insert an installation or accept a path.
 * A saved game ID stays on the account market. An explicit product identity also
 * stays on the account market unless it carries the allowlisted public scope. */
export function gameDetailsTarget(value:unknown,games:Game[]):GameDetailsRequest {
 if(typeof value==='string'){
  const game=games.find(game=>game.id===value);
  if(!game)throw Error('Game not found.');
  return {game,productId:game.storeId&&/^[A-Z0-9]{12}$/.test(game.storeId)?game.storeId:undefined};
 }
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid game details request.');
 const record=value as Record<string,unknown>,keys=Object.keys(record);
 if(keys.some(key=>key!=='productId'&&key!=='scope'))throw Error('Invalid game details request.');
 if(typeof record.productId!=='string'||!/^[A-Z0-9]{12}$/.test(record.productId))throw Error('Invalid game details request.');
 if('scope' in record&&record.scope!=='public-store')throw Error('Invalid game details scope.');
 return record.scope==='public-store'?{productId:record.productId,scope:'public-store'}:{productId:record.productId};
}

/** Display Catalog AlternateIds is authoritative; ambiguity is not a title match. */
export function catalogXboxTitleId(value:unknown):string|undefined {
 if(!Array.isArray(value)||value.length>100)return;
 const titles=new Set<string>();
 for(const row of value){
  if(!row||typeof row!=='object'||row.IdType!=='XboxTitleId')continue;
  if(typeof row.Value!=='string'||!/^\d{1,10}$/.test(row.Value)||Number(row.Value)<1||Number(row.Value)>0xffffffff)return;
  titles.add(String(Number(row.Value)));
 }
 return titles.size===1?[...titles][0]:undefined;
}
