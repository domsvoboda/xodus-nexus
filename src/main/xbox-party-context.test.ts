import {EventEmitter} from 'node:events';
import {expect,it,vi} from 'vitest';
import {XboxParty} from './xbox-party.js';
class Chat extends EventEmitter{connect=vi.fn(async()=>({xuid:'1',connectionId:'c',serverNonce:'n'}));close=vi.fn();}
const document=(id='owned')=>({id,members:[{xuid:'1',role:'owner'}],transportResponse:JSON.stringify({status:'success',sdpType:'answer',sdp:'v=0\r\n',iceCandidates:[]})});
const reply=(operation:string,result:unknown)=>JSON.stringify({schema:1,kind:'party',account:'account',operation,result});
it('rejects stale backend results, hides old membership and never leaves it through the new backend',async()=>{
 let connection={account:'account',binary:'first'},release!:(value:string)=>void;const chat=new Chat();
 const read=vi.fn(async(binary:string,_args:string[],input:string|undefined)=>{
  const {operation}=JSON.parse(input!);if(binary==='first')return new Promise<string>(resolve=>{release=resolve;});return reply(operation,document('new'));
 });
 const party=new XboxParty(()=>connection,read,chat as any),pending=party.start('offer'),rejected=expect(pending).rejects.toThrow('account changed');
 await vi.waitFor(()=>expect(read).toHaveBeenCalledOnce());connection={account:'account',binary:'second'};release(reply('create',document('old')));await rejected;
 expect(party.current).toEqual({phase:'idle',members:[]});await party.start('offer');expect(party.current.id).toBe('new');
 expect(read.mock.calls.map(([binary,,input])=>[binary,JSON.parse(input!).operation])).toEqual([['first','create'],['second','create']]);party.clear();
});
it('never publishes a cancelled old allocation into a replacement party',async()=>{
 let release!:(value:string)=>void;const chat=new Chat();
 const read=vi.fn().mockImplementationOnce(()=>new Promise<string>(resolve=>{release=resolve;})).mockResolvedValueOnce(reply('create',document('new')));
 const party=new XboxParty(()=>({account:'account',binary:'cli'}),read,chat as any),old=party.start('offer'),rejected=expect(old).rejects.toThrow();
 await vi.waitFor(()=>expect(read).toHaveBeenCalledOnce());party.clear();await party.start('offer');release(reply('create',document('old')));await rejected;
 expect(party.current.id).toBe('new');party.clear();
});
it('rejects an account change during fresh active-party lookup before accepting or leaving',async()=>{
 for(const action of ['accept','leave'] as const){
  let connection={account:'account',binary:'first'},release!:(value:string)=>void;const chat=new Chat();
  const read=vi.fn(()=>new Promise<string>(resolve=>{release=resolve;}));const party=new XboxParty(()=>connection,read,chat as any);
  const pending=action==='accept'?party.accept('offer','handle'):party.leaveExisting('existing'),rejected=expect(pending).rejects.toThrow('account changed');
  connection={account:'other',binary:'second'};release(reply('active',{ids:action==='accept'?[]:['existing']}));await rejected;
  expect(read).toHaveBeenCalledOnce();expect(chat.connect).not.toHaveBeenCalled();party.clear();
 }
});
it('rejects duplicate or overflowing members and untrusted party IDs',async()=>{
 for(const doc of [{...document(),members:[{xuid:'18446744073709551616',role:null}]},{...document(),members:[{xuid:'1',role:null},{xuid:'1',role:null}]},{...document(),id:'../other'}]){
  const read=vi.fn(async()=>reply('create',doc));const party=new XboxParty(()=>({account:'account',binary:'cli'}),read,new Chat() as any);
  await expect(party.start('offer')).rejects.toThrow('Invalid Xbox party');expect(party.current.id).toBeUndefined();party.clear();
 }
});
