import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
import type {XboxMessage,XboxMessageReceipt,XboxPlayerProfile,XboxSocialApi} from '../shared/types';
import {XboxChat,XboxChatSession,xboxChatCanSend,xboxChatComposeKey,watchXboxChatFocus,type XboxChatState} from './XboxChat';

const message=(id:string,text=id):XboxMessage=>({id,text,sender:'2',mine:false,hidden:false,timestamp:'2026-10-23T12:34:56Z'});
it('coalesces focus/restore observation after paint and cancels it when the chat changes or closes',()=>{
 const target=new EventTarget(),doc=new EventTarget(),frames=new Map<number,FrameRequestCallback>();let next=0;
 const observe=vi.fn(),cancel=vi.fn((id:number)=>frames.delete(id));
 vi.stubGlobal('window',Object.assign(target,{requestAnimationFrame:(callback:FrameRequestCallback)=>{const id=++next;frames.set(id,callback);return id;},cancelAnimationFrame:cancel}));
 vi.stubGlobal('document',doc);
 try{
  const dispose=watchXboxChatFocus(observe);expect(observe).not.toHaveBeenCalled();expect(frames.size).toBe(1);
  target.dispatchEvent(new Event('focus'));doc.dispatchEvent(new Event('visibilitychange'));expect(frames.size).toBe(1);expect(cancel).toHaveBeenCalledTimes(2);
  const [id,callback]=[...frames.entries()][0];frames.delete(id);callback(0);expect(observe).toHaveBeenCalledOnce();
  target.dispatchEvent(new Event('focus'));dispose();expect(frames.size).toBe(0);
  target.dispatchEvent(new Event('focus'));doc.dispatchEvent(new Event('visibilitychange'));expect(frames.size).toBe(0);expect(observe).toHaveBeenCalledOnce();
 }finally{vi.unstubAllGlobals();}
});
it('queues conversation history before its optional player profile',async()=>{
 const f=fixture(),order:string[]=[];
 f.api.getXboxConversation.mockImplementation(async()=>{order.push('history');return [];});
 f.api.getXboxPlayerProfile.mockImplementation(async()=>{order.push('profile');return{xuid:'2',gamertag:'Fixture',gamerscore:null};});
 await f.chat.start();expect(order).toEqual(['history','profile']);f.chat.close();
});
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function fixture(account='account-a',xuid='2'){
 const api={
  getXboxPlayerProfile:vi.fn(async(id:string):Promise<XboxPlayerProfile>=>({xuid:id,gamertag:'Player '+id,gamerscore:null,avatarUrl:'https://gamerpic.xboxlive.com/player.png'})),
  getXboxConversation:vi.fn(async(_id:string):Promise<XboxMessage[]>=>[message('history')]),
  sendXboxMessage:vi.fn(async(_account:string,_id:string,_text:string):Promise<XboxMessageReceipt>=>({id:'sent-id'})),
 };
 const updates:XboxChatState[]=[];const chat=new XboxChatSession(api,account,xuid,value=>updates.push(value));
 return{api,chat,updates};
}

it('loads only the selected player and conversation without performing a send',async()=>{
 const f=fixture();await f.chat.start();
 expect(f.api.getXboxPlayerProfile.mock.calls).toEqual([['2']]);expect(f.api.getXboxConversation.mock.calls).toEqual([['2']]);
 expect(f.chat.current.profile?.gamertag).toBe('Player 2');expect(f.chat.current.messages[0].text).toBe('history');expect(f.chat.current.loading).toBe(false);
 expect(f.api.sendXboxMessage).not.toHaveBeenCalled();f.chat.close();
});

it('rejects foreign profile metadata even when a read transport returns another player',async()=>{
 const f=fixture();f.api.getXboxPlayerProfile.mockResolvedValueOnce({xuid:'3',gamertag:'Wrong player',gamerscore:null});await f.chat.start();
 expect(f.chat.current.profile).toBeUndefined();expect(f.chat.current.messages).toHaveLength(1);f.chat.close();
});

it('discards late profiles, histories and send completions after an account or target replacement',async()=>{
 const f=fixture(),profile=deferred<XboxPlayerProfile>(),history=deferred<XboxMessage[]>(),send=deferred<XboxMessageReceipt>();
 f.api.getXboxPlayerProfile.mockReturnValueOnce(profile.promise);f.api.getXboxConversation.mockReturnValueOnce(history.promise);f.api.sendXboxMessage.mockReturnValueOnce(send.promise);
 const reading=f.chat.start();f.chat.setDraft('Private draft for account A');const writing=f.chat.send();f.chat.close();const before=f.updates.length;
 const next=fixture('account-b','3');await next.chat.start();expect(next.chat.current.draft).toBe('');
 profile.resolve({xuid:'2',gamertag:'Old private player',gamerscore:null});history.resolve([message('old-private-history')]);send.resolve({id:'sent-id'});
 await Promise.all([reading,writing]);await Promise.resolve();
 expect(f.updates).toHaveLength(before);expect(next.chat.current.profile?.xuid).toBe('3');expect(next.chat.current.messages[0].text).toBe('history');expect(next.chat.current.draft).toBe('');
 expect(f.api.sendXboxMessage.mock.calls).toEqual([['account-a','2','Private draft for account A']]);expect(next.api.sendXboxMessage).not.toHaveBeenCalled();next.chat.close();
});

