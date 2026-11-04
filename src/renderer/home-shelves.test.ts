import {expect,it} from 'vitest';
import type {DownloadTask,Game} from '../shared/types';
import {recentlyInstalledGames} from './home-shelves';

const game=(id:string,addedAt:string,installState:Game['installState']='ready',installedAt?:string,storeId?:string):Game=>
 ({id,title:id,path:`/${id}`,installState,addedAt,...(installedAt?{installedAt}:{}),...(storeId?{storeId}:{})});
const download=(patch:Partial<DownloadTask>):DownloadTask=>({id:'task',title:'Task',productId:'9AAAAAAAAAAA',destination:'/games',status:'running',progress:null,phase:'',log:[],startedAt:'',...patch});

it('keeps complete and imported local games but hides incomplete installations and active downloads',()=>{
 const games=[game('ready','2025-01-01'),game('imported','2025-01-02','imported'),game('incomplete','2025-01-03','incomplete'),
  game('updating','2025-01-04','ready',undefined,'9BBBBBBBBBBB')];
 const downloads=[download({gameId:'ready'}),download({productId:'9bbbbbbbbbbb'}),
  download({kind:'content',gameId:'imported',productId:'9CCCCCCCCCCC'})];
 expect(recentlyInstalledGames(games,downloads).map(item=>item.id)).toEqual(['imported']);
});

it('prefers the recorded installation time and falls back to saved order without inventing dates',()=>{
 const games=[game('legacy-old','2025-01-01'),game('newer','2025-01-02',undefined, '2026-02-01T00:00:00.000Z'),
  game('legacy-new','2025-01-03'),game('invalid','2025-01-04','ready','not a date'),game('missing','')];
 const result=recentlyInstalledGames(games);
 expect(result.map(item=>item.id)).toEqual(['newer','invalid','legacy-new','legacy-old','missing']);
 expect(result.find(item=>item.id==='legacy-new')?.installedAt).toBeUndefined();
 expect(result.find(item=>item.id==='missing')?.installedAt).toBeUndefined();
});

it('keeps the saved order on equal timestamps and never mutates the library',()=>{
 const games=[game('first','2026-01-01T00:00:00.000Z'),game('second','2026-01-01T00:00:00.000Z'),game('third','2026-01-01T00:00:00.000Z')];
 const before=games.map(item=>item.id);
 expect(recentlyInstalledGames(games).map(item=>item.id)).toEqual(['first','second','third']);
 expect(games.map(item=>item.id)).toEqual(before);
});
