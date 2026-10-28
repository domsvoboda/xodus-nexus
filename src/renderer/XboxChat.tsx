import {ui,uiText} from './i18n';
import {useEffect,useId,useLayoutEffect,useRef,useState,type KeyboardEvent} from 'react';
import {ExternalLink,LoaderCircle,RefreshCw,Send,X} from 'lucide-react';
import type {XboxMessage,XboxPlayerProfile,XboxSocialApi} from '../shared/types';
import {XboxAvatar,XboxGamertag} from './XboxAvatar';

type ChatApi=Pick<XboxSocialApi,'getXboxPlayerProfile'|'getXboxConversation'|'sendXboxMessage'>;
type Refresh='initial'|'poll'|'manual'|'sent';
export type XboxChatState={profile?:XboxPlayerProfile;messages:XboxMessage[];draft:string;loading:boolean;sending:boolean;uncertain:boolean;sent:number;problem?:string;notice?:string};
const empty=():XboxChatState=>({messages:[],draft:'',loading:true,sending:false,uncertain:false,sent:0});
const failure=(error:unknown)=>error instanceof Error?error.message.replace(/^Error invoking remote method '[^']+': Error: /,''):'Xbox could not complete this request.';
export function xboxChatCanSend(text:string):boolean{
 return Boolean(text.trim())&&[...text].length<=256&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\uD800-\uDFFF]/u.test(text);
}
export function xboxChatComposeKey(event:KeyboardEvent<HTMLTextAreaElement>):void{
 if(event.key!=='Enter'||event.shiftKey||event.ctrlKey||event.altKey||event.metaKey||event.nativeEvent.isComposing||event.nativeEvent.keyCode===229)return;
 event.preventDefault();
 if(!event.repeat)event.currentTarget.form?.requestSubmit();
}

/** Native focus/restore and DOM visibility settle before the next paint. */
export function watchXboxChatFocus(observe:()=>void):()=>void{
 let frame:number|undefined;
 const focus=()=>{
  if(frame!==undefined)window.cancelAnimationFrame(frame);
  frame=window.requestAnimationFrame(()=>{frame=undefined;observe();});
 };
 window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);focus();
 return()=>{if(frame!==undefined)window.cancelAnimationFrame(frame);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);};
}