it('isolates the React view immediately when either account or recipient changes',()=>{
 const f=fixture(),base={api:f.api as unknown as XboxSocialApi,account:'account-a',xuid:'2'};
 const first=XboxChat(base);expect(XboxChat({...base,account:'account-b'}).key).not.toBe(first.key);expect(XboxChat({...base,xuid:'3'}).key).not.toBe(first.key);
});

it('keeps an ambiguous draft and requires a successful explicit refresh before another send',async()=>{
 const f=fixture();await f.chat.start();f.chat.setDraft('One explicit message');f.api.sendXboxMessage.mockRejectedValueOnce(Error('Connection interrupted.'));
 await f.chat.send();expect(f.api.sendXboxMessage).toHaveBeenCalledOnce();expect(f.chat.current.draft).toBe('One explicit message');
 expect(f.chat.current.uncertain).toBe(true);expect(f.chat.current.problem).toContain('Message was not retried');
 await f.chat.send();await f.chat.refresh('poll');await f.chat.send();expect(f.api.sendXboxMessage).toHaveBeenCalledOnce();expect(f.chat.current.uncertain).toBe(true);
 f.api.getXboxConversation.mockRejectedValueOnce(Error('Still disconnected.'));await f.chat.refresh('manual');await f.chat.send();expect(f.api.sendXboxMessage).toHaveBeenCalledOnce();expect(f.chat.current.uncertain).toBe(true);
 await f.chat.refresh('manual');expect(f.chat.current.uncertain).toBe(false);await f.chat.send();expect(f.api.sendXboxMessage).toHaveBeenCalledTimes(2);expect(f.chat.current.draft).toBe('');f.chat.close();
});

it('does not misreport an acknowledged send as failed when its subsequent history read fails',async()=>{
 const f=fixture();await f.chat.start();f.chat.setDraft('Accepted message');f.api.getXboxConversation.mockRejectedValueOnce(Error('Read unavailable.'));
 await f.chat.send();expect(f.api.sendXboxMessage).toHaveBeenCalledOnce();expect(f.chat.current.draft).toBe('');expect(f.chat.current.uncertain).toBe(false);
 expect(f.chat.current.notice).toBe('Xbox accepted the message.');expect(f.chat.current.problem).toContain('Xbox accepted the message');expect(f.chat.current.sent).toBe(1);f.chat.close();
});

it('confirms the exact server receipt in history without treating another message as delivery',async()=>{
 const f=fixture();await f.chat.start();f.chat.setDraft('Accepted message');await f.chat.send();
 expect(f.chat.current.notice).toContain('Waiting for it to appear');expect(f.chat.current.messages.map(item=>item.id)).toEqual(['history']);
 f.api.getXboxConversation.mockResolvedValueOnce([{...message('sent-id'),mine:false}]);await f.chat.refresh('poll');
 expect(f.chat.current.notice).toContain('Waiting for it to appear');
 f.api.getXboxConversation.mockResolvedValueOnce([{...message('sent-id'),mine:true}]);await f.chat.refresh('poll');
 expect(f.chat.current.notice).toBe('Message confirmed in conversation.');f.chat.close();
});

it('keeps the draft when a send transport returns no receipt',async()=>{
 const f=fixture();await f.chat.start();f.chat.setDraft('Keep this');f.api.sendXboxMessage.mockResolvedValueOnce(undefined as unknown as XboxMessageReceipt);
 await f.chat.send();expect(f.chat.current.draft).toBe('Keep this');expect(f.chat.current.uncertain).toBe(true);expect(f.chat.current.sent).toBe(0);f.chat.close();
});

