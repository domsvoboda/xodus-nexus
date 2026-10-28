import {useState} from 'react';
import type {GameInviteState} from '../shared/game-invites';
import type {LauncherApi,XboxFriend} from '../shared/types';
import {ui} from './i18n';

export type RuntimeInviteApi=Pick<LauncherApi,'chooseGameInviteRecipient'|'cancelGameInvite'|'acceptGameInvite'>;

/** The game owns the invitation; this panel only submits the user's selection. */
export function XboxRuntimeInvites({state,api,friends}:{state?:GameInviteState;api?:RuntimeInviteApi;friends:XboxFriend[]}){
 const [recipient,setRecipient]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 if(!state||!api||!state.incoming.length&&!state.outgoing.length)return null;
 async function act(action:()=>Promise<void>){
  if(busy)return;setBusy(true);setError('');
  try{await action();}catch{setError(ui('ui.the_invitation_could_not_be_processed_check_that_0e251ae'));}
  finally{setBusy(false);}
 }
 return <section className="social-runtime-invites" aria-label={ui('ui.game_invitations_f9a1a45')}>
  {state.incoming.map(invite=><article key={invite.id}><strong>{invite.game}</strong><small>{ui('friends.invitation_from',{name:invite.sender})}</small><button disabled={busy} onClick={()=>void act(()=>api.acceptGameInvite(invite.id))}>{ui('ui.accept_89713b9')}</button></article>)}
  {state.outgoing.map(invite=><article key={invite.id}><strong>{invite.game}</strong>
   <small>{invite.phase==='choosing'?ui('ui.choose_a_friend_below_then_send_an_invitation_27e80a3'):invite.phase==='sending'?ui('ui.waiting_for_the_game_to_send_the_invitation_c4d60eb'):invite.phase==='sent'?ui('ui.invitation_sent_b413595'):invite.phase==='failed'?ui('ui.the_game_could_not_confirm_invitation_delivery_d434e95'):ui('ui.invitation_cancelled_134517d')}</small>
   {invite.phase==='choosing'?<><select aria-label={ui('ui.friends_list_e79cc91')} value={recipient} disabled={busy} onChange={event=>setRecipient(event.target.value)}><option value="">{ui('friends.friend')}</option>{friends.map(friend=><option key={friend.xuid} value={friend.xuid}>{friend.gamertag}</option>)}</select>
    <button disabled={busy||!friends.some(friend=>friend.xuid===recipient)} onClick={()=>void act(()=>api.chooseGameInviteRecipient(invite.id,recipient))}>{ui('friends.invite_friend',{name:friends.find(friend=>friend.xuid===recipient)?.gamertag??ui('friends.friend')})}</button>
    <button disabled={busy} onClick={()=>void act(()=>api.cancelGameInvite(invite.id))}>{ui('ui.cancel_19766ed')}</button></>:null}
  </article>)}
  {error?<p role="alert">{error}</p>:null}
 </section>;
}
