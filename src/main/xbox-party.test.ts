import { EventEmitter } from 'node:events';
import { expect,it,vi } from 'vitest';
import { XboxParty } from './xbox-party.js';
class Chat extends EventEmitter {connect=vi.fn(async()=>({xuid:'1',connectionId:'c',serverNonce:'n'}));close=vi.fn();}
const answer=JSON.stringify({status:'success',sdpType:'answer',sdp:'v=0\r\n',iceCandidates:[]});
const doc=(transportResponse:string|null=answer)=>({id:'owned-party',members:[{xuid:'1',role:'owner'}],transportResponse});
function fixture(failAnswer=false,failLeave=false){
  const chat=new Chat();const calls:any[]=[];
  const read=vi.fn(async(_binary:string,_args:string[],input:string|undefined)=>{
    const request=JSON.parse(input!);calls.push(request);
    if(request.operation==='leave'&&failLeave){failLeave=false;throw Error('Leave acknowledgement lost');}
    const result=request.operation==='create'?doc(failAnswer?'{}':answer):request.operation==='voice-policy'?{isAllowed:false}:{success:true};
    return JSON.stringify({schema:1,kind:'party',account:'account',operation:request.operation,result});
  });
  return {party:new XboxParty(()=>({binary:'cli',account:'account'}),read,chat as any),chat,calls};
}
it('separates party creation from verified media connection and leaves only its own party',async()=>{
  const {party,calls,chat}=fixture();const result=await party.start('offer');
  expect(party.current.phase).toBe('connecting');expect(result.id).toBe('owned-party');
  party.connected(result.id);expect(party.current.phase).toBe('connected');
  await party.leave();expect(party.current.phase).toBe('idle');expect(chat.close).toHaveBeenCalledOnce();
  expect(calls.map(c=>c.operation)).toEqual(['create','leave']);expect(calls[1].partyId).toBe('owned-party');
});
it('retains its own party after a failed leave so cleanup can be retried',async()=>{
  const {party,calls}=fixture(false,true);await party.start('offer');
  await expect(party.leave()).rejects.toThrow('acknowledgement lost');
  expect(party.current).toMatchObject({phase:'error',id:'owned-party'});
  await expect(party.start('offer')).rejects.toThrow('Leave the existing');
  await party.leave();expect(party.current).toEqual({phase:'idle',members:[]});
  expect(calls.map(c=>c.operation)).toEqual(['create','leave','leave']);
});
it('cleans up an owned allocation if the relay answer is invalid',async()=>{
  const {party,calls}=fixture(true);await expect(party.start('offer')).rejects.toThrow('rejected');
  expect(calls.map(c=>c.operation)).toEqual(['create','leave']);expect(party.current.phase).toBe('error');expect(party.current.id).toBeUndefined();
});
it('does not turn a denied voice permission into an allowed relationship or send invitations automatically',async()=>{
  const {party,calls}=fixture();expect(await party.voiceAllowed('2')).toBe(false);
  await expect(party.invite('2')).rejects.toThrow('Connect');expect(calls.map(c=>c.operation)).toEqual(['voice-policy']);
});
it('leaves an existing other-device party only after an explicit request and fresh own-account membership check',async()=>{
  const chat=new Chat(),operations:string[]=[];
  const read=async(_binary:string,_args:string[],input:string|undefined)=>{
    const request=JSON.parse(input!);operations.push(request.operation);
    return JSON.stringify({schema:1,kind:'party',account:'account',operation:request.operation,result:request.operation==='active'?{ids:['other-device-party']}:{success:true}});
  };
  const party=new XboxParty(()=>({binary:'cli',account:'account'}),read,chat as any);
  expect(await party.activeParties()).toEqual(['other-device-party']);expect(operations).toEqual(['active']);
  await expect(party.leaveExisting('unrelated')).rejects.toThrow('no longer active');expect(operations).toEqual(['active','active']);
  await party.leaveExisting('other-device-party');expect(operations).toEqual(['active','active','active','leave']);expect(chat.connect).not.toHaveBeenCalled();
});
it('waits for an in-flight create to identify its allocation before cancelling and cleaning it up',async()=>{
  const chat=new Chat(),operations:string[]=[];let release!:(value:string)=>void;
  const read=async(_binary:string,_args:string[],input:string|undefined)=>{
    const request=JSON.parse(input!);operations.push(request.operation);
    if(request.operation==='create')return await new Promise<string>(resolve=>{release=resolve;});
    return JSON.stringify({schema:1,kind:'party',account:'account',operation:request.operation,result:{success:true}});
  };
  const party=new XboxParty(()=>({binary:'cli',account:'account'}),read,chat as any);
  const start=party.start('offer');const rejected=expect(start).rejects.toThrow('cancelled');await vi.waitFor(()=>expect(operations).toEqual(['create']));
  const leaving=party.leave();release(JSON.stringify({schema:1,kind:'party',account:'account',operation:'create',result:doc()}));
  await leaving;await rejected;expect(operations).toEqual(['create','leave']);expect(party.current).toEqual({phase:'idle',members:[]});
});
it('accepts a genuine inbox party handle through the invite endpoint and never creates or sends an invitation',async()=>{
 const chat=new Chat(),requests:any[]=[];
 const read=async(_binary:string,_args:string[],input:string|undefined)=>{
  const request=JSON.parse(input!);requests.push(request);
  const result=request.operation==='active'?{ids:[]}:request.operation==='accept-invite'?doc():{success:true};
  return JSON.stringify({schema:1,kind:'party',account:'account',operation:request.operation,result});
 };
 const party=new XboxParty(()=>({binary:'cli',account:'account'}),read,chat as any);await party.accept('offer','real-inbox-handle');
 expect(requests.map(r=>r.operation)).toEqual(['active','accept-invite']);expect(requests[1]).toMatchObject({inviteId:'real-inbox-handle',connectionId:'c',serverNonce:'n'});
 await party.leave();
});