it('submits on Enter while Shift+Enter, composition and key repeats cannot send extra messages',()=>{
 const submit=vi.fn(),preventDefault=vi.fn();
 const event={key:'Enter',shiftKey:false,ctrlKey:false,altKey:false,metaKey:false,repeat:false,nativeEvent:{isComposing:false,keyCode:13},currentTarget:{form:{requestSubmit:submit}},preventDefault};
 const press=(patch:object={})=>xboxChatComposeKey({...event,...patch} as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
 press();expect(submit).toHaveBeenCalledOnce();expect(preventDefault).toHaveBeenCalledOnce();submit.mockClear();preventDefault.mockClear();
 for(const patch of [{shiftKey:true},{ctrlKey:true},{altKey:true},{metaKey:true},{key:'a'},{nativeEvent:{isComposing:true,keyCode:13}},{nativeEvent:{isComposing:false,keyCode:229}}])press(patch);
 expect(submit).not.toHaveBeenCalled();expect(preventDefault).not.toHaveBeenCalled();
 press({repeat:true});expect(submit).not.toHaveBeenCalled();expect(preventDefault).toHaveBeenCalledOnce();
});

it('ignores pre-send history so it cannot overwrite the newly accepted message',async()=>{
 const f=fixture(),old=deferred<XboxMessage[]>();f.api.getXboxConversation.mockReturnValueOnce(old.promise).mockResolvedValueOnce([message('newly-sent')]);
 const reading=f.chat.start();f.chat.setDraft('New message');await f.chat.send();expect(f.chat.current.messages[0].id).toBe('newly-sent');
 old.resolve([message('old-history')]);await reading;expect(f.chat.current.messages[0].id).toBe('newly-sent');expect(f.chat.current.sending).toBe(false);f.chat.close();
});

it('coalesces refreshes and prevents double submits or polling during an active send',async()=>{
 const f=fixture(),history=deferred<XboxMessage[]>(),send=deferred<XboxMessageReceipt>();f.api.getXboxConversation.mockReturnValueOnce(history.promise);f.api.sendXboxMessage.mockReturnValueOnce(send.promise);
 const first=f.chat.refresh('poll'),second=f.chat.refresh('poll');expect(second).toBe(first);expect(f.api.getXboxConversation).toHaveBeenCalledOnce();
 f.chat.setDraft('Only one send');const writing=f.chat.send();await f.chat.send();await f.chat.refresh('poll');expect(f.api.sendXboxMessage).toHaveBeenCalledOnce();expect(f.api.getXboxConversation).toHaveBeenCalledOnce();
 send.reject(Error('Unknown acknowledgement.'));await writing;history.resolve([message('old')]);await first;expect(f.chat.current.messages).toEqual([]);expect(f.chat.current.uncertain).toBe(true);f.chat.close();
});

it('enforces the 256 Unicode character limit without counting emoji twice or allowing invalid text',async()=>{
 const f=fixture();expect(xboxChatCanSend('😀'.repeat(256))).toBe(true);expect(xboxChatCanSend('😀'.repeat(257))).toBe(false);
 for(const text of ['',' \n\t','bad\0text','bad\x7ftext','\uD800'])expect(xboxChatCanSend(text)).toBe(false);
 expect(xboxChatCanSend('One\nTwo\tThree')).toBe(true);
 f.chat.setDraft('😀'.repeat(256));await f.chat.send();expect(f.api.sendXboxMessage.mock.calls).toEqual([['account-a','2','😀'.repeat(256)]]);
 for(const text of ['😀'.repeat(257),'a'.repeat(257),' \t\n','bad\0text']){f.chat.setDraft(text);await f.chat.send();}
 expect(f.api.sendXboxMessage).toHaveBeenCalledOnce();expect(f.chat.current.problem).toContain('1–256');f.chat.close();
});

it('keeps explicit refresh available after a read API throws synchronously',async()=>{
 const f=fixture();f.api.getXboxPlayerProfile.mockImplementationOnce(()=>{throw Error('Profile unavailable.');});f.api.getXboxConversation.mockImplementationOnce(()=>{throw Error('Conversation unavailable.');});
 await f.chat.start();expect(f.chat.current.problem).toBe('Conversation unavailable.');expect(f.chat.current.loading).toBe(false);
 await f.chat.refresh('manual');expect(f.api.getXboxConversation).toHaveBeenCalledTimes(2);expect(f.chat.current.messages[0].id).toBe('history');expect(f.chat.current.problem).toBeUndefined();f.chat.close();
});

it('renders escaped player names, explicit window controls and unique character-counter labels',()=>{
 const f=fixture(),api=f.api as unknown as XboxSocialApi;
 const html=renderToStaticMarkup(<><XboxChat api={api} account="account-a" xuid="2" displayName="<script>Player</script>" close={()=>{}} popOut={()=>{}} openProfile={()=>{}}/><XboxChat api={api} account="account-a" xuid="3"/></>);
 expect(html).toContain('&lt;script&gt;Player&lt;/script&gt;');expect(html).not.toContain('<script>');expect(html).toContain('aria-label="Pop out chat"');expect(html).toContain('aria-label="Close chat"');expect(html).toContain('aria-label="Refresh conversation"');
 const labels=[...html.matchAll(/aria-describedby="([^"]+)"/g)].map(match=>match[1]);expect(labels).toHaveLength(2);expect(new Set(labels).size).toBe(2);
 expect(f.api.getXboxConversation).not.toHaveBeenCalled();expect(f.api.sendXboxMessage).not.toHaveBeenCalled();
});
