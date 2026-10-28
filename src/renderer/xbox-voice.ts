import type { XboxVoiceApi } from '../shared/types';

export type VoiceState={connected:boolean;muted:boolean;audioBlocked:boolean;error?:string};
type Peer={mid:string;allowed:boolean;muted:boolean;privacyVersion:number};
const validXuid=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,19}$/.test(v)&&BigInt(v)<=18446744073709551615n;

/** Local WebRTC audio; Xbox credentials and the authenticated chat socket stay in main. */
export class XboxVoice {
  private pc?:RTCPeerConnection;
  private channel?:RTCDataChannel;
  private sender?:RTCRtpSender;
  private context?:AudioContext;
  private silence?:MediaStream;
  private microphone?:MediaStream;
  private readonly audio=new Map<string,HTMLAudioElement>();
  private readonly peers=new Map<string,Peer>();
  private readonly mutedPeers=new Set<string>();
  private timer?:ReturnType<typeof setTimeout>;
  private privacyTimer?:ReturnType<typeof setInterval>;
  private generation=0;
  private microphoneVersion=0;
  private partyId?:string;
  private relayConnected=false;
  private confirming=false;
  private state:VoiceState={connected:false,muted:true,audioBlocked:false};
  constructor(private readonly api:XboxVoiceApi,private readonly changed:(state:VoiceState)=>void){}
  private update(patch:Partial<VoiceState>):void{this.state={...this.state,...patch};this.changed({...this.state});}
  private send(type:string,content:Record<string,unknown>):void{
    if(this.channel?.readyState==='open')this.channel.send(JSON.stringify({type,channelVersion:1,contentMessage:JSON.stringify(content)}));
  }
  private applyPeer(xuid:string):void{
    const peer=this.peers.get(xuid);if(!peer)return;
    const blocked=!peer.allowed,muted=blocked||peer.muted;
    this.send('BlockState',{messageVersion:1,blocked,xuid});this.send('MuteState',{messageVersion:1,muted,xuid});
    const transceiver=this.pc?.getTransceivers().find(t=>t.mid===peer.mid);
    if(transceiver && transceiver.receiver.track.kind==='audio')transceiver.receiver.track.enabled=!muted;
  }
  private async privacy(xuid:string):Promise<void>{
    const peer=this.peers.get(xuid);if(!peer)return;
    const generation=this.generation,version=++peer.privacyVersion;peer.allowed=false;this.applyPeer(xuid);
    const allowed=await this.api.xboxVoiceAllowed(xuid).catch(()=>false);
    if(generation!==this.generation||this.peers.get(xuid)!==peer||version!==peer.privacyVersion)return;
    peer.allowed=allowed;this.applyPeer(xuid);
  }
  mutePeer(xuid:string,muted:boolean):void{if(muted)this.mutedPeers.add(xuid);else this.mutedPeers.delete(xuid);const peer=this.peers.get(xuid);if(peer){peer.muted=muted;this.applyPeer(xuid);}}
  private async complete(generation:number):Promise<void>{
    if(generation!==this.generation||!this.partyId||this.confirming||!this.relayConnected||this.pc?.connectionState!=='connected'||this.channel?.readyState!=='open')return;
    this.confirming=true;
    try{await this.api.confirmXboxParty(this.partyId);if(generation!==this.generation)return;
      clearTimeout(this.timer);this.update({connected:true});
    }catch{await this.failed(generation,'Xbox could not confirm the party connection.');}
  }
  async start(partyId?:string):Promise<void>{
    return this.connect(partyId);
  }
  async accept(inviteId:string):Promise<void>{return this.connect(undefined,inviteId);}
  private async connect(partyId?:string,inviteId?:string):Promise<void>{
    this.closeMedia();const generation=this.generation;
    this.update({connected:false,muted:true,error:undefined,audioBlocked:false});
    try{
      const pc=new RTCPeerConnection({});this.pc=pc;
      this.context=new AudioContext();this.silence=this.context.createMediaStreamDestination().stream;
      const channel=pc.createDataChannel('control',{ordered:true,protocol:'controlV1'});this.channel=channel;
      channel.onopen=()=>{if(generation!==this.generation)return;this.send('SessionConfiguration',{messageVersion:1,useSessionDocumentForPrivacy:false});void this.complete(generation);};
      channel.onclose=()=>{if(generation===this.generation)void this.failed(generation,'Xbox party audio disconnected.');};
      channel.onmessage=event=>{
        if(generation!==this.generation||typeof event.data!=='string'||event.data.length>256*1024)return;
        try{
          const message=JSON.parse(event.data);if(message.channelVersion!==1)return;
          if(!['RelayConnectionState','PeerAdded','PeerRemoved','PrivacyChanged','CleanDisconnect'].includes(message.type))return;
          const content=JSON.parse(message.contentMessage);
          if(message.type==='RelayConnectionState'){
            this.relayConnected=content.state==='Connected';void this.complete(generation);
            if(!this.relayConnected&&this.state.connected)void this.failed(generation,'Xbox party relay disconnected.');
          }else if(message.type==='PeerAdded' && validXuid(content.xuid) && typeof content.transportSinkId==='string' && content.transportSinkId.length<=128){
            if([...this.peers.entries()].some(([id,peer])=>id!==content.xuid&&peer.mid===content.transportSinkId))throw Error('Duplicate audio transport.');
            const previous=this.peers.get(content.xuid);if(previous){previous.allowed=false;this.applyPeer(content.xuid);}
            this.peers.set(content.xuid,{mid:content.transportSinkId,allowed:false,muted:this.mutedPeers.has(content.xuid),privacyVersion:0});void this.privacy(content.xuid);
          }else if(message.type==='PeerRemoved' && validXuid(content.xuid)){
            const peer=this.peers.get(content.xuid);if(peer){peer.allowed=false;this.applyPeer(content.xuid);this.peers.delete(content.xuid);}
          }else if(message.type==='PrivacyChanged')for(const xuid of this.peers.keys())void this.privacy(xuid);
          else if(message.type==='CleanDisconnect')void this.failed(generation,'Xbox ended the party audio connection.');
        }catch{void this.failed(generation,'Xbox sent an invalid party audio message.');}
      };
      for(let i=0;i<15;i++){const t=pc.addTransceiver('audio',{direction:'recvonly'});t.receiver.track.enabled=false;}
      const outgoing=pc.addTransceiver('audio',{direction:'sendonly'});this.sender=outgoing.sender;
      await outgoing.sender.replaceTrack(this.silence.getAudioTracks()[0]);
      if(generation!==this.generation)return;
      const opus=RTCRtpSender.getCapabilities('audio')?.codecs.filter(c=>c.mimeType.toLowerCase().includes('opus'));
      if(opus?.length)outgoing.setCodecPreferences(opus);
      pc.ontrack=event=>{
        event.track.enabled=false;
        if(generation!==this.generation){event.track.stop();return;}
        const audio=document.createElement('audio');audio.autoplay=true;audio.srcObject=new MediaStream([event.track]);
        this.audio.set(event.transceiver.mid??event.track.id,audio);
        void audio.play().catch(()=>{if(generation===this.generation)this.update({audioBlocked:true});});
        for(const xuid of this.peers.keys())this.applyPeer(xuid);
      };
      pc.onconnectionstatechange=()=>{
        if(generation!==this.generation)return;
        if(pc.connectionState==='failed'||pc.connectionState==='closed')void this.failed(generation,'Xbox party audio disconnected.');
        else void this.complete(generation);
      };
      this.timer=setTimeout(()=>void this.failed(generation,'The Xbox party audio connection timed out.'),60_000);
      const description=await pc.createOffer();if(generation!==this.generation)return;
      await pc.setLocalDescription(description);if(generation!==this.generation)return;
      const bytes=crypto.getRandomValues(new Uint8Array(16));const cv=btoa(String.fromCharCode(...bytes)).replace(/=/g,'')+'.0';
      const offer=JSON.stringify({messageType:'transportConnectionRequestMessage',sdp:pc.localDescription!.sdp,cv,configuration:{control:{minVersion:1,maxVersion:1}}});
      const result=await (inviteId?this.api.acceptXboxPartyInvite(offer,inviteId):this.api.startXboxParty(offer,partyId));if(generation!==this.generation)return;
      this.partyId=result.id;
      await pc.setRemoteDescription({type:result.answer.sdpType,sdp:result.answer.sdp});
      if(generation!==this.generation)return;
      for(const candidate of result.answer.iceCandidates){await pc.addIceCandidate({...candidate,candidate:candidate.candidate==='a=end-of-candidates'?'':candidate.candidate});if(generation!==this.generation)return;}
      this.privacyTimer=setInterval(()=>{for(const xuid of this.peers.keys())void this.privacy(xuid);},60_000);
      void this.complete(generation);
    }catch(error){await this.failed(generation,error instanceof Error?error.message:'Xbox party audio could not connect.');throw error;}
  }
  async setMuted(muted:boolean):Promise<void>{
    const version=++this.microphoneVersion;
    if(muted){this.microphone?.getTracks().forEach(t=>t.stop());this.microphone=undefined;
      await this.sender?.replaceTrack(this.silence?.getAudioTracks()[0]??null);if(version===this.microphoneVersion)this.update({muted:true});return;}
    if(!this.state.connected||!this.sender)throw Error('Connect a party before enabling the microphone.');
    const generation=this.generation;await this.api.allowXboxMicrophone();
    if(generation!==this.generation||version!==this.microphoneVersion||!this.sender)throw Error('The party disconnected before microphone capture started.');
    const microphone=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true},video:false});
    try{
      if(generation!==this.generation||version!==this.microphoneVersion||!this.sender)throw Error('The party disconnected before microphone capture started.');
      await this.sender.replaceTrack(microphone.getAudioTracks()[0]);
      if(generation!==this.generation||version!==this.microphoneVersion)throw Error('The party disconnected while enabling the microphone.');
      this.microphone?.getTracks().forEach(t=>t.stop());this.microphone=microphone;this.update({muted:false});
    }catch(error){microphone.getTracks().forEach(t=>t.stop());throw error;}
  }
  async resumeAudio():Promise<void>{
    await this.context?.resume();await Promise.all([...this.audio.values()].map(audio=>audio.play()));this.update({audioBlocked:false});
  }
  private async failed(generation:number,error:string):Promise<void>{
    if(generation!==this.generation)return;this.closeMedia();this.update({connected:false,muted:true,error});
    await this.api.leaveXboxParty().catch(()=>{});
  }
  closeMedia():void{
    this.state={...this.state,connected:false,muted:true};
    this.generation++;this.microphoneVersion++;clearTimeout(this.timer);clearInterval(this.privacyTimer);
    this.microphone?.getTracks().forEach(t=>t.stop());this.microphone=undefined;
    this.silence?.getTracks().forEach(t=>t.stop());this.silence=undefined;
    for(const audio of this.audio.values()){audio.pause();audio.srcObject=null;}this.audio.clear();this.peers.clear();this.mutedPeers.clear();
    this.channel?.close();this.channel=undefined;this.pc?.close();this.pc=undefined;this.sender=undefined;
    void this.context?.close().catch(()=>{});this.context=undefined;this.partyId=undefined;this.relayConnected=false;this.confirming=false;
  }
  async leave():Promise<void>{this.closeMedia();this.update({connected:false,muted:true});await this.api.leaveXboxParty();}
}
