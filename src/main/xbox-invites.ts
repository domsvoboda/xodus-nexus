import {EventEmitter} from 'node:events';
import {readXboxSocial} from './xbox-native-social.js';
import type {XboxInvite} from '../shared/types.js';

type Connection={binary:string;account:string};
type RawInvite=XboxInvite&{handle:string;handleType:'mpsd'|'activity';activationInfo:string|null};
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
const optional=(v:unknown,max:number):v is string|null=>v===null||text(v,max);
const xuid=(value:unknown):value is string=>typeof value==='string'&&/^[1-9][0-9]{0,19}$/.test(value)&&BigInt(value)<=18446744073709551615n;
function titleId(value:string|null):string{
 const number=value&&(/^[0-9]{1,10}$/.test(value)?Number(value):/^(?:0x)?[0-9a-f]{1,8}$/i.test(value)?Number.parseInt(value.replace(/^0x/i,''),16):NaN);
 if(typeof number!=='number'||!Number.isSafeInteger(number)||number<=0||number>0xffffffff)throw Error('This invitation does not identify an Xbox game.');return String(number);
}
function destinationTitle(row:RawInvite):string{
 if(row.activationInfo){
  let activation:any;try{activation=JSON.parse(row.activationInfo);}catch{throw Error('Invalid Xbox game activation information.');}
  if(!activation||typeof activation!=='object'||Array.isArray(activation))throw Error('Invalid Xbox game activation information.');
  if(Object.hasOwn(activation,'win32')){
   const value=activation.win32?.titleId;
   if(typeof value!=='string'&&typeof value!=='number')throw Error('The invitation does not identify a PC game.');
   return titleId(String(value));
  }
  if(Object.keys(activation).length)throw Error('This invitation does not identify a WinGDK version of the game.');
 }
 return titleId(row.titleId);
}
export type XboxGameInvitation={titleId:string;uri:string;expiresAt:number};
export function inviteDate(value:unknown):number {
  if(!text(value,128))throw Error('Invalid Xbox invitation date.');
  // Multiplayer activity notifications also use this UTC format in the shipped SDK.
  const match=/^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/.exec(value);
  if(match&&(Number(match[1])<1||Number(match[1])>12||Number(match[2])<1||Number(match[2])>31||Number(match[3])<100
    ||Number(match[4])<1||Number(match[4])>12||Number(match[5])>59||Number(match[6])>59))throw Error('Invalid Xbox invitation date.');
  const time=match?Date.UTC(Number(match[3]),Number(match[1])-1,Number(match[2]),Number(match[4])%12+(match[7]==='PM'?12:0),Number(match[5]),Number(match[6])):
    /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)?Date.parse(value):NaN;
  if(match&&new Date(time).getUTCDate()!==Number(match[2]))throw Error('Invalid Xbox invitation date.');
  if(!Number.isFinite(time))throw Error('Invalid Xbox invitation date.');return time;
}
function invitation(value:any):RawInvite {
  if(!value||!text(value.id,256)||!value.id||!['party','game'].includes(value.kind)||!text(value.gamertag,256)||!value.gamertag
    ||typeof value.sender!=='string'||!/^[1-9][0-9]{0,19}$/.test(value.sender)||BigInt(value.sender)>18446744073709551615n
    ||!text(value.handle,4096)||!value.handle||!['mpsd','activity'].includes(value.handleType)||!optional(value.activationInfo,16*1024)
    ||!optional(value.titleId,64)||!optional(value.titleName,256)||!optional(value.timestamp,64))throw Error('Invalid Xbox invitation response.');
  const id=`${value.kind}:${value.id}`;
  return {id,kind:value.kind,gamertag:value.gamertag,sender:value.sender,expiresAt:inviteDate(value.expiration),sentAt:value.timestamp?inviteDate(value.timestamp):null,
    titleId:value.titleId,titleName:value.titleName,handle:value.handle,handleType:value.handleType,activationInfo:value.activationInfo};
}
const visible=({id,kind,gamertag,sender,expiresAt,sentAt,titleId,titleName}:RawInvite):XboxInvite=>({id,kind,gamertag,sender,expiresAt,sentAt,titleId,titleName});

