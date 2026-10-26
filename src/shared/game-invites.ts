import {xboxUserId} from './social.js';
export interface GameInviteState {
  active:{id:string;game:string}[];
  outgoing:{id:string;game:string;phase:'choosing'|'sending'|'sent'|'failed'|'cancelled'}[];
  incoming:{id:string;game:string;sender:string;expires:number}[];
}
export const emptyGameInvites=():GameInviteState=>({active:[],outgoing:[],incoming:[]});
const guid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const inviteGuid=(value:string)=>guid.test(value);
/** Never execute this URI or expose its session capability in a renderer. */
export function validateGameInviteUri(text:string,receiver:string):boolean{
  if(!xboxUserId(receiver)||text.length>4096||/[\x00-\x20\x7f]/.test(text))return false;
  try{
    const uri=new URL(text);if(uri.protocol!=='ms-xbl-multiplayer:'||uri.username||uri.password||uri.port||uri.hash||uri.pathname)return false;
    const keys=[...uri.searchParams.keys()];if(new Set(keys).size!==keys.length)return false;
    const get=(key:string)=>uri.searchParams.get(key)??'';
    if([...uri.searchParams.values()].some(value=>/[\x00-\x1f\x7f]/.test(value)))return false;
    if(uri.hostname.toLowerCase()==='invitehandleaccept')return keys.every(k=>['handle','invitedXuid','senderXuid','context'].includes(k))&&inviteGuid(get('handle'))&&get('invitedXuid')===receiver&&xboxUserId(get('senderXuid'));
    if(uri.hostname.toLowerCase()==='inviteaccept')return keys.every(k=>['invitedUser','sender','connectionString'].includes(k))&&get('invitedUser')===receiver&&xboxUserId(get('sender'))&&Boolean(get('connectionString'));
    return false;
  }catch{return false;}
}
