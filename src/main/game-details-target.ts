import type {Game} from '../shared/types.js';

/** Catalog details are read-only and never insert an installation or accept a path. */
export function gameDetailsTarget(value:unknown,games:Game[]):{game?:Game;productId?:string} {
 if(typeof value==='string'){
  const game=games.find(game=>game.id===value);
  if(!game)throw Error('Game not found.');
  return {game,productId:game.storeId&&/^[A-Z0-9]{12}$/.test(game.storeId)?game.storeId:undefined};
 }
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1
  ||!('productId' in value)||typeof value.productId!=='string'||!/^[A-Z0-9]{12}$/.test(value.productId))throw Error('Invalid game details request.');
 return {productId:value.productId};
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
