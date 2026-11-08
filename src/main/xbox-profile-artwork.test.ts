import {expect,it,vi} from 'vitest';
import type {XboxProfileGames} from '../shared/types.js';
import {withXboxProfileArtwork} from './xbox-profile-artwork.js';

// Production contract fixture: title history with artwork omitted by the native
// service, exactly as the profile renderer receives it after parsing.
const fixture=(override:Partial<XboxProfileGames>={}):XboxProfileGames=>({
  items:[
    {titleId:'123',name:'Synthetic Game',lastPlayed:'2026-10-23T12:00:00Z',currentGamerscore:10,achievementsUnlocked:1},
    {titleId:'456',name:'Already Illustrated',imageUrl:'https://store-images.s-microsoft.com/image/service-art'},
    {titleId:'123',name:'Synthetic Game Duplicate'},
    {titleId:'789',name:'No Store Product'},
  ],
  continuation:null,truncated:true,...override,
});

it('resolves each missing title ID once and keeps existing service artwork',async()=>{
  const resolve=vi.fn(async(titleIds:string[])=>new Map([[ '123','https://store-images.s-microsoft.com/image/catalog-art' ]]));
  const value=await withXboxProfileArtwork(fixture(),resolve);
  expect(resolve).toHaveBeenCalledOnce();
  expect(resolve).toHaveBeenCalledWith(['123','789']);
  expect(value.items.map(game=>game.imageUrl)).toEqual([
    'https://store-images.s-microsoft.com/image/catalog-art',
    'https://store-images.s-microsoft.com/image/service-art',
    'https://store-images.s-microsoft.com/image/catalog-art',
    undefined,
  ]);
  expect(value.continuation).toBeNull();
  expect(value.truncated).toBe(true);
  expect(value.items[0]).toMatchObject({titleId:'123',name:'Synthetic Game',lastPlayed:'2026-10-23T12:00:00Z',currentGamerscore:10,achievementsUnlocked:1});
});

it('does not resolve or replace anything when every game already has artwork',async()=>{
  const resolve=vi.fn(async()=>new Map());
  const games:XboxProfileGames={items:[{titleId:'1',name:'Illustrated',imageUrl:'https://store-images.s-microsoft.com/image/one'}]};
  expect(await withXboxProfileArtwork(games,resolve)).toBe(games);
  expect(resolve).not.toHaveBeenCalled();
});

it('leaves the history intact when the Store lookup fails or returns an unrequested title',async()=>{
  const games=fixture();
  expect(await withXboxProfileArtwork(games,async()=>{throw Error('offline');})).toBe(games);
  const unrelated=await withXboxProfileArtwork(games,async()=>new Map([['999','https://store-images.s-microsoft.com/image/other']]));
  expect(unrelated).toBe(games);
  expect(games.items.filter(game=>game.imageUrl)).toHaveLength(1);
});
