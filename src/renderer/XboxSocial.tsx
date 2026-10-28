import {ui} from './i18n';
import type {GameInviteState} from '../shared/game-invites';
import {XboxRuntimeInvites,type RuntimeInviteApi} from './XboxRuntimeInvites';
import {useEffect,useRef,useState} from 'react';
import {ArrowLeft,ExternalLink,Headset,LoaderCircle,Plus} from 'lucide-react';
import type {AuthStatus,XboxConversation,XboxFriend,XboxSocialApi,XboxPartyControlApi,XboxProfileRequest,XboxPlayerProfile} from '../shared/types';
import {XboxChat} from './XboxChat';
import {XboxPartyPanel} from './XboxPartyPanel';
import {XboxPlayerCard} from './XboxPlayerCard';
import {XboxAvatar,XboxGamertag} from './XboxAvatar';
import {XboxSocialIcon} from './XboxSocialIcons';
import {XboxPeopleBrowser} from './XboxPeopleBrowser';
import {InboxProfiles} from './inbox-profiles';
import {messageNoticeKey} from './notification-state';
import {FriendsRefresh} from './friends-refresh';
export {SocialFriends} from './XboxPeopleBrowser';
import './xbox-social.css';

const error=(value:unknown)=>value instanceof Error?value.message.replace(/^Error invoking remote method '[^']+': Error: /,''):'Xbox social is unavailable. Try again.';

