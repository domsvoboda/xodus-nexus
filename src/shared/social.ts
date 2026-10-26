export interface XboxFriend { xuid: string; gamertag: string; presence: 'online' | 'offline' | 'unknown'; activity?: string; avatarUrl?: string }
export interface XboxChatMessage { id: string; sender: string; at: string; text?: string; hidden: boolean }
export interface XboxConversation { xuid: string; messages: XboxChatMessage[]; hasMore: boolean }
export interface XboxMessageReceipt { messageId: string }
export type SocialRequest = { op: 'friends' } | { op: 'conversation'; xuid: string } | { op: 'send'; xuid: string; text: string };

export function xboxUserId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
}
export function xboxMessageText(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && Array.from(value).length <= 256 && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value);
}
const label = (s: unknown, max: number): s is string => typeof s === 'string' && Array.from(s).length <= max && !/[\x00-\x1f\x7f]/.test(s);

/** An acceptance receipt is not proof of recipient delivery. Keep its real ID for reconciliation. */
export function parseXboxMessageReceipt(value: unknown): XboxMessageReceipt {
  const v=value as {sent?:unknown;messageId?:unknown}|null;
  if(!v||v.sent!==true||!label(v.messageId,128)||!v.messageId.trim())
    throw Error('Message delivery could not be confirmed. Refresh before trying again.');
  return {messageId:v.messageId};
}
export function xboxSubmissionInHistory(receipt: XboxMessageReceipt, conversation: XboxConversation): boolean {
  return conversation.messages.some(message=>message.id===receipt.messageId&&message.sender!==conversation.xuid);
}

export function xboxAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      ['gamerpic.xboxlive.com','images-eds-ssl.xboxlive.com','avatar-ssl.xboxlive.com','xboxavatargamerpic.azureedge.net'].includes(url.hostname)) return url.href;
  } catch { /* An optional image must not make the friends list unusable. */ }
}

export const xboxSocialErrors = {
  denied:'Xbox denied this request. Check your account privacy and communication permissions.',
  signIn:'Xbox requires sign-in again. Open Settings to check your account.',
  limited:'Xbox is limiting requests. Wait before refreshing again.',
  notFound:'This conversation is not available from Xbox.',
  invalid:'Xbox returned an unsupported conversation response.',
  unavailable:'Xbox social services are unavailable. Try again later.',
  changed:'The account or backend changed. Open Friends again.',
} as const;
/** Electron may prefix an IPC error. Never expose any other raw error text. */
export function xboxSocialError(error: unknown, fallback = xboxSocialErrors.unavailable): string {
  const message = error instanceof Error ? error.message : '';
  for (const safe of Object.values(xboxSocialErrors)) if(message === safe || /^Error invoking remote method 'xbox-[a-z-]+': Error: /.test(message) && message.split(': Error: ').slice(1).join(': Error: ') === safe) return safe;
  return fallback;
}

/** Explicit field projection. Backend data and account identifiers never become markup or URLs. */
export function parseXboxFriends(value: unknown): XboxFriend[] {
  const friends=(value as {friends?:unknown} | null)?.friends;
  if(!Array.isArray(friends)||friends.length>1000) throw Error('Invalid friends response.');
  const seen=new Set<string>();
  return friends.map(friend=>{
    if(!friend||!xboxUserId(friend.xuid)||seen.has(friend.xuid)||!label(friend.gamertag,128)||!friend.gamertag.trim()
      || !['online','offline','unknown'].includes(friend.presence) || (friend.activity!=null&&!label(friend.activity,512))) throw Error('Invalid friends response.');
    seen.add(friend.xuid);
    const result: XboxFriend = {xuid:friend.xuid,gamertag:friend.gamertag,presence:friend.presence,activity:friend.activity??undefined};
    const avatar = xboxAvatarUrl(friend.avatarUrl); if(avatar) result.avatarUrl = avatar;
    return result;
  });
}
export function parseXboxConversation(value: unknown, expected: string): XboxConversation {
  const v=value as XboxConversation | null;
  if(!v||v.xuid!==expected||!Array.isArray(v.messages)||v.messages.length>100||typeof v.hasMore!=='boolean') throw Error('Invalid conversation response.');
  const seen=new Set<string>();
  const messages=v.messages.map(message=>{
    if(!message||!label(message.id,128)||!message.id||seen.has(message.id)||!xboxUserId(message.sender)||!label(message.at,64)
      ||!/^\d{4}-\d{2}-\d{2}T/.test(message.at)||!Number.isFinite(Date.parse(message.at))||typeof message.hidden!=='boolean'
      ||(!message.hidden&&(typeof message.text!=='string'||message.text.length>262144||/[\x00-\x08\x0b-\x1f\x7f]/.test(message.text)))) throw Error('Invalid conversation response.');
    seen.add(message.id);
    return {id:message.id,sender:message.sender,at:message.at,hidden:message.hidden,text:message.hidden?undefined:message.text};
  });
  messages.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  return {xuid:expected,messages,hasMore:v.hasMore};
}
