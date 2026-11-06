import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {expect,it,vi} from 'vitest';
import {gameDetailsTarget} from './game-details-target';
import {catalogDetailMarket,publicStoreMarket} from './public-store-market';

// Execute the actual public catalog IPC handlers. Everything is synthetic: no
// Electron window, account, backend, license, network or game is started.
const source=readFileSync(new URL('./index.ts',import.meta.url),'utf8');
const parsed=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true);

function declarations(names:string[]):string{
 return parsed.statements
  .flatMap(node=>ts.isFunctionDeclaration(node)&&node.name&&names.includes(node.name.text)?[node.getText(parsed)]:[])
  .join('\n');
}
function handlerStatements(names:string[],owner:string):string{
 const fn=parsed.statements.find((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&node.name?.text===owner);
 if(!fn?.body)throw Error(`Missing ${owner}.`);
 const found:ts.Node[]=[];
 for(const statement of fn.body.statements){
  if(!ts.isExpressionStatement(statement)||!ts.isCallExpression(statement.expression))continue;
  const call=statement.expression,callee=call.expression,channel=call.arguments[0];
  if(!ts.isPropertyAccessExpression(callee)||callee.name.text!=='handle'||!ts.isIdentifier(callee.expression)||callee.expression.text!=='ipcMain')continue;
  if(ts.isStringLiteral(channel)&&names.includes(channel.text))found.push(statement);
 }
 const missing=names.filter(name=>!found.some(node=>node.getText(parsed).includes(`'${name}'`)));
 if(missing.length)throw Error(`Missing IPC handlers: ${missing.join(', ')}.`);
 return found.map(node=>node.getText(parsed)).join('\n');
}
const mainNames=['catalog-search','catalog-featured','catalog-browse','catalog-recent-gamepass','game-details','store-access','account-library','install-plan','game-activity','game-achievements'];
const mainCode=ts.transpileModule([declarations(['storeAccess']),handlerStatements(mainNames,'registerIpc')].join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const demoCode=ts.transpileModule(handlerStatements(['catalog-search','catalog-featured','catalog-browse','catalog-recent-gamepass','game-details','store-access'],'registerDemoIpc'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;

function fixture(mode:'main'|'demo'){
 const handlers=new Map<string,Function>(),products={query:'q',market:'US',products:[],hasMore:false,fetchedAt:'',source:'Microsoft Store'};
 // CZ desktop with settings.market 'neutral': the effective account region.
 let market='CZ';
 const catalog={search:vi.fn(async()=>products),featured:vi.fn(async()=>products),browse:vi.fn(async()=>products),gameDetails:vi.fn(async(productId:string)=>({productId,xboxTitleId:'123'}))};
 const homeGamePassShelf={get:vi.fn(async(market:string)=>({market,products:[],fetchedAt:'2026-11-04T10:00:00.000Z',source:'Microsoft Game Pass catalog'}))};
 const games=[{id:'owned-game',storeId:'9GGGGGGGGGGG',title:'Owned Game',path:'/synthetic/game'}];
 const store={games,settings:{market:'neutral'}};
 const accountLibrary={select:vi.fn(),get:vi.fn(async()=>({kind:'owned',products:[],accessByProductId:{}})),storeAccess:vi.fn(async(configuredMarket:string)=>({configuredMarket,account:'fixture',market,checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString(),accessByProductId:{},backend:'/fixture/cli'}))};
 const installPlans={get:vi.fn(async()=>({choices:[]}))};
 const gameActivities={select:vi.fn(),get:vi.fn(async()=>({status:'available'}))},gameAchievements={select:vi.fn(),get:vi.fn(async()=>({status:'available'}))};
 const installedTitleId=vi.fn(async()=> '456');
 const context:any={ipcMain:{handle:(name:string,fn:Function)=>handlers.set(name,fn)},catalog,homeGamePassShelf,currentMarket:()=>market,publicStoreMarket,catalogDetailMarket,gameDetailsTarget,store,accountLibrary,installPlans,
  authState:{running:false,stored:true,username:'fixture',player:undefined},backend:{current:{binaryPath:'/fixture/cli',capabilities:{library:true,packageSelection:true,gameActivity:true,achievements:true}}},
  requireBackend:()=>'/fixture/cli',safeProductId:(value:string)=>value,availableInstallBytes:async()=>1024,
  gameActivities,gameAchievements,installedTitleId,
  snapshot:()=>({settings:{market:'neutral'},auth:{username:'fixture'},backend:{binaryPath:'/fixture/cli'}}),
  catalogMarket:()=>market,demoGames:games,demoArtwork:new Map(),demoAccountLibrary:vi.fn(),demoLocales:{},demoLaunchOptions:{}};
 runInNewContext(mode==='main'?mainCode:demoCode,context);
 return {catalog,homeGamePassShelf,accountLibrary,installPlans,gameActivities,gameAchievements,setMarket:(value:string)=>market=value,call:(name:string,...args:unknown[])=>handlers.get(name)!(undefined,...args)};
}

it('browses the neutral US Store on a CZ desktop while Store access keeps the effective region',async()=>{
 const f=fixture('main');
 await f.call('catalog-search','gears','cursor');
 expect(f.catalog.search).toHaveBeenCalledWith('gears','US','cursor');
 await f.call('catalog-featured');
 expect(f.catalog.featured).toHaveBeenCalledWith('US');
 await f.call('catalog-browse','paid-4');
 expect(f.catalog.browse).toHaveBeenCalledWith('US','paid-4');
 await f.call('catalog-recent-gamepass');
 expect(f.homeGamePassShelf.get).toHaveBeenCalledWith('US');
 // A public shelf never reads or verifies account access.
 expect(f.accountLibrary.storeAccess).not.toHaveBeenCalled();
 expect(f.accountLibrary.select).not.toHaveBeenCalled();
 const access=await f.call('store-access');
 expect(access).toMatchObject({configuredMarket:'neutral',market:'CZ'});
 expect(f.accountLibrary.storeAccess).toHaveBeenCalledWith('neutral');
 expect(f.accountLibrary.select).toHaveBeenCalledWith('fixture','/fixture/cli','CZ');
});

it('uses the public market only for an explicit public Store scope and keeps every other target on the account market',async()=>{
 const f=fixture('main');
 // Public Store card detail: explicit read-only presentation scope.
 await f.call('game-details',{productId:'9PUBLICGAME1',scope:'public-store'});
 expect(f.catalog.gameDetails).toHaveBeenLastCalledWith('9PUBLICGAME1','US');
 // Uninstalled owned/Game Pass Library card: unscoped identity stays account.
 await f.call('game-details',{productId:'9ACCOUNTGAME'});
 expect(f.catalog.gameDetails).toHaveBeenLastCalledWith('9ACCOUNTGAME','CZ');
 // Installed Library identity stays account.
 await f.call('game-details','owned-game');
 expect(f.catalog.gameDetails).toHaveBeenLastCalledWith('9GGGGGGGGGGG','CZ');
 // Malformed or unknown scopes are rejected before any catalog request.
 f.catalog.gameDetails.mockClear();
 for(const value of [{productId:'9PUBLICGAME1',scope:'account'},{productId:'9PUBLICGAME1',scope:'US'},{productId:'9PUBLICGAME1',scope:'public-store',path:'/tmp/x'},{productId:'9PUBLICGAME1',scope:true}])await expect(f.call('game-details',value)).rejects.toThrow();
 expect(f.catalog.gameDetails).not.toHaveBeenCalled();
 // Activity, achievements, install and entitlement never follow a metadata scope.
 await f.call('game-activity',{productId:'9PUBLICGAME1',scope:'public-store'});
 await f.call('game-achievements',{productId:'9PUBLICGAME1',scope:'public-store'});
 expect(f.catalog.gameDetails.mock.calls.slice(-2).map(call=>call[1])).toEqual(['CZ','CZ']);
 expect(f.gameActivities.get).toHaveBeenCalledWith('123',false);
 expect(f.gameAchievements.get).toHaveBeenCalledWith('123',false);
 await f.call('account-library','owned');
 expect(f.accountLibrary.select).toHaveBeenLastCalledWith('fixture','/fixture/cli','CZ');
 await f.call('install-plan','9INSTALLGAME');
 expect(f.installPlans.get).toHaveBeenCalledWith('/fixture/cli','9INSTALLGAME','CZ',false);
});

it('keeps public metadata stable while account operations follow a market change',async()=>{
 const f=fixture('main');
 f.setMarket('DE');
 await f.call('catalog-recent-gamepass');
 expect(f.homeGamePassShelf.get).toHaveBeenCalledWith('US');
 await f.call('game-details',{productId:'9PUBLICGAME1',scope:'public-store'});
 expect(f.catalog.gameDetails).toHaveBeenLastCalledWith('9PUBLICGAME1','US');
 await f.call('game-details',{productId:'9ACCOUNTGAME'});
 expect(f.catalog.gameDetails).toHaveBeenLastCalledWith('9ACCOUNTGAME','DE');
 await f.call('game-activity',{productId:'9PUBLICGAME1',scope:'public-store'});
 expect(f.catalog.gameDetails).toHaveBeenLastCalledWith('9PUBLICGAME1','DE');
 await f.call('install-plan','9INSTALLGAME');
 expect(f.installPlans.get).toHaveBeenCalledWith('/fixture/cli','9INSTALLGAME','DE',false);
 const access=await f.call('store-access');
 expect(access).toMatchObject({configuredMarket:'neutral',market:'DE'});
});

it('demo applies the same scoped policy instead of an all-US catalog',async()=>{
 const f=fixture('demo');
 await f.call('catalog-search','gears','cursor');
 expect(f.catalog.search).toHaveBeenCalledWith('gears','US','cursor');
 await f.call('catalog-featured');
 expect(f.catalog.featured).toHaveBeenCalledWith('US');
 await f.call('catalog-browse');
 expect(f.catalog.browse).toHaveBeenCalledWith('US',undefined);
 await f.call('catalog-recent-gamepass');
 expect(f.homeGamePassShelf.get).toHaveBeenCalledWith('US');
 await f.call('game-details',{productId:'9PUBLICGAME1',scope:'public-store'});
 expect(f.catalog.gameDetails).toHaveBeenLastCalledWith('9PUBLICGAME1','US');
 await f.call('game-details',{productId:'9ACCOUNTGAME'});
 expect(f.catalog.gameDetails).toHaveBeenLastCalledWith('9ACCOUNTGAME','CZ');
 await f.call('game-details','owned-game');
 expect(f.catalog.gameDetails).toHaveBeenLastCalledWith('9GGGGGGGGGGG','CZ');
 const access=await f.call('store-access');
 expect(access).toMatchObject({configuredMarket:'neutral',market:'CZ'});
});
