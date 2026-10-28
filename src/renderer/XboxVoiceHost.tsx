import {useEffect} from 'react';
import type {XboxVoiceApi,XboxVoiceCommand,XboxVoiceHostApi,XboxVoiceState} from '../shared/types';
import {XboxVoice,type VoiceState} from './xbox-voice';

/** Media lives here once per Nexus process, independently of any guide's lifetime. */
export function XboxVoiceHost({api}:{api:XboxVoiceApi&XboxVoiceHostApi}){
  useEffect(()=>{
    let alive=true,received=false;
    let state:VoiceState={connected:false,muted:true,audioBlocked:false},selfXuid:string|undefined;const muted=new Set<string>(),members=new Set<string>();
    const publish=()=>{if(alive){const error=state.error?.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,1024);const value:XboxVoiceState={connected:state.connected,muted:state.muted,audioBlocked:state.audioBlocked,mutedMembers:[...muted],...(error?{error}:{})};void api.publishXboxVoiceHostState(value).catch(()=>{});}};
    const voice=new XboxVoice(api,value=>{state=value;if(!value.connected)muted.clear();publish();});
    const sync=(party:Awaited<ReturnType<XboxVoiceApi['getXboxParty']>>)=>{
      if(!alive)return;
      members.clear();for(const member of party.members)members.add(member.xuid);selfXuid=party.selfXuid;
      for(const id of muted)if(!members.has(id))muted.delete(id);
      if(party.phase==='idle'||party.phase==='error'||party.phase==='leaving'){
        voice.closeMedia();muted.clear();const error=party.error??state.error;state={connected:false,muted:true,audioBlocked:false,...(error?{error}:{})};publish();
      }else publish();
    };
    const unsubscribeParty=api.onXboxPartyState(party=>{received=true;sync(party);});
    void api.getXboxParty().then(party=>{if(!received)sync(party);},()=>{});
    async function run(command:XboxVoiceCommand){
      if(!alive)throw Error('Xbox party media is closing.');
      switch(command.type){
        case 'start':await voice.start(command.partyId);if(state.error)throw Error(state.error);break;
        case 'accept':await voice.accept(command.inviteId);if(state.error)throw Error(state.error);break;
        case 'setMuted':await voice.setMuted(command.muted);break;
        case 'mute':if(!members.has(command.xuid)||command.xuid===selfXuid)throw Error('That player is not a remote member of this party.');voice.mutePeer(command.xuid,command.muted);if(command.muted)muted.add(command.xuid);else muted.delete(command.xuid);publish();break;
        case 'leave':await voice.leave();break;
        case 'resume':await voice.resumeAudio();break;
      }
    }
    const unsubscribeCommands=api.onXboxVoiceHostCommand(request=>{
      void run(request.command).then(()=>api.completeXboxVoiceHostCommand(request.id),error=>api.completeXboxVoiceHostCommand(request.id,
        (error instanceof Error?error.message:'Xbox voice command failed.').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,1024))).catch(()=>{});
    });
    publish();void api.xboxVoiceHostReady().catch(()=>voice.closeMedia());
    return()=>{alive=false;unsubscribeCommands();unsubscribeParty();voice.closeMedia();};
  },[api]);
  return null;
}
