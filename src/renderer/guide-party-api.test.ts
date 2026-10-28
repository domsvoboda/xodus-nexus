import {afterEach,expect,it,vi} from 'vitest';
const rpc=vi.hoisted(()=>vi.fn(async(..._args:unknown[])=>undefined));
const events=vi.hoisted(()=>vi.fn((..._args:unknown[])=>()=>{}));
vi.mock('./xbox-guide-api',()=>({guideRpc:rpc,onGuideEvent:events}));
import {guidePartyApi} from './guide-party-api';
afterEach(()=>vi.clearAllMocks());
it('routes Guide party controls to the existing shared media owner without owning audio',async()=>{
 await guidePartyApi.getXboxParty();await guidePartyApi.controlXboxVoice({type:'leave'});await guidePartyApi.inviteXboxPartyFriend('2');
 expect(rpc.mock.calls).toEqual([['getXboxParty'],['controlXboxVoice',{type:'leave'}],['inviteXboxPartyFriend','2']]);
 guidePartyApi.onXboxPartyState(()=>{});guidePartyApi.onXboxVoiceState(()=>{});guidePartyApi.onXboxInvitesChanged(()=>{});
 expect(events.mock.calls.map(call=>call[0])).toEqual(['party','voice','invites']);
 expect(guidePartyApi).not.toHaveProperty('xboxVoiceHostReady');expect(guidePartyApi).not.toHaveProperty('acceptXboxGameInvite');
 for(const name of ['xboxPartyStart','xboxPartyMicrophone','xboxPartyVoiceAllowed','publishXboxVoiceHostState','completeXboxVoiceHostCommand'])expect(guidePartyApi).not.toHaveProperty(name);
});
it('exposes read state and bounded explicit controls, without starting anything on subscription',async()=>{
 guidePartyApi.onXboxPartyState(()=>{});guidePartyApi.onXboxVoiceState(()=>{});expect(rpc).not.toHaveBeenCalled();
 await guidePartyApi.getXboxVoiceState();await guidePartyApi.getXboxActiveParties();await guidePartyApi.getXboxInvites();
 await guidePartyApi.leaveExistingXboxParty('existing');await guidePartyApi.controlXboxVoice({type:'setMuted',muted:false});
 expect(rpc.mock.calls).toEqual([['getXboxVoiceState'],['getXboxActiveParties'],['getXboxInvites'],['leaveExistingXboxParty','existing'],['controlXboxVoice',{type:'setMuted',muted:false}]]);
});
