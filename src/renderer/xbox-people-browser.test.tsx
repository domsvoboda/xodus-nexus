import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
import type {XboxPeoplePage,XboxPerson,XboxSocialApi} from '../shared/types';
import {SocialFriends,XboxPeopleBrowser,XboxPeopleResults,peopleMenuPlacement,type XboxPeopleState} from './XboxPeopleBrowser';

const person=(xuid:string,gamertag='Player '+xuid):XboxPerson=>({xuid,gamertag,online:false,presence:'Offline',favorite:false,inParty:false});
const page=(...ids:string[]):XboxPeoplePage=>({items:ids.map(id=>person(id)),continuation:null});
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fixture(){
  const calls=vi.fn<(...args:any[])=>Promise<XboxPeoplePage>>();
  const api={getXboxPeople:calls} as unknown as XboxSocialApi,states:XboxPeopleState[]=[];
  const results=new XboxPeopleResults(state=>states.push(state));
  return {api,calls,states,results,last:()=>states.at(-1)!};
}

it('requests the selected list and explicit search text without a cursor argument',async()=>{
  const f=fixture();f.calls.mockResolvedValueOnce(page('1')).mockResolvedValueOnce(page('2'));
  await f.results.select(f.api,{account:'own',list:'recent'});
  expect(f.calls).toHaveBeenNthCalledWith(1,'recent',undefined);
  await f.results.select(f.api,{account:'own',list:'search',query:'Gamertag#1234'});
  expect(f.calls).toHaveBeenNthCalledWith(2,'search','Gamertag#1234');
  expect(f.last()).toMatchObject({items:[{xuid:'2'}],busy:false});
});

it('does not issue a global Xbox search with fewer than two characters',async()=>{
  const f=fixture();
  for(const query of [undefined,'','a','  ','a'.repeat(65)]){
    await f.results.select(f.api,{account:'own',list:'search',query});
    expect(f.last().problem).toContain('at least two characters');expect(f.last().busy).toBe(false);
  }
  expect(f.calls).not.toHaveBeenCalled();
});

it('deduplicates real players by XUID without inventing friends or extra requests',async()=>{
  const f=fixture();f.calls.mockResolvedValueOnce({items:[person('1'),person('2'),person('2','Updated tag')],continuation:null});
  await f.results.select(f.api,{account:'own',list:'suggested'});
  expect(f.last().items.map(p=>p.xuid)).toEqual(['1','2']);expect(f.last().items[1].gamertag).toBe('Updated tag');expect(f.calls).toHaveBeenCalledOnce();
});

it('discards an old account error while the current account request is pending',async()=>{
  const f=fixture(),old=deferred<XboxPeoplePage>(),fresh=deferred<XboxPeoplePage>();
  f.calls.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const first=f.results.select(f.api,{account:'previous-account',list:'suggested'});
  const second=f.results.select(f.api,{account:'current-account',list:'suggested'});
  old.reject(Error('Previous private account failure'));await first;
  expect(f.last().busy).toBe(true);expect(f.last().problem).toBeUndefined();expect(f.last().items).toEqual([]);expect(f.last().key).toContain('current-account');
  fresh.resolve(page('2'));await second;expect(f.last().items.map(p=>p.xuid)).toEqual(['2']);
});

it('cannot publish a previous list response after another list is selected',async()=>{
  const f=fixture(),old=deferred<XboxPeoplePage>();f.calls.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page('3'));
  const first=f.results.select(f.api,{account:'own',list:'recent'});
  await f.results.select(f.api,{account:'own',list:'received-requests'});old.resolve(page('2'));await first;
  expect(f.last().items.map(p=>p.xuid)).toEqual(['3']);expect(f.last().key).toContain('received-requests');
});

it('cannot publish an old search into a new query or an explicit refresh of the same query',async()=>{
  const f=fixture(),old=deferred<XboxPeoplePage>(),middle=deferred<XboxPeoplePage>();
  f.calls.mockReturnValueOnce(old.promise).mockReturnValueOnce(middle.promise).mockResolvedValueOnce(page('3'));
  const first=f.results.select(f.api,{account:'own',list:'search',query:'old tag'}),second=f.results.select(f.api,{account:'own',list:'search',query:'new tag'});
  await f.results.select(f.api,{account:'own',list:'search',query:'new tag'});
  old.resolve(page('1'));middle.resolve(page('2'));await Promise.all([first,second]);
  expect(f.last().items.map(p=>p.xuid)).toEqual(['3']);expect(f.last().key).toContain('new tag');
});

