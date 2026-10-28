import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {XboxVoice} from './xbox-voice';
import type {XboxVoiceApi} from '../shared/types';
const track=()=>({kind:'audio',enabled:true,stop:vi.fn()});
class Channel {
 readyState='connecting';onopen?:()=>void;onclose?:()=>void;onmessage?:(event:{data:string})=>void;send=vi.fn();
 close(){this.readyState='closed';this.onclose?.();}
 open(){this.readyState='open';this.onopen?.();}
 message(type:string,content:unknown){this.onmessage?.({data:JSON.stringify({type,channelVersion:1,contentMessage:JSON.stringify(content)})});}
}
class Peer {
 static instances:Peer[]=[];connectionState='new';channel=new Channel();transceivers:any[]=[];localDescription={sdp:'v=0\r\n'};
 onconnectionstatechange?:()=>void;ontrack?:Function;
 constructor(){Peer.instances.push(this);}
 createDataChannel(){return this.channel;}
 addTransceiver(_kind:string,{direction}:{direction:string}){const value={mid:String(this.transceivers.length),direction,receiver:{track:track()},sender:{replaceTrack:vi.fn(async()=>{})},setCodecPreferences:vi.fn()};this.transceivers.push(value);return value;}
 getTransceivers(){return this.transceivers;}
 createOffer=async()=>({type:'offer',sdp:'v=0\r\n'});setLocalDescription=async()=>{};setRemoteDescription=async()=>{};addIceCandidate=async()=>{};
 close(){this.connectionState='closed';this.onconnectionstatechange?.();}
 connect(){this.connectionState='connected';this.onconnectionstatechange?.();}
}
const microphone=track();let capture:ReturnType<typeof vi.fn>;
beforeEach(()=>{
 Peer.instances=[];microphone.stop.mockClear();capture=vi.fn(async()=>({getAudioTracks:()=>[microphone],getTracks:()=>[microphone]}));
 vi.stubGlobal('RTCPeerConnection',Peer);vi.stubGlobal('RTCRtpSender',{getCapabilities:()=>({codecs:[{mimeType:'audio/opus'}]})});
 vi.stubGlobal('AudioContext',class{createMediaStreamDestination(){const t=track();return{stream:{getAudioTracks:()=>[t],getTracks:()=>[t]}};}close=async()=>{};resume=async()=>{};});
 vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:capture}});
});
afterEach(()=>vi.unstubAllGlobals());
function fixture(){
 const api={startXboxParty:vi.fn(async()=>({id:'party',answer:{sdpType:'answer' as const,sdp:'v=0\r\n',iceCandidates:[]}})),confirmXboxParty:vi.fn(async()=>{}),leaveXboxParty:vi.fn(async()=>{}),xboxVoiceAllowed:vi.fn(async()=>false),allowXboxMicrophone:vi.fn(async()=>{})};
 const changed=vi.fn();return {voice:new XboxVoice(api as unknown as XboxVoiceApi,changed),api,changed};
}
async function connected(){const f=fixture();await f.voice.start();const pc=Peer.instances[0];pc.connect();pc.channel.open();pc.channel.message('RelayConnectionState',{state:'Connected'});await vi.waitFor(()=>expect(f.api.confirmXboxParty).toHaveBeenCalledOnce());return {...f,pc};}
it('starts without microphone access and requires ICE, control and relay before claiming a connection',async()=>{
 const {voice,api,changed}=fixture();await voice.start();const pc=Peer.instances[0];
 expect(capture).not.toHaveBeenCalled();expect(pc.transceivers.filter(t=>t.direction==='recvonly').every(t=>!t.receiver.track.enabled)).toBe(true);
 pc.connect();pc.channel.open();expect(api.confirmXboxParty).not.toHaveBeenCalled();
 pc.channel.message('RelayConnectionState',{state:'Connected'});await vi.waitFor(()=>expect(api.confirmXboxParty).toHaveBeenCalledOnce());
 expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({connected:true,muted:true}));voice.closeMedia();
});
it('keeps denied peers silent and preserves a local mute when Xbox later allows communication',async()=>{
 const {voice,api,pc}=await connected();pc.channel.message('PeerAdded',{xuid:'2',transportSinkId:'0'});
 await vi.waitFor(()=>expect(api.xboxVoiceAllowed).toHaveBeenCalledWith('2'));expect(pc.transceivers[0].receiver.track.enabled).toBe(false);
 voice.mutePeer('2',true);api.xboxVoiceAllowed.mockResolvedValue(true);pc.channel.message('PrivacyChanged',{});
 await Promise.resolve();await Promise.resolve();expect(pc.transceivers[0].receiver.track.enabled).toBe(false);
 pc.channel.message('PeerRemoved',{xuid:'2'});pc.channel.message('PeerAdded',{xuid:'2',transportSinkId:'0'});
 await Promise.resolve();await Promise.resolve();expect(pc.transceivers[0].receiver.track.enabled).toBe(false);
 voice.mutePeer('2',false);expect(pc.transceivers[0].receiver.track.enabled).toBe(true);voice.closeMedia();
});
it('opens the microphone only on explicit unmute and stops hardware capture on mute or disposal',async()=>{
 const {voice,api}=await connected();expect(capture).not.toHaveBeenCalled();await voice.setMuted(false);
 expect(api.allowXboxMicrophone).toHaveBeenCalledOnce();expect(capture).toHaveBeenCalledWith(expect.objectContaining({video:false}));
 await voice.setMuted(true);expect(microphone.stop).toHaveBeenCalledOnce();await voice.setMuted(false);voice.closeMedia();expect(microphone.stop).toHaveBeenCalledTimes(2);
});

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return{promise,resolve};}
it('does not open a microphone after teardown while its permission request is pending',async()=>{
 const f=await connected(),grant=deferred<void>();f.api.allowXboxMicrophone.mockReturnValueOnce(grant.promise);
 const pending=f.voice.setMuted(false),rejected=expect(pending).rejects.toThrow('before microphone');
 f.voice.closeMedia();grant.resolve();await rejected;expect(capture).not.toHaveBeenCalled();
});
it('stops a late microphone stream instead of attaching it to a replacement session',async()=>{
 const f=await connected(),stream=deferred<any>();capture.mockReturnValueOnce(stream.promise);
 const pending=f.voice.setMuted(false),rejected=expect(pending).rejects.toThrow('before microphone');
 await vi.waitFor(()=>expect(capture).toHaveBeenCalledOnce());f.voice.closeMedia();stream.resolve({getTracks:()=>[microphone],getAudioTracks:()=>[microphone]});
 await rejected;expect(microphone.stop).toHaveBeenCalledOnce();
});
it('does not create a server party when closed during initial local audio preparation',async()=>{
 const prepared=deferred<void>();
 vi.stubGlobal('RTCPeerConnection',class extends Peer{override addTransceiver(kind:string,options:{direction:string}){const value=super.addTransceiver(kind,options);if(options.direction==='sendonly')value.sender.replaceTrack.mockReturnValueOnce(prepared.promise);return value;}});
 const f=fixture(),pending=f.voice.start();f.voice.closeMedia();prepared.resolve();await pending;
 expect(f.api.startXboxParty).not.toHaveBeenCalled();expect(capture).not.toHaveBeenCalled();
});
it('cannot undo a newer voice-policy denial with an older successful response',async()=>{
 const f=await connected(),first=deferred<boolean>(),second=deferred<boolean>();
 f.api.xboxVoiceAllowed.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
 f.pc.channel.message('PeerAdded',{xuid:'2',transportSinkId:'0'});f.pc.channel.message('PrivacyChanged',{});
 second.resolve(false);await Promise.resolve();await Promise.resolve();first.resolve(true);await Promise.resolve();await Promise.resolve();
 expect(f.pc.transceivers[0].receiver.track.enabled).toBe(false);f.voice.closeMedia();
});
it('silences the previous transport before remapping a peer and rejects shared transport IDs',async()=>{
 const f=await connected();f.api.xboxVoiceAllowed.mockResolvedValueOnce(true);
 f.pc.channel.message('PeerAdded',{xuid:'2',transportSinkId:'0'});await Promise.resolve();await Promise.resolve();expect(f.pc.transceivers[0].receiver.track.enabled).toBe(true);
 f.pc.channel.message('PeerAdded',{xuid:'2',transportSinkId:'1'});expect(f.pc.transceivers[0].receiver.track.enabled).toBe(false);
 f.pc.channel.message('PeerAdded',{xuid:'3',transportSinkId:'1'});await vi.waitFor(()=>expect(f.api.leaveXboxParty).toHaveBeenCalledOnce());
 expect(f.pc.connectionState).toBe('closed');expect(capture).not.toHaveBeenCalled();f.voice.closeMedia();
});
it('stops tracks delivered late by a disposed peer without creating playback elements',async()=>{
 const f=await connected(),late=track();f.voice.closeMedia();
 f.pc.ontrack!({track:late,transceiver:{mid:'0'}});expect(late.enabled).toBe(false);expect(late.stop).toHaveBeenCalledOnce();expect(capture).not.toHaveBeenCalled();
});
it('reports a failed start even when leaving the failed allocation succeeds',async()=>{
 const f=fixture();f.api.startXboxParty.mockRejectedValueOnce(Error('Xbox rejected this connection.'));
 await expect(f.voice.start()).rejects.toThrow('rejected');expect(f.api.leaveXboxParty).toHaveBeenCalledOnce();
 expect(capture).not.toHaveBeenCalled();f.voice.closeMedia();
});