/** Invitation handles stay in main; renderers select an account-bound inbox entry. */
export class XboxInvites extends EventEmitter {
  private rows=new Map<string,RawInvite>();
  private seen?:Set<string>;
  private bound?:Connection;
  private until=0;
  private controller?:AbortController;
  private loading?:Promise<XboxInvite[]>;
  private recipient?:string;
  constructor(private readonly connection:()=>Connection|undefined,private readonly read=readXboxSocial){super();}
  clear():void{this.controller?.abort();this.controller=undefined;this.loading=undefined;this.rows.clear();this.seen=undefined;this.bound=undefined;this.until=0;this.recipient=undefined;}
  list(force=false):Promise<XboxInvite[]>{
    const connection=this.connection();
    if(!connection){this.clear();return Promise.reject(Error('Sign in to receive Xbox invites.'));}
    if(this.bound&&(this.bound.account!==connection.account||this.bound.binary!==connection.binary))this.clear();
    if(this.loading)return this.loading;
    if(!force&&this.until>Date.now())return Promise.resolve([...this.rows.values()].map(visible));
    this.bound=connection;const controller=new AbortController();this.controller=controller;
    const job=(async()=>{
      const output=await this.read(connection.binary,['invites'],undefined,controller.signal);controller.signal.throwIfAborted();
      if(output.length>2*1024*1024||this.connection()?.account!==connection.account||this.connection()?.binary!==connection.binary)throw Error('Xbox invite account changed.');
      const result=JSON.parse(output);
      if(result.schema!==1||result.kind!=='invites'||result.account!==connection.account||!Array.isArray(result.items)||result.items.length>100)throw Error('Invalid Xbox invite inbox.');
      if(result.recipient!==undefined&&!xuid(result.recipient))throw Error('Invalid Xbox invite recipient.');
      const rows:RawInvite[]=result.items.map(invitation);const next=new Map(rows.map(row=>[row.id,row]));
      if(next.size!==rows.length)throw Error('Duplicate Xbox invitation.');
      const fingerprint=(row:RawInvite)=>`${row.id}:${row.handle}:${row.expiresAt}`;
      const fresh=this.seen?rows.filter(row=>row.expiresAt>Date.now()&&!this.seen!.has(fingerprint(row))):[];
      this.rows=next;this.seen=new Set(rows.map(fingerprint));this.until=Date.now()+15_000;this.recipient=result.recipient;
      const list=rows.map(visible).sort((a,b)=>(b.sentAt??0)-(a.sentAt??0));this.emit('change',list);
      for(const row of fresh)this.emit('invite',visible(row));return list;
    })().finally(()=>{if(this.controller===controller){this.loading=undefined;this.controller=undefined;}});this.loading=job;
    return job;
  }
  async partyHandle(id:string):Promise<string>{
    if(!text(id,262))throw Error('Select an Xbox party invitation.');
    await this.list(true);const row=this.rows.get(id);
    if(!row||row.kind!=='party'||row.handleType!=='mpsd'||row.expiresAt<=Date.now()||!/^[A-Za-z0-9_-]{1,128}$/.test(row.handle))throw Error('That Xbox party invitation is unavailable or expired.');
    return row.handle;
  }
  async gameInvite(id:string):Promise<XboxGameInvitation>{
    if(!text(id,262))throw Error('Select an Xbox game invitation.');
    await this.list(true);const row=this.rows.get(id),recipient=this.recipient;
    if(!row||row.kind!=='game'||row.expiresAt<=Date.now())throw Error('That Xbox game invitation is unavailable or expired.');
    if(!xuid(recipient))throw Error('Update the Nexus social backend to accept game invitations.');
    const gameTitle=destinationTitle(row);
    let uri:string;
    if(row.handleType==='mpsd'){
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.handle))throw Error('Invalid Xbox session invitation handle.');
      uri=`ms-xbl-multiplayer://inviteHandleAccept?handle=${encodeURIComponent(row.handle)}&invitedXuid=${recipient}&senderXuid=${row.sender}`;
    }else{
      uri=`ms-xbl-multiplayer://inviteAccept?invitedUser=${recipient}&sender=${row.sender}&connectionString=${encodeURIComponent(row.handle)}`;
    }
    if(uri.length>16384)throw Error('This Xbox invitation is too large to deliver to the game.');
    return {titleId:gameTitle,uri,expiresAt:row.expiresAt};
  }
}
