import {expect,it,vi} from 'vitest';
import type {XboxInvite} from '../shared/types.js';
import {XboxGuideParty} from './xbox-guide-party.js';

function fixture(){
 let interactive=true;
 const party={current:{phase:'idle' as const,members:[]},activeParties:vi.fn(async()=>['existing']),leaveExisting:vi.fn(async(_id:string)=>{}),invite:vi.fn(async(_id:string)=>{})};
 const voice={state:{connected:false,muted:true,audioBlocked:false,mutedMembers:[]},control:vi.fn(async(_value:unknown)=>{})};
 const invites={list:vi.fn(async()=>[{id:'party:example',kind:'party'},{id:'game:example',kind:'game'}] as XboxInvite[])};
 const options={party,voice,invites,interactive:()=>interactive};
 return {guide:new XboxGuideParty(options),options,party,voice,invites,hide:()=>{interactive=false;}};
}
it('only projects existing shared state and never creates an owner, call or microphone',async()=>{
 const f=fixture();
 expect(await f.guide.invoke('getXboxParty',[])).toEqual(f.party.current);
 expect(await f.guide.invoke('getXboxVoiceState',[])).toEqual(f.voice.state);
 expect(await f.guide.invoke('getXboxActiveParties',[])).toEqual(['existing']);
 expect(await f.guide.invoke('getXboxInvites',[])).toEqual([{id:'party:example',kind:'party'}]);
 expect(f.voice.control).not.toHaveBeenCalled();expect(f.party.invite).not.toHaveBeenCalled();
});
it('routes explicit commands from both views to the same existing owner exactly once',async()=>{
 const f=fixture(),second=new XboxGuideParty(f.options);
 await f.guide.invoke('controlXboxVoice',[{type:'start'}]);
 await second.invoke('controlXboxVoice',[{type:'setMuted',muted:false}]);
 await f.guide.invoke('controlXboxVoice',[{type:'leave'}]);
 expect(f.voice.control.mock.calls).toEqual([[{type:'start'}],[{type:'setMuted',muted:false}],[{type:'leave'}]]);
 await f.guide.invoke('inviteXboxPartyFriend',['2']);expect(f.party.invite.mock.calls).toEqual([['2']]);
 await f.guide.invoke('leaveExistingXboxParty',['existing']);expect(f.party.leaveExisting.mock.calls).toEqual([['existing']]);
});
it('rejects every mutation from a hidden or revoked Guide but allows cached state reads',async()=>{
 const f=fixture();f.hide();
 for(const [method,args] of [['controlXboxVoice',[{type:'start'}]],['controlXboxVoice',[{type:'setMuted',muted:false}]],['controlXboxVoice',[{type:'leave'}]],['leaveExistingXboxParty',['existing']],['inviteXboxPartyFriend',['2']]] as const)
  await expect(f.guide.invoke(method,[...args])).rejects.toThrow('Open the Guide');
 expect(f.voice.control).not.toHaveBeenCalled();expect(f.party.invite).not.toHaveBeenCalled();expect(f.party.leaveExisting).not.toHaveBeenCalled();
 expect(await f.guide.invoke('getXboxVoiceState',[])).toMatchObject({muted:true});
});
it('does not expose raw media capabilities and rejects malformed argument lists before dispatch',async()=>{
 const f=fixture();
 for(const method of ['startXboxParty','allowXboxMicrophone','xboxVoiceHostReady','xboxPartyMicrophone','xboxPartyVoiceAllowed','getToken']){
  expect(f.guide.handles(method)).toBe(false);await expect(f.guide.invoke(method,[])).rejects.toThrow('Unsupported');
 }
 for(const [method,args] of [['controlXboxVoice',[]],['getXboxParty',['unexpected']],['leaveExistingXboxParty',[2]],['inviteXboxPartyFriend',['2','unexpected']]] as const)
  await expect(f.guide.invoke(method,[...args])).rejects.toThrow('Invalid');
 expect(f.voice.control).not.toHaveBeenCalled();expect(f.party.invite).not.toHaveBeenCalled();
});
it('propagates uncertain controls without retrying them or switching to another owner',async()=>{
 const f=fixture();f.voice.control.mockRejectedValueOnce(Error('Delivery uncertain.'));
 await expect(f.guide.invoke('controlXboxVoice',[{type:'start'}])).rejects.toThrow('uncertain');
 expect(f.voice.control).toHaveBeenCalledOnce();expect(f.party.activeParties).not.toHaveBeenCalled();
});
