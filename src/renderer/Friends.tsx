import { ui, uiText } from './i18n';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { LoaderCircle, Send, UserRound, X } from 'lucide-react';
import type { AppSnapshot } from '../shared/types';
import { xboxAvatarUrl, xboxMessageText, xboxSocialError, xboxSubmissionInHistory, type XboxConversation, type XboxFriend, type XboxMessageReceipt } from '../shared/social';
import { FriendsRefresh } from './friends-refresh';
import './friends.css';

// Warm only after pointer/keyboard intent, never on startup or while signing in.
export function preloadFriends(data:AppSnapshot,load:()=>Promise<unknown>=()=>window.launcher.getXboxFriends()):void {
  if(data.auth.stored!==true||data.auth.running||!data.backend.available||!data.backend.capabilities.commands.includes('social'))return;
  void load().catch(()=>{});
}

export function FriendAvatar({ friend }: { friend: XboxFriend }) {
  const url = xboxAvatarUrl(friend.avatarUrl);
  const [failed,setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return <span className="friend-avatar">{url&&!failed?<img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={()=>setFailed(true)} />:<UserRound aria-hidden="true" />}</span>;
}

export function Friends({ data, close, docked=false }: { data: AppSnapshot; close: () => void; docked?: boolean }) {
  const [friends,setFriends]=useState<XboxFriend[]>([]),[selected,setSelected]=useState<XboxFriend>();
  const [conversation,setConversation]=useState<XboxConversation>(),[draft,setDraft]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [sending,setSending]=useState(false);
  const [uncertain,setUncertain]=useState(false);
  const [accepted,setAccepted]=useState(false);
  const submission=useRef<{receipt:XboxMessageReceipt;text:string}>();
  const generation=useRef(0),pending=useRef(false),select=useRef('');
  const currentFriend=useRef<XboxFriend>(),lastFriends=useRef(0);
  const dialog=useRef<HTMLElement>(null),onClose=useRef(close);onClose.current=close;
  const available=data.auth.stored===true&&!data.auth.running&&data.backend.available&&data.backend.capabilities.commands.includes('social');
  useEffect(()=>{
    const origin=document.activeElement instanceof HTMLElement?document.activeElement:undefined;
    dialog.current?.querySelector<HTMLElement>('[data-gamepad-initial]')?.focus({preventScroll:true});
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();onClose.current();}
      if(event.key==='Tab'&&!docked){
        const controls=[...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled)')];
        if(!dialog.current?.contains(document.activeElement)||event.shiftKey&&document.activeElement===controls[0]||!event.shiftKey&&document.activeElement===controls.at(-1)){
          event.preventDefault();(event.shiftKey?controls.at(-1):controls[0])?.focus();
        }
      }
    };
    window.addEventListener('keydown',key,true);
    return()=>{window.removeEventListener('keydown',key,true);if(origin?.isConnected)origin.focus({preventScroll:true});};
  },[docked]);

  useEffect(()=>{
    const active=++generation.current;
    setFriends([]);setSelected(undefined);currentFriend.current=undefined;select.current='';setConversation(undefined);setDraft('');setUncertain(false);setAccepted(false);submission.current=undefined;setError('');pending.current=false;setBusy(false);setSending(false);lastFriends.current=0;
    if(available){
      setBusy(true);pending.current=true;
      void window.launcher.getXboxFriends().then(value=>{
        if(generation.current===active){setFriends(value);lastFriends.current=Date.now();}
      }).catch(error=>{if(generation.current===active)setError(xboxSocialError(error));})
        .finally(()=>{if(generation.current===active){setBusy(false);pending.current=false;}});
    }
    return ()=>{generation.current++;void window.launcher.closeXboxSocial().catch(()=>{});};
  },[available,data.auth.username]);

  function applyConversation(value:XboxConversation){
    setConversation(value);
    const sent=submission.current;
    if(sent&&xboxSubmissionInHistory(sent.receipt,value)){
      setDraft(draft=>draft===sent.text?'':draft);
      submission.current=undefined;setAccepted(false);setUncertain(false);setError('');
    }
  }

  async function refresh(friend=currentFriend.current,automatic=false): Promise<boolean> {
    if(pending.current)return true;
    if(automatic&&!friend&&Date.now()-lastFriends.current<60_000)return true;
    pending.current=true;setBusy(true);setError('');const active=generation.current;
    try{
      if(automatic&&Date.now()-lastFriends.current>=60_000){
        const value=await window.launcher.getXboxFriends();
        if(generation.current!==active)return true;
        setFriends(value);lastFriends.current=Date.now();
        const updated=value.find(value=>value.xuid===currentFriend.current?.xuid);
        if(updated){currentFriend.current=updated;setSelected(updated);}
      }
      if(friend){
        const value=await window.launcher.getXboxConversation(friend.xuid);
        if(generation.current===active&&select.current===friend.xuid)applyConversation(value);
      }else{
        if(!automatic||Date.now()-lastFriends.current>=60_000){
          const value=await window.launcher.getXboxFriends();if(generation.current===active){setFriends(value);lastFriends.current=Date.now();}
        }
      }
      return true;
    }catch(error){if(generation.current===active)setError(xboxSocialError(error));return false;}
    finally{if(generation.current===active){pending.current=false;setBusy(false);}}
  }
  useEffect(()=>{
    if(!available)return;
    const polling=new FriendsRefresh(()=>refresh(currentFriend.current,true),()=>document.visibilityState==='visible');
    polling.start();
    const visible=()=>{if(document.visibilityState==='visible')polling.wake();};
    document.addEventListener('visibilitychange',visible);
    return()=>{polling.stop();document.removeEventListener('visibilitychange',visible);};
  },[available,data.auth.username]);
  function choose(friend:XboxFriend){
    if(pending.current)return;
    setSelected(friend);currentFriend.current=friend;select.current=friend.xuid;setConversation(undefined);setDraft('');setUncertain(false);setAccepted(false);submission.current=undefined;void refresh(friend);
  }
  async function send(event:FormEvent){
    event.preventDefault();if(!selected||pending.current||uncertain||!xboxMessageText(draft))return;
    const friend=selected,message=draft,active=generation.current;
    pending.current=true;setBusy(true);setSending(true);setError('');
    try{
      const receipt=await window.launcher.sendXboxMessage(friend.xuid,message);
      if(generation.current!==active)return;
      // Keep the draft and block duplicates until this exact server ID appears.
      // Service acceptance is not recipient delivery and must not create a fake message.
      submission.current={receipt,text:message};setAccepted(true);setUncertain(true);
      try{const value=await window.launcher.getXboxConversation(friend.xuid);if(generation.current===active)applyConversation(value);}
      catch{if(generation.current===active)setError(ui("ui.xbox_accepted_the_message_but_the_conversation_c_5ec8ebb"));}
    }catch{if(generation.current===active){setUncertain(true);setError(ui("ui.message_delivery_could_not_be_confirmed_check_th_a9f9139"));}}
    finally{if(generation.current===active){pending.current=false;setBusy(false);setSending(false);}}
  }
  async function invitationAction(action:()=>Promise<void>){
    if(pending.current)return;const active=generation.current;pending.current=true;setBusy(true);setError('');
    try{await action();}catch{if(generation.current===active)setError(ui("ui.the_invitation_could_not_be_processed_check_that_0e251ae"));}
    finally{if(generation.current===active){pending.current=false;setBusy(false);}}
  }
  const outgoing=data.social?.outgoing??[],incoming=data.social?.incoming??[];
  return <div className={docked?'friends-docked':'dialog-backdrop'} data-gamepad-layer>
    <section ref={dialog} className="friends-dialog" role="dialog" aria-modal={docked?undefined:true} aria-labelledby="friends-heading">
      <header><h2 id="friends-heading">{ui("ui.friends_bd104d1")}</h2>{busy?<span className="friends-loading" role="status"><LoaderCircle className="spin" /><span className="sr-only">{ui("ui.loading_dc38088")}</span></span>:null}<button data-gamepad-initial data-gamepad-cancel aria-label={ui("ui.close_friends_64e9cdd")} onClick={close}><X /></button></header>
      {incoming.length||outgoing.length?<section className="friends-invitations" aria-label={ui("ui.game_invitations_f9a1a45")}>
        {incoming.map(invite=><article key={invite.id}><div><strong>{invite.game}</strong><small>{ui('friends.invitation_from', { name: invite.sender })}</small></div><button disabled={busy} onClick={()=>void invitationAction(()=>window.launcher.acceptGameInvite(invite.id))}>{ui("ui.accept_89713b9")}</button></article>)}
        {outgoing.map(invite=><article key={invite.id}><div><strong>{invite.game}</strong><small>{invite.phase==='choosing'?ui("ui.choose_a_friend_below_then_send_an_invitation_27e80a3"):invite.phase==='sending'?ui("ui.waiting_for_the_game_to_send_the_invitation_c4d60eb"):invite.phase==='sent'?ui("ui.invitation_sent_b413595"):invite.phase==='failed'?ui("ui.the_game_could_not_confirm_invitation_delivery_d434e95"):ui("ui.invitation_cancelled_134517d")}</small></div>{invite.phase==='choosing'?<><button disabled={busy||!selected} onClick={()=>selected&&void invitationAction(()=>window.launcher.chooseGameInviteRecipient(invite.id,selected.xuid))}>{ui('friends.invite_friend', { name: selected?.gamertag ?? ui('friends.friend') })}</button><button disabled={busy} onClick={()=>void invitationAction(()=>window.launcher.cancelGameInvite(invite.id))}>{ui("ui.cancel_19766ed")}</button></>:null}</article>)}
      </section>:null}
      {!available?<p role="status">{data.auth.stored!==true?ui("ui.sign_in_to_your_microsoft_account_in_settings_fi_187cd60"):ui("ui.this_backend_does_not_support_xbox_friends_and_c_6ed1034")}</p>:<>
        {error?<p className="friends-error" role="alert">{uiText(error)}</p>:null}
        <div className="friends-columns">
          <aside aria-label={ui("ui.friends_list_e79cc91")}>
            {!busy&&!friends.length?<p>{ui("ui.no_friends_returned_by_xbox_decddb3")}</p>:null}
            {friends.map(friend=><button key={friend.xuid} className={selected?.xuid===friend.xuid?'selected':''} disabled={busy} onClick={()=>choose(friend)}>
              <FriendAvatar friend={friend} /><span className="friend-details"><strong>{friend.gamertag}</strong><small>{friend.presence==='online'?ui("ui.online_0d21bd5"):friend.presence==='offline'?ui("ui.offline_a179478"):ui("ui.presence_unavailable_6eeb208")}</small>{friend.activity?<small>{friend.activity}</small>:null}</span>
            </button>)}
          </aside>
          <section className="friends-chat" aria-label={ui("ui.conversation_ccca181")}>
            {selected?<><h3><FriendAvatar friend={selected} />{selected.gamertag}</h3>
              {(data.social?.active??[]).map(game=><button key={game.id} disabled={busy||(data.social?.outgoing??[]).some(value=>value.phase==='sending'&&value.id.startsWith(game.id+':'))} onClick={()=>void invitationAction(()=>window.launcher.inviteXboxFriend(game.id,selected.xuid))}>{ui('friends.invite_to', { game: game.game })}</button>)}
              <div className="friends-messages" role="log" aria-live="polite">
                {conversation?.hasMore?<p>{ui("ui.showing_the_latest_100_messages_older_messages_a_7fb43bf")}</p>:null}
                {conversation?.messages.map(message=><article key={message.id}>
                  <small>{message.sender===selected.xuid?selected.gamertag:ui("ui.you_08b0419")} · <time dateTime={message.at}>{new Date(message.at).toLocaleString()}</time></small>
                  <p>{message.hidden?ui("ui.message_hidden_or_unsupported_d199cb4"):message.text}</p>
                </article>)}
                {conversation&&!conversation.messages.length?<p>{ui("ui.no_messages_returned_by_xbox_5a80816")}</p>:null}
              </div>
              {uncertain?<p role="status">{accepted?ui("ui.xbox_accepted_the_message_but_it_is_not_yet_conf_6ca6e90"):ui("ui.sending_could_not_be_confirmed_your_draft_is_kep_504246d")}</p>:null}
              <form onSubmit={event=>void send(event)}><label htmlFor="xbox-message">{ui("ui.message_2f77668")}</label><textarea id="xbox-message" value={draft} maxLength={512} onChange={event=>setDraft(event.target.value)} disabled={sending} />
                <small>{ui('friends.characters', { count: Array.from(draft).length })}</small><button type="submit" disabled={busy||uncertain||!xboxMessageText(draft)}><Send />{ui("ui.send_f6f4688")}</button></form>
            </>:<div className="friends-empty"><UserRound aria-hidden="true" /><h3>{ui("ui.your_conversations_903532e")}</h3><p>{ui("ui.select_a_friend_to_start_chatting_b5387d2")}</p></div>}
          </section>
        </div>
      </>}
    </section>
  </div>;
}
