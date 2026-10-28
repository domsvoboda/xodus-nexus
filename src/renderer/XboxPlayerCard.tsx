import {ui} from './i18n';
import {useEffect,useState} from 'react';
import {ArrowLeft,ExternalLink,LoaderCircle,MapPin,RefreshCw} from 'lucide-react';
import type {XboxFriend,XboxPlayerDetails,XboxPlayerProfile,XboxSocialApi} from '../shared/types';
import {XboxAvatar,XboxGamertag,xboxGamerpicSource} from './XboxAvatar';
import {XboxSocialIcon} from './XboxSocialIcons';
import {XboxPlayerActions} from './XboxPlayerActions';
import {XboxProfileGames} from './XboxProfileGames';

export function XboxPlayerCard({api,account,xuid,person,ownAvatar,chat,party,back,close,expanded=false,changed}:{
 api:XboxSocialApi;account:string;xuid:string;person?:XboxFriend;ownAvatar?:string;chat:()=>void;party?:(player:XboxPlayerProfile)=>void;back:()=>void;close?:()=>void;expanded?:boolean;changed?:()=>void;
}){
 const [profile,setProfile]=useState<XboxPlayerDetails>(),[error,setError]=useState<string>(),[revision,setRevision]=useState(0);
 useEffect(()=>{
  let alive=true;setProfile(undefined);setError(undefined);
  void api.getXboxPlayerDetails(xuid).then(value=>{if(alive)setProfile(value);},()=>{if(alive)setError('Xbox could not load this player’s profile. Their privacy settings may limit the details available.');});
  return()=>{alive=false;};
 },[api,account,xuid,revision]);
 const avatar=profile?.avatarUrl??person?.avatarUrl??ownAvatar;
 const name=profile?.gamertag??person?.gamertag??'Xbox player';
 const own=xuid==='me'||profile?.isSelf===true;
 const relationship=profile?.relationship;
 return <section className={'social-player-card'+(expanded?' social-player-expanded':'')} aria-label={ui("social.xbox_player_profile_b05c1d")}>
  {avatar?<div className="social-profile-backdrop" style={{backgroundImage:'url('+JSON.stringify(xboxGamerpicSource(avatar,208))+')'}}/>:null}
  <header className="social-guide-chrome">
   <button className="social-circle-button social-back" onClick={back} aria-label={ui("social.back_to_xbox_people_607d53")}><ArrowLeft/></button><span className="social-chrome-spacer"/>
   {!expanded?<button className="social-circle-button" onClick={()=>void api.openXboxPlayerProfile(xuid).catch(()=>setError('The full profile window could not be opened.'))} aria-label={ui("social.open_full_xbox_profile_640631")} title={ui("social.open_full_profile_e4a83a")}><ExternalLink/></button>:null}
   {close?<button className="social-circle-button social-close" onClick={close} aria-label={ui("social.close_xbox_social_d9a718")}><XboxSocialIcon name="close"/></button>:null}
  </header>
  <div className="social-profile-scrollable">
   {profile?<>
    <div className="social-profile-hero">
     <XboxAvatar src={avatar} name={name} size={expanded?208:128} className="social-profile-picture"/>
     <div className="social-profile-identity"><h2><XboxGamertag name={name}/></h2>{person?.presence?<p>{person.presence}</p>:null}{relationship?.blocked?<p>{ui("social.blocked_18f2a0")}</p>:null}</div>
    </div>
    <div className="social-profile-details">
     {(relationship?relationship.isFriend:Boolean(person))?<span><XboxSocialIcon name="people"/>{ui("social.friend_acd8f6")}{relationship?.favorite||person?.favorite?' · Favourite':''}</span>:null}
     {profile.gamerscore!==null?<span aria-label={profile.gamerscore+' Gamerscore'}><b className="social-score-icon" aria-hidden="true">G</b>{profile.gamerscore}</span>:null}
    </div>
    <div className="social-profile-columns">
     <div className="social-profile-about">
      {profile.bio||profile.location?<section><h3>{ui("social.about_4efca0")}</h3>{profile.bio?<p className="social-profile-bio">{profile.bio}</p>:null}{profile.location?<p className="social-profile-location"><MapPin/>{profile.location}</p>:null}</section>:null}
      {profile.counts&&Object.keys(profile.counts).length?<section className="social-profile-counts" aria-label={ui("social.xbox_connections_ed8f74")}>
       {(['friends','followers','following'] as const).map(key=>profile.counts?.[key]===undefined?null:<div key={key}><strong>{profile.counts[key]!.toLocaleString()}</strong><span>{key==='friends'?'Friends':key==='followers'?'Followers':'Following'}</span></div>)}
      </section>:null}
      {!profile.bio&&!profile.location&&!profile.counts&&expanded?<p className="social-profile-private">{ui("social.xbox_hasn_t_shared_additional_profile_details_for_this_a223b6")}</p>:null}
      {expanded?<XboxProfileGames api={api} xuid={profile.xuid}/>:null}
     </div>
     {!own?<XboxPlayerActions key={profile.xuid} api={api} account={account} xuid={profile.xuid} gamertag={name} chat={chat} party={party?()=>party(profile):undefined} fullProfile={!expanded} changed={()=>{changed?.();setRevision(value=>value+1);}}/>:null}
    </div>
   </>:error?<div><p role="alert" className="social-error">{error}</p><button className="social-menu-action" onClick={()=>setRevision(value=>value+1)}><RefreshCw/>{ui("social.try_again_d8b839")}</button></div>:<p className="social-loading"><LoaderCircle className="spin"/>{ui("social.loading_xbox_profile_ffd580")}</p>}
  </div>
 </section>;
}
