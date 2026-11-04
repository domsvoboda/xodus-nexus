import { expect,it,vi } from 'vitest';
import { XboxSocial } from './xbox-native-social.js';
import { readXboxProfileGames } from './xbox-profile-games.js';

const response=(items:unknown[])=>JSON.stringify({schema:1,account:'account',kind:'people',operation:'games',result:{items,continuation:null,truncated:false}});
const game={titleId:'123',name:'Synthetic Game'};
const artwork='https://store-images.s-microsoft.com/image/catalog-art';

function deferred<T>(){
  let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;
  const promise=new Promise<T>((resolveValue,rejectValue)=>{resolve=resolveValue;reject=rejectValue;});
  return {promise,resolve,reject};
}

it('returns title history artwork on the captured identity',async()=>{
  const reader=vi.fn(async()=>response([game]));
  const api=new XboxSocial(()=>({binary:'xodus-cli',account:'account'}),reader);
  const result=await readXboxProfileGames(api,'2',async()=>new Map([['123',artwork]]));
  expect(result.items).toEqual([{titleId:'123',name:'Synthetic Game',imageUrl:artwork}]);
  expect(reader).toHaveBeenCalledOnce();
});

it('rejects stale history when the account changes while optional artwork is pending',async()=>{
  let account='account';
  const reader=vi.fn(async()=>response([game]));
  const api=new XboxSocial(()=>({binary:'xodus-cli',account}),reader);
  const art=deferred<Map<string,string>>();
  let reachedResolve!:()=>void;const reached=new Promise<void>(resolve=>{reachedResolve=resolve;});
  const pending=readXboxProfileGames(api,'2',()=>{reachedResolve();return art.promise;});
  await reached;
  account='other';
  api.clear();
  art.resolve(new Map([['123',artwork]]));
  await expect(pending).rejects.toThrow('Xbox account changed');
});

it('rejects stale history when the connected account changes without a clear',async()=>{
  let account='account';
  const api=new XboxSocial(()=>({binary:'xodus-cli',account}),async()=>response([game]));
  const art=deferred<Map<string,string>>();
  let reachedResolve!:()=>void;const reached=new Promise<void>(resolve=>{reachedResolve=resolve;});
  const pending=readXboxProfileGames(api,'2',()=>{reachedResolve();return art.promise;});
  await reached;
  account='other';
  art.resolve(new Map([['123',artwork]]));
  await expect(pending).rejects.toThrow('Xbox account changed');
});

it('rejects the previous history when the same identity reconnects while artwork is pending',async()=>{
  const reader=vi.fn(async()=>response([game]));
  const api=new XboxSocial(()=>({binary:'xodus-cli',account:'account'}),reader);
  const art=deferred<Map<string,string>>();
  let reachedResolve!:()=>void;const reached=new Promise<void>(resolve=>{reachedResolve=resolve;});
  const pending=readXboxProfileGames(api,'2',()=>{reachedResolve();return art.promise;});
  await reached;
  api.clear();
  art.resolve(new Map([['123',artwork]]));
  await expect(pending).rejects.toThrow('Xbox account changed');
});

it('does not hide an account change when the optional artwork lookup fails',async()=>{
  let account='account';
  const api=new XboxSocial(()=>({binary:'xodus-cli',account}),async()=>response([game]));
  const art=deferred<Map<string,string>>();
  let reachedResolve!:()=>void;const reached=new Promise<void>(resolve=>{reachedResolve=resolve;});
  const pending=readXboxProfileGames(api,'2',()=>{reachedResolve();return art.promise;});
  await reached;
  account='other';
  api.clear();
  art.reject(Error('offline'));
  await expect(pending).rejects.toThrow('Xbox account changed');
});

it('cancels before the native read when the captured context is already invalid',async()=>{
  const games=vi.fn(async()=>({items:[]}));
  const source={context:()=>({account:'account',binary:'xodus-cli',revision:0}),matches:()=>false,games};
  await expect(readXboxProfileGames(source,'2',async()=>new Map())).rejects.toThrow('Xbox account changed');
  expect(games).not.toHaveBeenCalled();
});

it('rejects a service call whose explicit context was already cleared',async()=>{
  const reader=vi.fn(async()=>response([game]));
  const api=new XboxSocial(()=>({binary:'xodus-cli',account:'account'}),reader);
  const context=api.context()!;
  await expect(api.games('2',{...context,revision:context.revision+1})).rejects.toThrow('Xbox account changed');
  expect(reader).not.toHaveBeenCalled();
});

it('requires an active store or player identity before reading history',async()=>{
  const games=vi.fn(async()=>({items:[]}));
  await expect(readXboxProfileGames({context:()=>undefined,matches:()=>true,games},'2',async()=>new Map())).rejects.toThrow('Sign in');
  expect(games).not.toHaveBeenCalled();
});