/** One immutable account/recipient; discarded reads and writes can never publish into its replacement. */
export class XboxChatSession {
 private state=empty();
 private closed=false;
 private acceptedId?:string;
 private readVersion=0;
 private reading?:{version:number;promise:Promise<void>};
 constructor(private readonly api:ChatApi,private readonly account:string,private readonly xuid:string,private readonly changed:(value:XboxChatState)=>void){}
 get current():XboxChatState{return this.state;}
 private publish(patch:Partial<XboxChatState>):void{
  if(this.closed)return;this.state={...this.state,...patch};this.changed(this.state);
 }
 start():Promise<void>{
  if(this.closed)return Promise.resolve();
  const history=this.refresh('initial');
  try{void this.api.getXboxPlayerProfile(this.xuid).then(profile=>{
   if(!this.closed&&profile.xuid===this.xuid)this.publish({profile});
  }).catch(()=>{});}catch{}
  return history;
 }
 setDraft(draft:string):void{this.publish({draft});}
 close():void{this.closed=true;this.readVersion++;this.reading=undefined;}
 refresh(source:Refresh='manual'):Promise<void>{
  if(this.closed||this.state.sending)return Promise.resolve();
  if(this.reading)return this.reading.promise;
  const version=++this.readVersion;
  this.publish({loading:true});
  const promise=(async()=>{
   try{
    const messages=await this.api.getXboxConversation(this.xuid);
    if(this.closed||version!==this.readVersion)return;
    this.publish({messages,loading:false,...(source==='manual'?{uncertain:false,problem:undefined,notice:undefined}:!this.state.uncertain?{problem:undefined}:{}),
     ...(this.acceptedId?{notice:messages.some(item=>item.id===this.acceptedId&&item.mine)?'Message confirmed in conversation.':'Xbox accepted the message. Waiting for it to appear in chat history.'}:{})});
   }catch(error){
    if(this.closed||version!==this.readVersion)return;
    const problem=source==='sent'?'Xbox accepted the message, but its updated conversation could not be loaded. Refresh the conversation.':failure(error);
    this.publish({loading:false,problem:this.state.uncertain&&source!=='manual'?this.state.problem:problem});
   }
  })().finally(()=>{if(this.reading?.version===version)this.reading=undefined;});
  this.reading={version,promise};return promise;
 }
 async send():Promise<void>{
  if(this.closed||this.state.sending||this.state.uncertain)return;
  const text=this.state.draft;
  if(!xboxChatCanSend(text)){this.publish({problem:'Enter a message of 1–256 characters.'});return;}
  // A pre-send poll must not replace the fresh conversation after the send completes.
  this.readVersion++;this.reading=undefined;this.acceptedId=undefined;
  this.publish({sending:true,loading:false,problem:undefined,notice:undefined});
  try{
   const receipt=await this.api.sendXboxMessage(this.account,this.xuid,text);
   if(!receipt||typeof receipt.id!=='string'||!receipt.id.trim())throw Error('Xbox did not confirm this message.');
   this.acceptedId=receipt.id;
  }catch(error){
   this.publish({sending:false,uncertain:true,problem:failure(error)+' Message was not retried. Refresh the conversation and check it before sending again.'});return;
  }
  if(this.closed)return;
  this.publish({sending:false,draft:this.state.draft===text?'':this.state.draft,sent:this.state.sent+1,notice:'Xbox accepted the message.'});
  await this.refresh('sent');
 }
}

export type XboxChatProps={api:XboxSocialApi;account:string;xuid:string;displayName?:string;close?:()=>void;popOut?:()=>void;openProfile?:(xuid:string)=>void;active?:boolean;onViewed?:(peer:string,ids:string[])=>void};
const useBrowserLayoutEffect=typeof window==='undefined'?useEffect:useLayoutEffect;

