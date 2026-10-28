import {beforeEach,expect,it,vi} from 'vitest';
import type {XboxVoiceApi,XboxVoiceHostApi} from '../shared/types';
const h=vi.hoisted(()=>({effects:[] as (()=>(()=>void))[],voices:[] as any[]}));
vi.mock('react',()=>({useEffect:(effect:()=>()=>void)=>h.effects.push(effect)}));
vi.mock('./xbox-voice',()=>({XboxVoice:class{
 changed:Function;start=vi.fn(async()=>{});accept=vi.fn(async()=>{});setMuted=vi.fn(async()=>{});mutePeer=vi.fn();leave=vi.fn(async()=>{});resumeAudio=vi.fn(async()=>{});closeMedia=vi.fn();
 constructor(_api:unknown,changed:Function){this.changed=changed;h.voices.push(this);}
}}));
import {XboxVoiceHost} from './XboxVoiceHost';
beforeEach(()=>{h.effects=[];h.voices=[];});
function fixture(){
 let command!:Function,party!:Function;const offCommand=vi.fn(),offParty=vi.fn();
 const api={onXboxVoiceHostCommand:vi.fn((listener:Function)=>{command=listener;return offCommand;}),onXboxPartyState:vi.fn((listener:Function)=>{party=listener;return offParty;}),
  getXboxParty:vi.fn(async()=>({phase:'connected',id:'party',selfXuid:'1',members:[{xuid:'1',role:'owner'},{xuid:'2',role:null}]})),
  publishXboxVoiceHostState:vi.fn(async(_state:unknown)=>{}),xboxVoiceHostReady:vi.fn(async()=>{}),completeXboxVoiceHostCommand:vi.fn(async(_id:string,_error?:string)=>{})};
 expect(XboxVoiceHost({api:api as unknown as XboxVoiceApi&XboxVoiceHostApi})).toBeNull();const close=h.effects[0]();
 return {api,close,voice:h.voices[0],command:(id:string,value:unknown)=>command({id,command:value}),party:(value:unknown)=>party(value),offCommand,offParty};
}
it('runs media commands in the single owner and exposes only bounded state to guides',async()=>{
 const f=fixture();await Promise.resolve();expect(h.voices).toHaveLength(1);expect(f.api.xboxVoiceHostReady).toHaveBeenCalledOnce();
 f.command('start',{type:'start'});await vi.waitFor(()=>expect(f.api.completeXboxVoiceHostCommand).toHaveBeenCalledWith('start'));expect(f.voice.start).toHaveBeenCalledOnce();
 f.command('mute',{type:'mute',xuid:'2',muted:true});await vi.waitFor(()=>expect(f.api.completeXboxVoiceHostCommand).toHaveBeenCalledWith('mute'));expect(f.voice.mutePeer).toHaveBeenCalledWith('2',true);
 expect(f.api.publishXboxVoiceHostState).toHaveBeenLastCalledWith(expect.objectContaining({mutedMembers:['2']}));
 f.command('unknown',{type:'mute',xuid:'3',muted:true});await vi.waitFor(()=>expect(f.api.completeXboxVoiceHostCommand).toHaveBeenCalledWith('unknown',expect.stringContaining('not a remote member')));expect(f.voice.mutePeer).toHaveBeenCalledOnce();
 f.voice.changed({connected:false,muted:true,audioBlocked:false,error:'bad\n'.repeat(400)});
 const state=f.api.publishXboxVoiceHostState.mock.calls.at(-1)![0] as any;expect(state.error.length).toBeLessThanOrEqual(1024);expect(state.error).not.toContain('\n');expect(state.mutedMembers).toEqual([]);f.close();
});
it('closes tracks on backend departure and on owner teardown without asking a guide to own media',async()=>{
 const f=fixture();await Promise.resolve();f.party({phase:'leaving',members:[]});expect(f.voice.closeMedia).toHaveBeenCalledOnce();expect(f.api.publishXboxVoiceHostState).toHaveBeenLastCalledWith({connected:false,muted:true,audioBlocked:false,mutedMembers:[]});
 f.close();expect(f.offCommand).toHaveBeenCalledOnce();expect(f.offParty).toHaveBeenCalledOnce();expect(f.voice.closeMedia).toHaveBeenCalledTimes(2);expect(f.voice.leave).not.toHaveBeenCalled();
});
it('does not erase a media connection error when server cleanup returns an idle party',async()=>{
 const f=fixture();await Promise.resolve();f.voice.changed({connected:false,muted:true,audioBlocked:false,error:'Connection failed.'});
 f.party({phase:'leaving',members:[]});f.party({phase:'idle',members:[]});
 expect(f.api.publishXboxVoiceHostState).toHaveBeenLastCalledWith(expect.objectContaining({error:'Connection failed.',connected:false,muted:true}));f.close();
});
