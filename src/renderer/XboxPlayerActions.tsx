import {ui} from './i18n';
import {useEffect,useRef,useState} from 'react';
import {Ban,Check,ExternalLink,Gamepad2,Headset,LoaderCircle,MessageCircle,RefreshCw,Star,UserMinus,UserPlus,X} from 'lucide-react';
import type {XboxGameInviteAvailability,XboxRelationship,XboxRelationshipAction,XboxSocialApi} from '../shared/types';
import {watchGameInviteAvailability} from './game-invite-availability';

const failure=(value:unknown)=>value instanceof Error?value.message.replace(/^Error invoking remote method '[^']+': Error: /,''):'Xbox could not complete this action.';
export function xboxRelationshipOptions(value:XboxRelationship):{action:XboxRelationshipAction;label:string;confirm?:boolean}[]{
 if(value.blocked)return [{action:'unblock',label:'Unblock'}];
 const options:{action:XboxRelationshipAction;label:string;confirm?:boolean}[]=[];
 if(value.isFriend)options.push({action:'remove-friend',label:'Remove friend',confirm:true},{action:value.favorite?'unfavorite':'favorite',label:value.favorite?'Remove from favourites':'Add to favourites'});
 else if(value.requestState==='incoming')options.push({action:'accept-request',label:'Accept friend request'},{action:'decline-request',label:'Decline friend request'});
 else if(value.requestState==='outgoing')options.push({action:'cancel-request',label:'Cancel friend request'});
 else if(value.requestState==='none')options.push({action:'send-request',label:'Add friend'});
 options.push({action:'block',label:'Block',confirm:true});return options;
}
export function xboxPlayerOptions(relationship:XboxRelationship|undefined,listedBlocked:boolean){
 return relationship?xboxRelationshipOptions(relationship):listedBlocked?[{action:'unblock' as const,label:'Unblock',confirm:false}]:[];
}
const actionIcon=(action:XboxRelationshipAction)=>action==='block'||action==='unblock'?<Ban/>:action==='favorite'||action==='unfavorite'?<Star/>:action==='remove-friend'?<UserMinus/>:action==='accept-request'?<Check/>:action==='send-request'?<UserPlus/>:<X/>;
const completed:Record<XboxRelationshipAction,string>={
 'send-request':'Friend request sent.','accept-request':'Friend request accepted.','cancel-request':'Friend request cancelled.','decline-request':'Friend request declined.',
 'remove-friend':'Friend removed.','favorite':'Added to favourites.','unfavorite':'Removed from favourites.','block':'Player blocked.','unblock':'Player unblocked.',
};

