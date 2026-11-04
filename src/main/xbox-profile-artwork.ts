import type {XboxProfileGames} from '../shared/types.js';

/**
 * Fill only missing Xbox title-history artwork from a verified resolver.
 * Service artwork always wins, duplicate title IDs are resolved once per
 * snapshot, and an unavailable catalog leaves the existing placeholder instead
 * of failing the player's game history.
 */
export async function withXboxProfileArtwork(
  games:XboxProfileGames,
  resolve:(titleIds:string[])=>Promise<Map<string,string>>,
):Promise<XboxProfileGames>{
  const missing=[...new Set(games.items.filter(game=>!game.imageUrl).map(game=>game.titleId))];
  if(!missing.length)return games;
  try{
    const artwork=await resolve(missing);
    if(!artwork.size)return games;
    const items=games.items.map(game=>game.imageUrl||!artwork.has(game.titleId)?game:{...game,imageUrl:artwork.get(game.titleId)!});
    return items.some((game,index)=>game!==games.items[index])?{...games,items}:games;
  }catch{return games;}
}