export function XboxSocial({auth,api,voice,overlay=false,shelf=false,close,openOverlay,showProfile,expanded=false,runtimeInvites,runtimeApi,active=true,openChat,readKeys=[],onViewed}:{auth:AuthStatus;api:XboxSocialApi;voice?:XboxPartyControlApi;overlay?:boolean;shelf?:boolean;close?:()=>void;openOverlay?:()=>void;showProfile?:XboxProfileRequest;expanded?:boolean;runtimeInvites?:GameInviteState;runtimeApi?:RuntimeInviteApi;active?:boolean;openChat?:{id:number;xuid:string};readKeys?:readonly string[];onViewed?:(peer:string,ids:string[])=>void}){
 const [tab,setTab]=useState<'friends'|'chats'|'party'>('friends');
 const [friends,setFriends]=useState<XboxFriend[]>([]),[inbox,setInbox]=useState<XboxConversation[]>([]);
 const [selected,setSelected]=useState<string>();
 const [busy,setBusy]=useState(false),[problem,setProblem]=useState<string>();
 const [choosingChat,setChoosingChat]=useState(false);
 const [profile,setProfile]=useState<{xuid:string;request?:string}>();
 const [profiles,setProfiles]=useState<Record<string,XboxPlayerProfile>>({});
 const [partyRecipient,setPartyRecipient]=useState<{xuid:string;gamertag:string}>();
 const generation=useRef(0);
 const identity=auth.stored===true&&!auth.running?auth.username:undefined;
 const selectedPerson=friends.find(person=>person.xuid===selected);
 const selectedConversation=inbox.find(row=>row.participants.includes(selected??''));
 const selectedName=selectedPerson?.gamertag??selectedConversation?.gamertag??'Xbox player';

 useEffect(()=>{
  generation.current++;setProfiles({});setPartyRecipient(undefined);setFriends([]);setInbox([]);setSelected(undefined);setProfile(showProfile?{xuid:showProfile.xuid}:undefined);setProblem(undefined);setBusy(false);
  return()=>{generation.current++;};
 },[identity]);
 useEffect(()=>{
  if(!openChat||!identity||!active)return;
  setSelected(openChat.xuid);setProfile(undefined);setProblem(undefined);setChoosingChat(false);
 },[openChat?.id,identity]);
 useEffect(()=>{
  if(!showProfile)return;
  generation.current++;setProfile(current=>({xuid:showProfile.xuid,...(current?.xuid===showProfile.xuid&&current.request?{request:current.request}:{})}));setProblem(undefined);setBusy(false);
 },[showProfile?.id,showProfile?.xuid]);
 useEffect(()=>{
  if(!overlay||!identity||!api.onXboxProfileRequest||!api.getXboxProfileRequest)return;
  let alive=true,received=false;
  const accept=(request:XboxProfileRequest|undefined)=>{if(alive)setProfile(request?{xuid:request.xuid,request:request.id}:undefined);};
  const unsubscribe=api.onXboxProfileRequest(request=>{received=true;accept(request);});
  void api.getXboxProfileRequest().then(request=>{if(request&&!received)accept(request);}).catch(()=>{});
  return()=>{alive=false;unsubscribe();};
 },[api,overlay,identity]);
 const closeProfile=(hide=true)=>{if(profile?.request)void api.completeXboxProfileRequest?.(profile.request,hide).catch(()=>{});setProfile(undefined);};
 const chooseChat=(id:string)=>{setSelected(id);setProblem(undefined);setChoosingChat(false);};
 const changeTab=(next:typeof tab)=>{setTab(next);setSelected(undefined);setChoosingChat(false);setProblem(undefined);};
 const back=()=>{if(profile)closeProfile();else{setSelected(undefined);setChoosingChat(false);setProblem(undefined);}};

 async function refresh(){
  if(!identity||!active)return true;
  const current=++generation.current;setBusy(true);setProblem(undefined);
  try{
   if(profile||selected)return true;
   if(tab==='friends'||choosingChat){const value=await api.getXboxFriends();if(current===generation.current)setFriends(value);}
   else if(tab==='chats'){const value=await api.getXboxInbox();if(current===generation.current)setInbox(value);}
   return true;
  }catch(e){if(current===generation.current)setProblem(error(e));return false;}
  finally{if(current===generation.current)setBusy(false);}
 }
 useEffect(()=>{void refresh();},[identity,tab,selected,profile,choosingChat,active]);
 useEffect(()=>{
  if(!identity||!active||tab==='party'||profile||selected)return;
  const polling=new FriendsRefresh(refresh,()=>document.visibilityState==='visible',tab==='chats'?20000:60000);
  polling.start();return()=>polling.stop();
 },[identity,tab,selected,profile,choosingChat,active]);
 useEffect(()=>{
  if(!identity||!active||selected||profile||tab!=='chats')return;
  const loader=new InboxProfiles(id=>api.getXboxPlayerProfile(id),value=>setProfiles(previous=>({...previous,[value.xuid]:value})));
  const ids=inbox.filter(row=>row.type==='OneToOne'&&row.participants.length===1).map(row=>row.participants[0]).filter(id=>!friends.some(friend=>friend.xuid===id)&&!profiles[id]);
  void loader.start(ids);return()=>loader.stop();
 },[identity,api,active,inbox,selected,profile,tab]);
 const detail=Boolean(profile||selected||choosingChat);
 return <section className={'xbox-social xbox-guide'+(overlay||shelf?' social-overlay':'')+(expanded?' social-expanded-view':'')+(profile?' has-profile':'')} aria-label={ui("social.xbox_social_9dd063")}>
  {!profile?<header className="social-guide-chrome">
   {detail?<button className="social-circle-button social-back" onClick={back} aria-label={profile?'Close player profile':'Back to Xbox friends'}><ArrowLeft/></button>:null}
   <h1 className="social-sr-only">{ui("social.xbox_social_9dd063")}</h1><span className="social-chrome-spacer"/>
   {openOverlay?<button className="social-circle-button" onClick={openOverlay} title={ui("social.open_xbox_social_desktop_window_and_party_audio_2fb371")} aria-label={ui("social.open_xbox_social_window_940467")}><ExternalLink/></button>:null}
   {close?<button className="social-circle-button social-close" onClick={close} aria-label={ui("social.close_xbox_social_d9a718")}><XboxSocialIcon name="close"/></button>:null}
  </header>:null}
  {!identity?<p className="social-notice">{ui("social.sign_in_through_nexus_settings_to_load_friends_and_mess_134b98")}</p>:<>
   {!detail?<nav className="social-tabs" role="tablist" aria-label={ui("social.xbox_social_9dd063")}>
    {voice?<button role="tab" aria-selected={tab==='party'} aria-label={ui("social.party_dfa82f")} title={ui("social.party_dfa82f")} onClick={()=>changeTab('party')}><Headset/></button>:null}
    <button role="tab" aria-selected={tab==='friends'} aria-label={ui("social.people_7db208")} title={ui("social.people_7db208")} onClick={()=>changeTab('friends')}><XboxSocialIcon name="people"/></button>
    <button role="tab" aria-selected={tab==='chats'} aria-label={ui("social.chats_ef5b40")} title={ui("social.chats_ef5b40")} onClick={()=>changeTab('chats')}><XboxSocialIcon name="chat"/></button>
    <button role="tab" aria-selected={false} aria-label={'Your Xbox profile'+(auth.gamertag?', '+auth.gamertag:'')} title={ui("social.your_xbox_profile_95979b")} onClick={()=>setProfile({xuid:'me'})}><XboxAvatar src={auth.avatarDataUrl} name={auth.gamertag}/></button>
   </nav>:null}
   <XboxRuntimeInvites state={runtimeInvites} api={runtimeApi} friends={friends}/>
   <div className={'social-guide-content'+(profile?' profile-content':'')} aria-busy={busy}>
    {profile?<XboxPlayerCard api={api} account={identity} expanded={expanded} xuid={profile.xuid} person={friends.find(p=>p.xuid===profile.xuid)} ownAvatar={profile.xuid==='me'?auth.avatarDataUrl:undefined} back={()=>closeProfile()} close={close}
     changed={()=>{const current=generation.current;void api.getXboxFriends().then(value=>{if(current===generation.current)setFriends(value);}).catch(()=>{});}}
     chat={()=>{const id=profile.xuid;closeProfile(false);chooseChat(id);}}
     party={voice?player=>{const id=profile.xuid;closeProfile(false);setSelected(undefined);setPartyRecipient({xuid:id,gamertag:player.gamertag});changeTab('party');}:undefined}/>:null}
    {selected?<div className="social-inline-chat" style={{display:profile?'none':'flex',flex:1,minHeight:0}}>
     <XboxChat api={api} account={identity} xuid={selected} displayName={selectedName} active={active&&!profile} onViewed={onViewed} openProfile={id=>setProfile({xuid:id})}
      popOut={api.popOutXboxChat?()=>{void api.popOutXboxChat?.(selected).catch(e=>setProblem(error(e)));}:undefined}/>
    </div>:null}
    {!profile&&!selected&&(tab==='friends'||choosingChat)?<XboxPeopleBrowser key={identity} api={api} account={identity} friends={friends} friendsChanged={setFriends} choosingChat={choosingChat}
     openProfile={id=>{setProfile({xuid:id});setProblem(undefined);}} chooseChat={chooseChat}
     party={voice?person=>{setPartyRecipient({xuid:person.xuid,gamertag:person.gamertag});changeTab('party');}:undefined}/>:null}
    {!profile&&!selected&&!choosingChat&&tab==='chats'?<div className="social-chats-pane">
     <div className="social-page-heading"><h2>{ui("social.chats_ef5b40")}</h2><button className="social-circle-button" onClick={()=>{setChoosingChat(true);}} aria-label={ui("social.new_chat_db1838")} title={ui("social.new_chat_db1838")}><Plus/></button></div>
     <div className="social-inbox">{inbox.map(item=>{const recipient=item.participants.length===1?item.participants[0]:undefined;const person=friends.find(p=>p.xuid===recipient)??(recipient?profiles[recipient]:undefined);const name=person?.gamertag??item.gamertag??ui('notifications.player');
      const unread=item.unread&&(!recipient||!item.lastMessage||!readKeys.includes(messageNoticeKey(recipient,item.lastMessage.id)));
      return <button className={'social-conversation'+(unread?' unread':'')} key={item.id} disabled={!recipient||item.type!=='OneToOne'} onClick={()=>{if(recipient)chooseChat(recipient);}}>
       <XboxAvatar src={person?.avatarUrl??item.avatarUrl} name={name}/><span><strong><XboxGamertag name={name}/></strong><small>{item.lastMessage?.hidden?ui('ui.message_hidden_or_unsupported_d199cb4'):item.lastMessage?.text||ui('social.no_message_preview')}</small></span>{unread?<span className="unread-dot" aria-label={ui("social.unread_1b9f38")}/>:null}
      </button>;})}</div>{!busy&&!problem&&!inbox.length?<p className="social-empty">{ui("social.no_conversations_in_your_primary_inbox_7a7411")}</p>:null}
    </div>:null}
    {voice?<XboxPartyPanel api={voice} friends={friends} invitee={partyRecipient} hidden={!active||tab!=='party'||Boolean(selected)||Boolean(profile)||choosingChat}/>:null}
    {problem?<p className="social-error" role="alert">{problem}</p>:null}
    {busy&&!profile&&!selected&&tab!=='friends'&&!choosingChat?<div className="social-loading" role="status"><LoaderCircle className="spin"/><span>{ui("ui.loading_ba3bbbe")}</span></div>:null}
   </div>
  </>}
 </section>;
}