/** One explicit player action per click, with account-bound service requests. */
export function XboxPlayerActions({api,account,xuid,gamertag,chat,party,openProfile,changed,compact=false,fullProfile=true,listedBlocked=false}:{
 api:XboxSocialApi;account:string;xuid:string;gamertag:string;chat?:()=>void;party?:()=>void;openProfile?:()=>void;changed?:()=>void;compact?:boolean;fullProfile?:boolean;listedBlocked?:boolean;
}){
 const [relationship,setRelationship]=useState<XboxRelationship>(),[availability,setAvailability]=useState<XboxGameInviteAvailability>();
 const [loading,setLoading]=useState(true),[pending,setPending]=useState(false),[problem,setProblem]=useState<string>(),[note,setNote]=useState<string>();
 const [confirmation,setConfirmation]=useState<XboxRelationshipAction>(),[uncertain,setUncertain]=useState(false);
 const generation=useRef(0),working=useRef(false);
 const inviteRefresh=useRef<()=>Promise<void>>();
 const menuButton=compact?{role:'menuitem' as const}:{};
 async function refresh(){
  const current=++generation.current;setLoading(true);setProblem(undefined);setConfirmation(undefined);
  void inviteRefresh.current?.();
  try{const value=await api.getXboxRelationship(xuid);if(current===generation.current){setRelationship(value);setUncertain(false);}}
  catch(error){if(current===generation.current)setProblem(failure(error));}
  finally{if(current===generation.current)setLoading(false);}
 }
 useEffect(()=>{
  setRelationship(undefined);setAvailability(undefined);setPending(false);setNote(undefined);setUncertain(false);working.current=false;
  const watcher=watchGameInviteAvailability(()=>api.getXboxGameInviteAvailability(),setAvailability);inviteRefresh.current=watcher.refresh;
  void refresh();
  return()=>{watcher.stop();inviteRefresh.current=undefined;generation.current++;};
 },[api,account,xuid]);
 async function change(action:XboxRelationshipAction){
  if(working.current||uncertain)return;working.current=true;const current=generation.current;setPending(true);setProblem(undefined);setNote(undefined);setConfirmation(undefined);
  let confirmed=false;
  try{
   await api.changeXboxRelationship(account,xuid,action);if(current!==generation.current)return;
   confirmed=true;setNote(completed[action]);changed?.();
   const value=await api.getXboxRelationship(xuid);if(current===generation.current)setRelationship(value);
  }catch(error){if(current===generation.current){setProblem(confirmed?'Xbox confirmed the action, but its updated status could not be loaded. Refresh player status.':failure(error)+' This action was not retried. Refresh its status before trying again.');setUncertain(true);}}
  finally{if(current===generation.current){working.current=false;setPending(false);}}
 }
 async function invite(){
  if(working.current||!availability?.canInvite)return;working.current=true;const current=generation.current;setPending(true);setProblem(undefined);setNote(undefined);
  try{await api.sendXboxGameInvite(xuid);if(current===generation.current)setNote('Sending game invitation. Check its status in Friends.');}
  catch(error){if(current===generation.current)setProblem(failure(error)+' The invitation was not retried.');}
  finally{if(current===generation.current){working.current=false;setPending(false);}}
 }
 return <div className={'social-player-actions'+(compact?' is-context-menu':'')} aria-label={'Actions for '+gamertag}>
  {openProfile?<button {...menuButton} className="social-menu-action" onClick={openProfile}><UserPlus/><span>{ui("social.view_profile_d4788f")}</span></button>:null}
  {fullProfile?<button {...menuButton} className="social-menu-action" onClick={()=>void api.openXboxPlayerProfile(xuid).catch(error=>setProblem(failure(error)))}><ExternalLink/><span>{ui("social.open_full_profile_e4a83a")}</span></button>:null}
  {chat?<button {...menuButton} className="social-menu-action" disabled={relationship?.blocked||listedBlocked} onClick={chat}><MessageCircle/><span>{ui("social.send_message_93a26b")}</span></button>:null}
  {api.popOutXboxChat?<button {...menuButton} className="social-menu-action" disabled={relationship?.blocked||listedBlocked} onClick={()=>void api.popOutXboxChat?.(xuid).catch(error=>setProblem(failure(error)))}><ExternalLink/><span>{ui("social.pop_out_chat_b325ca")}</span></button>:null}
  <button {...menuButton} className="social-menu-action" disabled={pending||!availability?.canInvite||relationship?.blocked||listedBlocked} onClick={()=>void invite()} title={availability?.canInvite?availability.title:availability?.reason}><Gamepad2/><span>{ui("social.invite_to_game_1da866")}</span></button>
  {party?<button {...menuButton} className="social-menu-action" disabled={pending||relationship?.blocked||listedBlocked} onClick={party}><Headset/><span>{ui("social.invite_to_party_5a4c33")}</span></button>:null}
  {loading?<p className="social-action-status"><LoaderCircle className="spin"/>{ui("social.checking_relationship_81080d")}</p>:null}
  {xboxPlayerOptions(relationship,listedBlocked).map(option=><button {...menuButton} key={option.action} className="social-menu-action" disabled={pending||uncertain} onClick={()=>{if(option.confirm)setConfirmation(option.action);else void change(option.action);}}>{actionIcon(option.action)}<span>{option.label}</span></button>)}
  {!loading&&relationship?.requestState==='unknown'&&!relationship.isFriend&&!relationship.blocked?<p className="social-action-status">{ui("social.friend_request_status_unavailable_45f33b")}</p>:null}
  {confirmation?<div className="social-action-confirmation" role="group" aria-label={'Confirm '+confirmation}>
   <p>{confirmation==='block'?'Block '+gamertag+'? Xbox will prevent communication and invitations from this player.':'Remove '+gamertag+' from your Xbox friends?'}</p>
   <div><button {...menuButton} disabled={pending} onClick={()=>void change(confirmation)}>{confirmation==='block'?'Block player':'Remove friend'}</button><button {...menuButton} onClick={()=>setConfirmation(undefined)}>{ui("ui.cancel_19766ed")}</button></div>
  </div>:null}
  {pending?<p className="social-action-status" role="status"><LoaderCircle className="spin"/>{ui("social.updating_xbox_64469d")}</p>:null}
  {note?<p className="social-action-status" role="status">{note}</p>:null}
  {problem?<p className="social-error" role="alert">{problem}</p>:null}
  {!loading?<button {...menuButton} className="social-menu-action" disabled={pending} onClick={()=>void refresh()}><RefreshCw/><span>{ui("social.refresh_player_status_3699b2")}</span></button>:null}
 </div>;
}