it('also invalidates an old API response with the same account and list',async()=>{
  const f=fixture(),old=deferred<XboxPeoplePage>(),replacement=fixture();f.calls.mockReturnValueOnce(old.promise);replacement.calls.mockResolvedValueOnce(page('2'));
  const first=f.results.select(f.api,{account:'own',list:'blocked'});
  await f.results.select(replacement.api,{account:'own',list:'blocked'});old.resolve(page('1'));await first;
  expect(f.last().items.map(p=>p.xuid)).toEqual(['2']);
});

it('cancels changed or unmounted views without publishing late content',async()=>{
  const f=fixture(),pending=deferred<XboxPeoplePage>();f.calls.mockReturnValueOnce(pending.promise);
  const request=f.results.select(f.api,{account:'own',list:'sent-requests'}),count=f.states.length;
  f.results.cancel();pending.resolve(page('1'));await request;expect(f.states).toHaveLength(count);expect(f.calls).toHaveBeenCalledOnce();
  f.results.clear();expect(f.last()).toEqual({items:[],busy:false});
});

it('reports a failed list honestly and retries only on an explicit selection',async()=>{
  const f=fixture();f.calls.mockResolvedValueOnce(page('1')).mockRejectedValueOnce(Error("Error invoking remote method 'xbox-people': Error: Xbox unavailable")).mockResolvedValueOnce(page('2'));
  await f.results.select(f.api,{account:'own',list:'recent'});await f.results.select(f.api,{account:'own',list:'suggested'});
  expect(f.last().items).toEqual([]);expect(f.last().problem).toBe('Xbox unavailable');expect(f.calls).toHaveBeenCalledTimes(2);
  await f.results.select(f.api,{account:'own',list:'suggested'});expect(f.last().items.map(p=>p.xuid)).toEqual(['2']);expect(f.last().problem).toBeUndefined();
});

it('records SDK truncation without creating pagination',async()=>{
  const f=fixture();f.calls.mockResolvedValueOnce({items:[person('1')],continuation:null,truncated:true});
  await f.results.select(f.api,{account:'own',list:'suggested'});
  expect(f.last().truncated).toBe(true);expect(f.last()).not.toHaveProperty('continuation');expect(f.calls).toHaveBeenCalledOnce();
});

it('renders native People lists and explicit Xbox search, without suggested lists in the chat chooser',()=>{
  const api={} as XboxSocialApi;
  const html=renderToStaticMarkup(<XboxPeopleBrowser api={api} account="own" friends={[]} friendsChanged={()=>{}} openProfile={()=>{}}/>);
  for(const title of ['Friends','Recent players','Suggested','Friend requests','Sent requests','Blocked','Search Xbox'])expect(html).toContain(title);
  expect(html).toContain('Find an Xbox player');expect(html).not.toMatch(/iframe|webview|xbox\.com|Load more/);
  const chooser=renderToStaticMarkup(<XboxPeopleBrowser api={api} account="own" friends={[]} friendsChanged={()=>{}} openProfile={()=>{}} choosingChat chooseChat={()=>{}}/>);
  expect(chooser).toContain('New chat');expect(chooser).toContain('Search Xbox');expect(chooser).not.toMatch(/Suggested|Recent players|Friend requests|Sent requests|Blocked/);
});

it('keeps shared friend rendering sorted and escapes remote fields',()=>{
  const html=renderToStaticMarkup(<SocialFriends friends={[person('1','Offline player'),{...person('2','<script>player</script>'),online:true,presence:'Playing E-Day',inParty:true}]} chooseChat={()=>{}}/>);
  expect(html.indexOf('Playing E-Day')).toBeLessThan(html.indexOf('Offline player'));expect(html).toContain('&lt;script&gt;player&lt;/script&gt;');expect(html).not.toContain('<script>');expect(html).toContain('In a party');
});

it('opens chat from a friend row without requesting their profile',()=>{
  const chooseChat=vi.fn(),list=SocialFriends({friends:[person('2')],chooseChat});
  const row=list.props.children[0];row.props.choose();
  expect(chooseChat).toHaveBeenCalledOnce();expect(chooseChat).toHaveBeenCalledWith('2');
});

it('flips bottom-row actions above the ellipsis and constrains them to the clipped viewport',()=>{
  expect(peopleMenuPlacement({top:680,bottom:752},{top:700,bottom:740},{top:160,bottom:760},480)).toEqual({up:true,offset:56,maxHeight:532});
  expect(peopleMenuPlacement({top:180,bottom:252},{top:200,bottom:240},{top:160,bottom:760},300)).toEqual({up:false,offset:64,maxHeight:512});
  expect(peopleMenuPlacement({top:300,bottom:372},{top:320,bottom:360},{top:280,bottom:400},600)).toEqual({up:false,offset:64,maxHeight:32});
});
