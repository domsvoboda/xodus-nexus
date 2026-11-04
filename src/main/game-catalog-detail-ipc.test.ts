import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {expect,it,vi} from 'vitest';
import {demoSnapshot} from '../shared/demo-data';
import {gameDetailsTarget} from './game-details-target';
import {catalogDetailMarket} from './public-store-market';
const source=readFileSync(new URL('./index.ts',import.meta.url),'utf8');
const start=source.indexOf("  ipcMain.handle('game-details'",source.indexOf('function registerIpc():'));
const code=ts.transpileModule(source.slice(start,source.indexOf("  ipcMain.handle('launch-game'",start)),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function fixture(){
 const handlers=new Map<string,Function>(),games=demoSnapshot().games;
 const authState={stored:true,running:false,username:'fixture-account',player:undefined as string|undefined},backend={current:{binaryPath:'/fixture/cli',capabilities:{gameActivity:true,achievements:true}}};
 let market='US';const catalog={gameDetails:vi.fn(async()=>({productId:'9AAAAAAAAAAA',xboxTitleId:'123'} as {productId:string;xboxTitleId?:string}))};
 const gameActivities={select:vi.fn(),get:vi.fn(async()=>({status:'available',minutesPlayed:42}))},gameAchievements={select:vi.fn(),get:vi.fn(async()=>({status:'available',items:[]}))};
 const installedTitleId=vi.fn(async()=> '456');
 runInNewContext(code,{ipcMain:{handle:(name:string,fn:Function)=>handlers.set(name,fn)},store:{games},catalog,currentMarket:()=>market,catalogDetailMarket,authState,backend,gameActivities,gameAchievements,gameDetailsTarget,installedTitleId});
 return {games,authState,backend,catalog,gameActivities,gameAchievements,installedTitleId,setMarket:(value:string)=>market=value,call:(name:string,...args:unknown[])=>handlers.get(name)!(undefined,...args)};
}
it('reads catalog details/activity/achievements without installation, file access or guessed title IDs',async()=>{
 const f=fixture(),before=structuredClone(f.games),target={productId:'9AAAAAAAAAAA'};
 expect(await f.call('game-details',target)).toMatchObject({productId:target.productId});
 expect(await f.call('game-activity',target,true)).toMatchObject({status:'available',minutesPlayed:42});
 expect(await f.call('game-achievements',target,false)).toMatchObject({status:'available'});
 expect(f.gameActivities.get).toHaveBeenCalledWith('123',true);expect(f.gameAchievements.get).toHaveBeenCalledWith('123',false);
 expect(f.installedTitleId).not.toHaveBeenCalled();expect(f.games).toEqual(before);
 await f.call('game-activity',f.games[0].id);expect(f.installedTitleId).toHaveBeenCalledWith(f.games[0].path);expect(f.gameActivities.get).toHaveBeenLastCalledWith('456',false);
});
it.each(['game-activity','game-achievements'])('%s retains sign-in/support requirements and honest missing/error states',async route=>{
 const f=fixture(),target={productId:'9AAAAAAAAAAA'};
 f.authState.stored=false;expect(await f.call(route,target)).toEqual({status:'signed-out'});expect(f.catalog.gameDetails).not.toHaveBeenCalled();
 f.authState.stored=true;f.backend.current.binaryPath='';expect(await f.call(route,target)).toEqual({status:'unsupported'});
 f.backend.current.binaryPath='/fixture/cli';f.catalog.gameDetails.mockResolvedValueOnce({productId:target.productId});expect(await f.call(route,target)).toEqual({status:'unavailable'});
 f.catalog.gameDetails.mockRejectedValueOnce(Error('Unavailable'));expect(await f.call(route,target)).toEqual({status:'error'});
 expect(f.gameActivities.get).not.toHaveBeenCalled();expect(f.gameAchievements.get).not.toHaveBeenCalled();
 await expect(f.call(route,{...target,titleId:'999'})).rejects.toThrow();await expect(f.call(route,target,'true')).rejects.toThrow();
});
it.each(['game-activity','game-achievements'])('%s rejects late catalog lookup after account, backend or market changes',async route=>{
 for(const change of ['account','backend','market']){
  const f=fixture();let resolve!:(value:{productId:string;xboxTitleId:string})=>void;
  f.catalog.gameDetails.mockReturnValueOnce(new Promise(done=>resolve=done));
  const pending=f.call(route,{productId:'9AAAAAAAAAAA'});
  if(change==='account')f.authState.username='other';else if(change==='backend')f.backend.current.binaryPath='/other/cli';else f.setMarket('CZ');
  resolve({productId:'9AAAAAAAAAAA',xboxTitleId:'123'});expect(await pending).toEqual({status:'error'});
  expect(f.gameActivities.get).not.toHaveBeenCalled();expect(f.gameAchievements.get).not.toHaveBeenCalled();
 }
});
it('keeps explicit public Store metadata on the public market and Library details on the account market',async()=>{
 const f=fixture();
 // Only an explicit public Store scope selects public browse metadata, and a
 // later account-market change neither alters nor invalidates it.
 let resolvePublic!:(value:{productId:string})=>void;
 f.catalog.gameDetails.mockReturnValueOnce(new Promise(done=>resolvePublic=done));
 const pendingPublic=f.call('game-details',{productId:'9AAAAAAAAAAA',scope:'public-store'});
 f.setMarket('CZ');resolvePublic({productId:'9AAAAAAAAAAA'});
 await expect(pendingPublic).resolves.toMatchObject({productId:'9AAAAAAAAAAA'});
 expect(f.catalog.gameDetails).toHaveBeenLastCalledWith('9AAAAAAAAAAA','US');
 // An unscoped product, which is what an uninstalled owned/Game Pass Library
 // card passes, keeps the account market and still rejects late metadata.
 f.setMarket('CZ');
 let resolveLibrary!:(value:{productId:string})=>void;
 f.catalog.gameDetails.mockReturnValueOnce(new Promise(done=>resolveLibrary=done));
 const pendingLibrary=f.call('game-details',{productId:'9AAAAAAAAAAA'});
 f.setMarket('US');resolveLibrary({productId:'9AAAAAAAAAAA'});
 await expect(pendingLibrary).rejects.toThrow('market changed');
 expect(f.catalog.gameDetails).toHaveBeenLastCalledWith('9AAAAAAAAAAA','CZ');
 // An installed Library identity keeps the account market as well.
 f.setMarket('CZ');
 let resolveOwned!:(value:{productId:string})=>void;
 f.catalog.gameDetails.mockReturnValueOnce(new Promise(done=>resolveOwned=done));
 const pendingOwned=f.call('game-details',f.games[0].id);
 f.setMarket('DE');resolveOwned({productId:f.games[0].storeId!});
 await expect(pendingOwned).rejects.toThrow('market changed');
 expect(f.catalog.gameDetails).toHaveBeenLastCalledWith(f.games[0].storeId,'CZ');
});

it.each(['game-activity','game-achievements'])('%s uses the player identity and rejects a late player switch',async route=>{
 const f=fixture();f.authState.player='personal-player';
 await f.call(route,{productId:'9AAAAAAAAAAA'});
 const selected=route==='game-activity'?f.gameActivities:f.gameAchievements;
 expect(selected.select).toHaveBeenCalledWith('personal-player','/fixture/cli');
 let resolve!:(value:{productId:string;xboxTitleId:string})=>void;
 f.catalog.gameDetails.mockReturnValueOnce(new Promise(done=>resolve=done));
 const pending=f.call(route,{productId:'9AAAAAAAAAAA'});
 f.authState.player='other-player';resolve({productId:'9AAAAAAAAAAA',xboxTitleId:'123'});
 expect(await pending).toEqual({status:'error'});
});

it.each(['game-activity','game-achievements'])('%s supports an independent player after Store sign-out',async route=>{
 const f=fixture();f.authState.stored=false;f.authState.username='';f.authState.player='personal-player';
 expect(await f.call(route,{productId:'9AAAAAAAAAAA'})).toMatchObject({status:'available'});
 const selected=route==='game-activity'?f.gameActivities:f.gameAchievements;
 expect(selected.select).toHaveBeenCalledWith('personal-player','/fixture/cli');
});