/** Shared inline, desktop and overlay conversation; the parent supplies its size and window controls. */
export function XboxChat(props:XboxChatProps){
 return <XboxChatView key={JSON.stringify([props.account,props.xuid])} {...props}/>;
}
function XboxChatView({api,account,xuid,displayName,close,popOut,openProfile,active=true,onViewed}:XboxChatProps){
 const [state,setState]=useState<XboxChatState>(empty);
 const countId=useId();
 const session=useRef<XboxChatSession>(),list=useRef<HTMLDivElement>(null);
 const pinned=useRef(true),previousSend=useRef(0);
 const wasActive=useRef(false);
 const visible=useRef(active);visible.current=active;
 const viewed=useRef(onViewed);viewed.current=onViewed;
 const observe=()=>{
  const element=list.current;if(!element)return;
  pinned.current=element.scrollHeight-element.scrollTop-element.clientHeight<32;
  if(visible.current&&document.visibilityState==='visible'&&document.hasFocus()&&element.getClientRects().length&&pinned.current)
   viewed.current?.(xuid,state.messages.map(message=>message.id));
 };
 useEffect(()=>{
  const current=new XboxChatSession(api,account,xuid,setState);session.current=current;setState(current.current);pinned.current=true;previousSend.current=0;
  void current.start();
  const refresh=()=>{if(visible.current&&document.visibilityState==='visible')void current.refresh('poll');};
  const timer=setInterval(refresh,15000);document.addEventListener('visibilitychange',refresh);
  return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',refresh);current.close();if(session.current===current)session.current=undefined;};
 },[api,account,xuid]);
 useBrowserLayoutEffect(()=>{
  const element=list.current;if(!element)return;
  if(active&&!wasActive.current)pinned.current=true;wasActive.current=active;
  if(pinned.current||state.sent!==previousSend.current){element.scrollTop=element.scrollHeight;pinned.current=true;}
  previousSend.current=state.sent;
  observe();
 },[state.messages,state.sent,active]);
 useEffect(()=>{if(active)void session.current?.refresh('poll');},[active]);
 useEffect(()=>watchXboxChatFocus(observe),[active,state.messages]);
 const name=state.profile?.gamertag??displayName??'Xbox player';
 const valid=xboxChatCanSend(state.draft),count=[...state.draft].length;
 return <section className="social-chat" aria-label={'Chat with '+name} style={{display:'flex',flexDirection:'column',flex:1,minWidth:0,minHeight:0,height:'100%',overflow:'hidden'}}>
  <header className="social-guide-chrome social-chat-header" style={{padding:'8px 16px'}}>
   <button type="button" className="social-chat-identity" style={{padding:0,width:'auto',flex:1,minWidth:0}} disabled={!openProfile} onClick={()=>openProfile?.(xuid)} aria-label={'View profile for '+name}>
    <XboxAvatar src={state.profile?.avatarUrl} name={name}/><span><strong><XboxGamertag name={name}/></strong><small>{ui("social.xbox_chat_ed1ef2")}</small></span>
   </button>
   <button type="button" className="social-circle-button" disabled={state.loading||state.sending} onClick={()=>void session.current?.refresh('manual')} aria-label={ui("social.refresh_conversation_889bde")} title={ui("social.refresh_conversation_889bde")}><RefreshCw/></button>
   {popOut?<button type="button" className="social-circle-button" onClick={popOut} aria-label={ui("social.pop_out_chat_b325ca")} title={ui("social.pop_out_chat_b325ca")}><ExternalLink/></button>:null}
   {close?<button type="button" className="social-circle-button social-close" onClick={close} aria-label={ui("social.close_chat_3b14c5")} title={ui("social.close_chat_3b14c5")}><X/></button>:null}
  </header>
  <div className="social-messages" role="log" aria-label={'Messages with '+name} aria-live="polite" aria-relevant="additions text" aria-busy={state.loading} ref={list}
   onScroll={observe}>
   {state.messages.map(item=><article key={item.id} className={'social-message'+(item.mine?' is-mine':'')+(item.hidden?' filtered':'')}>
    <p>{item.hidden?ui('ui.message_hidden_or_unsupported_d199cb4'):item.text||ui('social.message_unavailable')}</p>{item.timestamp&&Number.isFinite(Date.parse(item.timestamp))?<time dateTime={item.timestamp}>{new Date(item.timestamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time>:null}
   </article>)}
   {state.loading&&!state.messages.length?<p className="social-loading" role="status"><LoaderCircle className="spin"/>{ui("social.loading_conversation_5eb1e4")}</p>:null}
   {!state.loading&&!state.messages.length&&!state.problem?<p className="social-empty">{ui("social.no_messages_in_this_conversation_1e56e8")}</p>:null}
  </div>
  {state.problem?<p className="social-error" role="alert">{uiText(state.problem)}</p>:null}
  {state.notice?<p className="social-action-status" role="status">{uiText(state.notice)}</p>:null}
  <form className="social-compose" onSubmit={event=>{event.preventDefault();void session.current?.send();}}>
   <textarea aria-label={'Message '+name} value={state.draft} onChange={event=>session.current?.setDraft(event.target.value)} maxLength={512} placeholder={ui("social.type_a_message_00cd58")} disabled={state.sending}
    onKeyDown={xboxChatComposeKey} aria-describedby={countId}/>
   <span id={countId} className="social-chat-character-count" style={{fontSize:12,color:'var(--social-muted)',whiteSpace:'nowrap'}}>{count}/256</span>
   <button type="submit" disabled={state.sending||state.uncertain||!valid} aria-label={'Send message to '+name}>{state.sending?<LoaderCircle className="spin"/>:<Send/>}</button>
  </form>
 </section>;
}
