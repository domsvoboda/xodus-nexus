import {ui,uiText,useInterfaceLanguage} from './i18n';
import {emptyGameInvites,type GameInviteState} from '../shared/game-invites';
import type {RuntimeInviteApi} from './XboxRuntimeInvites';
import {useEffect,useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PanelLeftClose,PanelRightClose} from 'lucide-react';
import type {AuthStatus,XboxProfileRequest} from '../shared/types';
import {guidePartyApi} from './guide-party-api';
import {XboxSocial} from './XboxSocial';
import {XboxOverlayChat} from './XboxOverlayChat';
import {connectGuideEvents,guideApi,guideRpc,onGuideAuth,onGuideEvent} from './xbox-guide-api';
import {xboxOverlaySettings} from '../shared/xbox-overlay-settings';
import './xbox-guide.css';
import './xbox-overlay-chat.css';

function XboxGameGuide(){
 const [active,setActive]=useState(false),[language,setLanguage]=useState<string>();
 useInterfaceLanguage(language);
 const [runtimeInvites,setRuntimeInvites]=useState<GameInviteState>(emptyGameInvites);
 const runtimeApi=useMemo<RuntimeInviteApi>(()=>({chooseGameInviteRecipient:(id,xuid)=>guideRpc('chooseGameInviteRecipient',id,xuid),cancelGameInvite:id=>guideRpc('cancelGameInvite',id),acceptGameInvite:id=>guideRpc('acceptGameInvite',id)}),[]);
 const [auth,setAuth]=useState<AuthStatus>({running:true,stored:null,note:'Connecting Nexus Guide…'});
 const [problem,setProblem]=useState<string>(),[expanded,setExpanded]=useState(false),[profile,setProfile]=useState<XboxProfileRequest>();
 const [overlay,setOverlay]=useState(()=>xboxOverlaySettings({}));
 const [chats,setChats]=useState<string[]>([]),chatIds=useRef<string[]>([]),navigation=useRef(0);
 const close=()=>{void guideRpc('closeXboxGuide').catch(()=>{});};
 const api=useMemo(()=>({...guideApi,
  openXboxPlayerProfile:async(xuid:string)=>{setProfile({id:'guide-'+(++navigation.current),xuid});setExpanded(true);},
  popOutXboxChat:async(xuid:string)=>{
   if(!/^[1-9][0-9]{0,19}$/.test(xuid)||BigInt(xuid)>18446744073709551615n)throw Error('Select an Xbox player to open chat.');
   if(!chatIds.current.includes(xuid)&&chatIds.current.length>=8)throw Error('Close a chat window before opening another.');
   const next=[...chatIds.current.filter(id=>id!==xuid),xuid];chatIds.current=next;setChats(next);
  },
 }),[]);
 useEffect(()=>{
  const unsubscribe=onGuideAuth(setAuth),disconnect=connectGuideEvents(setProblem);
  const profiles=guideApi.onXboxProfileRequest(request=>{if(request){setExpanded(false);setProfile(undefined);}});
  const invitations=onGuideEvent('runtimeInvites',value=>setRuntimeInvites(value??emptyGameInvites()));
  const preferences=onGuideEvent('overlay',value=>setOverlay(xboxOverlaySettings(value??{})));
  const visibility=onGuideEvent('visibility',value=>setActive(value===true));
  const languages=onGuideEvent('language',value=>setLanguage(typeof value==='string'?value:undefined));
  return()=>{unsubscribe();profiles();preferences();invitations();visibility();languages();disconnect();};
 },[]);
 useEffect(()=>{setChats([]);chatIds.current=[];setProfile(undefined);setExpanded(false);},[auth.username]);
 const account=auth.stored===true&&!auth.running?auth.username:undefined;
 return <main className={'game-guide-shell'+(overlay.overlaySide==='right'?' is-right':'')} aria-label={ui("social.in_game_xbox_guide_b68219")}>
  <div className={'game-guide-panel'+(expanded?' is-expanded':'')}>
   {expanded?<div className="game-guide-full-toolbar"><button onClick={()=>setExpanded(false)}>{overlay.overlaySide==='right'?<PanelRightClose/>:<PanelLeftClose/>}{ui("social.return_to_shelf_4df4fc")}</button><span>{ui("social.xbox_social_9dd063")}</span></div>:null}
   <XboxSocial key={auth.username} auth={auth} api={api} voice={guidePartyApi} active={active} runtimeInvites={runtimeInvites} runtimeApi={runtimeApi} overlay expanded={expanded} showProfile={profile} close={close}/>
   {problem?<p className="game-guide-error" role="alert">{uiText(problem)}</p>:null}
   <footer><span>{ui("social.xbox_guide_31c52d")}</span><span>{overlay.overlayShortcut} {ui("social._esc_back_to_game_a58ed5")}</span></footer>
  </div><button className="game-guide-dismiss" aria-label={ui("social.return_to_game_1d6ce9")} onClick={close}/>
  {account?chats.map((xuid,index)=><XboxOverlayChat key={account+':'+xuid} api={api} active={active} account={account} xuid={xuid} index={index} side={overlay.overlaySide}
   close={()=>{const next=chatIds.current.filter(id=>id!==xuid);chatIds.current=next;setChats(next);}}
   raise={()=>{if(chatIds.current.at(-1)!==xuid){const next=[...chatIds.current.filter(id=>id!==xuid),xuid];chatIds.current=next;setChats(next);}}}
   openProfile={id=>{void api.openXboxPlayerProfile(id);}}/>):null}
 </main>;
}
createRoot(document.getElementById('root')!).render(<XboxGameGuide/>);
