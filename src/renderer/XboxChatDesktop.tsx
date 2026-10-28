import {useEffect,useState} from 'react';
import type {AppSnapshot} from '../shared/types';
import {XboxChat} from './XboxChat';
import {ui,useInterfaceLanguage} from './i18n';
import {watchChatDesktop} from './chat-desktop-snapshot';
import './xbox-social.css';

export function XboxChatDesktop({xuid}:{xuid:string}){
 const [snapshot,setSnapshot]=useState<AppSnapshot>(),[problem,setProblem]=useState<'account'|'close'|'profile'>();
 const [active,setActive]=useState(()=>typeof document==='undefined'||document.visibilityState==='visible');
 useInterfaceLanguage(snapshot?.settings.interfaceLanguage);
 useEffect(()=>watchChatDesktop(window.launcher,value=>{setSnapshot(value);setProblem(undefined);},()=>setProblem('account')),[]);
 useEffect(()=>{
  const visible=()=>setActive(document.visibilityState==='visible');visible();document.addEventListener('visibilitychange',visible);
  return()=>document.removeEventListener('visibilitychange',visible);
 },[]);
 const auth=snapshot?.auth;
 const account=auth?.stored===true&&!auth.running?auth.username:undefined;
 const binary=snapshot?.backend.binaryPath;
 const supported=Boolean(snapshot?.backend.available&&snapshot.backend.capabilities.nativeSocial&&binary);
 const problems={account:ui('social.desktop_account_failed'),close:ui('social.desktop_close_failed'),profile:ui('social.desktop_profile_failed')};
 return <main className="xbox-social xbox-guide social-overlay xbox-chat-desktop">
  {account&&supported?<XboxChat key={JSON.stringify([account,binary])} api={window.launcher.nativeSocial} account={account} xuid={xuid} active={active}
   onViewed={(peer,ids)=>{void window.launcher.viewedXboxChat(account,binary!,peer,ids).catch(()=>{/* Notifications are optional, never retry or mark on the server. */});}}
   close={()=>{void window.launcher.closeXboxChat().catch(()=>setProblem('close'));}}
   openProfile={id=>{void window.launcher.nativeSocial.openXboxPlayerProfile(id).catch(()=>setProblem('profile'));}}/>:
   <p className="social-notice" role="status">{problem?problems[problem]:!auth?ui('social.desktop_loading'):!account?ui('social.desktop_sign_in'):ui('social.desktop_backend_required')}</p>}
  {problem&&account&&supported?<p role="alert" className="social-error">{problems[problem]}</p>:null}
 </main>;
}
