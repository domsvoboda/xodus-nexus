import {describe,expect,it,vi} from 'vitest';
import {XboxSocial} from './xbox-native-social.js';

const person={xuid:'2',gamertag:'Player',online:false,presence:'Offline',favorite:false,inParty:false};
const relationship={xuid:'2',isFriend:false,isFollowing:false,isFollower:false,favorite:false,blocked:false,requestState:'none'};
const reply=(operation:string,result:unknown,account='account')=>JSON.stringify({schema:1,account,kind:'people',operation,result});
const connect=()=>({binary:'xodus-cli',account:'account'});

describe('Xbox people service boundary',()=>{
 it('sends bounded searches through private stdin and projects public player fields only',async()=>{
  const reader=vi.fn(async()=>reply('search',{items:[{...person,reason:'Suggested by Xbox',authorization:'secret'}],continuation:null,truncated:true}));
  const api=new XboxSocial(connect,reader);
  await expect(api.people('search','x')).rejects.toThrow('two characters');
  await expect(api.people('search','ok\u0000')).rejects.toThrow();
  expect(reader).not.toHaveBeenCalled();
  expect(await api.people('search','  Player  ')).toEqual({items:[{...person,reason:'Suggested by Xbox'}],continuation:null,truncated:true});
  expect(reader.mock.calls[0].slice(0,3)).toEqual(['xodus-cli',['people'],JSON.stringify({account:'account',operation:'search',query:'Player'})]);
 });
 it('rejects wrong account/operation, malformed people and unbounded results',async()=>{
  for(const output of [reply('recent',{items:[]},'other'),reply('search',{items:[]}),reply('recent',{items:[{...person,xuid:'../me'}]}),reply('recent',{items:Array(101).fill(person)}),reply('recent',{items:[],truncated:'yes'})]){
   const api=new XboxSocial(connect,async()=>output);await expect(api.people('recent')).rejects.toThrow();
  }
 });
 it('projects expanded details and rejects injected URLs, invalid colors and different relationships',async()=>{
  const details={xuid:'2',gamertag:'Player',gamerscore:'100',isSelf:false,bio:'Hello\nXbox',location:'Toronto',tenure:'3',colors:{primary:'#123abc'},counts:{friends:0,followers:2},relationship};
  const api=new XboxSocial(connect,async()=>reply('profile',{...details,token:'private',realName:'private'}));
  expect(await api.details('2')).toEqual(details);
  for(const invalid of [{...details,avatarUrl:'https://example.test/private'},{...details,colors:{primary:'url(https://example.test)'}},{...details,counts:{friends:-1}},{...details,relationship:{...relationship,xuid:'3'}}]){
   await expect(new XboxSocial(connect,async()=>reply('profile',invalid)).details('2')).rejects.toThrow();
  }
 });
 it('does not publish old-account results after a switch or reset',async()=>{
  let account='account',finish!:(value:string)=>void;
  const api=new XboxSocial(()=>({binary:'xodus-cli',account}),()=>new Promise(resolve=>{finish=resolve;}));
  const first=api.people('suggested');account='other';finish(reply('suggested',{items:[person]}));await expect(first).rejects.toThrow('account changed');
  account='account';const second=api.relationship('2');api.clear();finish(reply('relationship',relationship));await expect(second).rejects.toThrow();
 });
 it('checks the selected player and action before a single mutation and invalidates cached state',async()=>{
  let state=relationship;
  const reader=vi.fn(async(_binary:string,_args:string[],input:string|undefined)=>{
   const value=JSON.parse(input!);if(value.operation==='relationship')return reply('relationship',state);
   state={...relationship,requestState:'outgoing'};return reply('send-request',{xuid:'2',success:true,token:'private'});
  });
  const api=new XboxSocial(connect,reader);expect((await api.relationship('2')).requestState).toBe('none');
  await expect(api.changeRelationship('other','2','send-request')).rejects.toThrow('account changed');
  await expect(api.changeRelationship('account','0','send-request')).rejects.toThrow();
  await expect(api.changeRelationship('account','2','unknown' as 'block')).rejects.toThrow();
  expect(reader).toHaveBeenCalledTimes(1);
  await api.changeRelationship('account','2','send-request');expect((await api.relationship('2')).requestState).toBe('outgoing');
  expect(reader.mock.calls.filter(call=>JSON.parse(call[2]!).operation==='send-request')).toHaveLength(1);
 });
 it('never retries a mutation after an ambiguous transport failure',async()=>{
  const reader=vi.fn(async()=>{throw Error('lost acknowledgement');});const api=new XboxSocial(connect,reader);
  await expect(api.changeRelationship('account','2','block')).rejects.toThrow('lost acknowledgement');expect(reader).toHaveBeenCalledTimes(1);
 });
 it('prevents simultaneous actions on the same player from separate native views',async()=>{
  let finish!:(value:string)=>void;const reader=vi.fn(()=>new Promise<string>(resolve=>{finish=resolve;}));const api=new XboxSocial(connect,reader);
  const first=api.changeRelationship('account','2','send-request');
  await expect(api.changeRelationship('account','2','send-request')).rejects.toThrow('current player action');expect(reader).toHaveBeenCalledTimes(1);
  finish(reply('send-request',{xuid:'2',success:true}));await first;
 });
 it('keeps title history public and bounded without accepting arbitrary images or counters',async()=>{
  const game={titleId:'123',name:'E-Day',imageUrl:'https://store-images.s-microsoft.com/game.png',lastPlayed:'2026-10-23T12:00:00Z',currentGamerscore:0,achievementsUnlocked:0};
  const api=new XboxSocial(connect,async()=>reply('games',{items:[{...game,authorization:'private'}],continuation:null,truncated:false}));
  expect(await api.games('2')).toEqual({items:[game],continuation:null,truncated:false});
  for(const invalid of [{...game,imageUrl:'https://private@store-images.s-microsoft.com/game.png'},{...game,titleId:'4294967296'},{...game,achievementsUnlocked:-1}]){
   await expect(new XboxSocial(connect,async()=>reply('games',{items:[invalid]})).games('2')).rejects.toThrow();
  }
 });
});
