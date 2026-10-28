import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {ScriptTarget,transpileModule} from 'typescript';
import {expect,it,vi} from 'vitest';

const source=readFileSync('src/main/index.ts','utf8');
const compile=(text:string)=>transpileModule(text,{compilerOptions:{target:ScriptTarget.ES2022}}).outputText;
const accept=compile(source.slice(source.indexOf('async function acceptPartyInvite('),source.indexOf('function registerIpc():')));
it('rechecks the exact media owner and account/backend after resolving an invitation handle',async()=>{
 for(const change of ['account','backend','owner'] as const){
  let connection={account:'A',binary:'/a'},owner=true,release!:(value:string)=>void;
  const party={accept:vi.fn()},context={voiceHost:{owns:()=>owner},nativeSocialConnection:()=>connection,xboxParty:party,xboxInvites:{partyHandle:()=>new Promise<string>(resolve=>{release=resolve;})}};
  runInNewContext(accept,context);const pending=(context as any).acceptPartyInvite({},'offer','party:fixture'),rejected=expect(pending).rejects.toThrow('account changed');
  if(change==='owner')owner=false;else connection={account:change==='account'?'B':'A',binary:change==='backend'?'/b':'/a'};
  release('genuine-handle');await rejected;expect(party.accept).not.toHaveBeenCalled();
 }
});
it('stops the shared media host before waiting for party departure on an explicit account action',async()=>{
 const line=source.split('\n').find(line=>line.includes('nativeSocialBeforeAuth.push(async()=>'))!;
 const hooks:Function[]=[],calls:string[]=[];let finish!:()=>void;
 runInNewContext(compile(line),{nativeSocialBeforeAuth:{push:(callback:Function)=>hooks.push(callback)},voiceHost:{control:()=>{calls.push('stop-media');return new Promise<void>(resolve=>{finish=resolve;});}},xboxParty:{leave:async()=>{calls.push('leave-party');}}});
 const pending=hooks[0]();expect(calls).toEqual(['stop-media']);finish();await pending;expect(calls).toEqual(['stop-media','leave-party']);
});
it('resets media and chats when backend identity/support changes but not on ordinary snapshots',()=>{
 const start=source.indexOf('let nativeSocialBackend:'),end=source.indexOf('\nasync function showFriends()',start),reset=vi.fn();
 const context={backend:{current:{available:true,binaryPath:'/a',capabilities:{nativeSocial:true}}},resetNativeSocial:reset};
 runInNewContext(compile(source.slice(start,end)),context);const sync=()=>(context as any).syncNativeSocialBackend();
 sync();sync();expect(reset).not.toHaveBeenCalled();context.backend.current.binaryPath='/b';sync();expect(reset).toHaveBeenCalledOnce();
 context.backend.current.available=false;sync();expect(reset).toHaveBeenCalledTimes(2);sync();expect(reset).toHaveBeenCalledTimes(2);
 context.backend.current.available=true;sync();expect(reset).toHaveBeenCalledTimes(2);context.backend.current.capabilities.nativeSocial=false;sync();expect(reset).toHaveBeenCalledTimes(3);
});
