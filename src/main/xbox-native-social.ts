import { spawnTracked } from './process.js';
import {readSocialBroker,supportsSocialBroker} from './xbox-social-transport.js';
import type { XboxConversation, XboxFriend, XboxMessage,XboxMessageReceipt,XboxPlayerProfile,XboxPeopleList,XboxPeoplePage,XboxPerson,XboxPlayerDetails,XboxRelationship,XboxRelationshipAction,XboxProfileGame,XboxProfileGames } from '../shared/types.js';

type Connection = { binary: string; account: string };
type Reader = (binary: string, args: string[], input: string | undefined, signal: AbortSignal) => Promise<string>;
const id = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
const string = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function avatar(value:unknown):value is string{
  if(typeof value!=='string'||value.length>8192||/[\x00-\x20\x7f]/.test(value))return false;
  try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&['gamerpic.xboxlive.com','images-eds-ssl.xboxlive.com','avatar-ssl.xboxlive.com','xboxavatargamerpic.azureedge.net'].includes(url.hostname);}catch{return false;}
}
const optionalAvatar=(value:unknown)=>value===undefined||value===null||avatar(value);
const picture=(value:string|null|undefined)=>value?{avatarUrl:value}:{};
function message(value: unknown): value is XboxMessage {
  return object(value) && string(value.id,256) && Boolean(value.id.trim()) && !/[\x00-\x1f\x7f]/.test(value.id) && (value.sender==='0' || id(value.sender)) && string(value.text,262144)
    && (value.timestamp === null || string(value.timestamp,64)&&/^\d{4}-\d{2}-\d{2}T/.test(value.timestamp)&&Number.isFinite(Date.parse(value.timestamp))) && typeof value.hidden === 'boolean' && typeof value.mine === 'boolean';
}
function friend(value: unknown): value is XboxFriend {
  return object(value) && id(value.xuid) && string(value.gamertag,256) && Boolean(value.gamertag)
    && string(value.presence,512) && typeof value.online === 'boolean' && typeof value.favorite === 'boolean' && typeof value.inParty === 'boolean'&&optionalAvatar(value.avatarUrl);
}
function playerProfile(value:unknown):value is XboxPlayerProfile{
  return object(value)&&id(value.xuid)&&string(value.gamertag,256)&&Boolean(value.gamertag)
    &&(value.gamerscore===null||(typeof value.gamerscore==='string'&&/^[0-9]{1,20}$/.test(value.gamerscore)))&&optionalAvatar(value.avatarUrl);
}
const peopleLists=new Set<XboxPeopleList>(['search','recent','suggested','blocked','received-requests','sent-requests']);
const relationshipActions=new Set<XboxRelationshipAction>(['send-request','accept-request','cancel-request','decline-request','remove-friend','favorite','unfavorite','block','unblock']);
function relationship(value:unknown):value is XboxRelationship{
  return object(value)&&id(value.xuid)&&['isFriend','isFollowing','isFollower','favorite','blocked'].every(key=>typeof value[key]==='boolean')
    &&['none','incoming','outgoing','unknown'].includes(value.requestState as string);
}
function cleanRelationship({xuid,isFriend,isFollowing,isFollower,favorite,blocked,requestState}:XboxRelationship):XboxRelationship{
  return {xuid,isFriend,isFollowing,isFollower,favorite,blocked,requestState};
}
function cleanPerson(value:unknown):XboxPerson{
  if(!friend(value)||!object(value)||value.reason!==undefined&&!string(value.reason,512)||value.lastSeen!==undefined&&!string(value.lastSeen,64))throw Error('Xbox returned an invalid player.');
  const {xuid,gamertag,online,presence,favorite,inParty,avatarUrl}=value;
  return {xuid,gamertag,online,presence,favorite,inParty,...picture(avatarUrl),...(value.reason===undefined?{}:{reason:value.reason as string}),...(value.lastSeen===undefined?{}:{lastSeen:value.lastSeen as string})};
}
function cleanDetails(value:unknown):XboxPlayerDetails{
  if(!playerProfile(value)||!object(value))throw Error('Xbox returned an invalid player profile.');
  const result:XboxPlayerDetails={xuid:value.xuid,gamertag:value.gamertag,gamerscore:value.gamerscore,...picture(value.avatarUrl)};
  if(value.isSelf!==undefined){if(typeof value.isSelf!=='boolean')throw Error('Xbox returned invalid profile details.');result.isSelf=value.isSelf;}
  for(const key of ['bio','location','tenure'] as const){
    const field=value[key];if(field!==undefined){if(!string(field,key==='bio'?4096:key==='location'?256:32))throw Error('Xbox returned invalid profile details.');result[key]=field;}
  }
  if(value.relationship!==undefined){if(!relationship(value.relationship)||value.relationship.xuid!==value.xuid)throw Error('Xbox returned a different player relationship.');result.relationship=cleanRelationship(value.relationship);}
  if(value.colors!==undefined){
    if(!object(value.colors))throw Error('Xbox returned invalid profile colors.');const colors:XboxPlayerDetails['colors']={};
    for(const key of ['primary','secondary','tertiary'] as const){const field=value.colors[key];if(field!==undefined){if(typeof field!=='string'||!/^#[a-f0-9]{6}$/i.test(field))throw Error('Xbox returned invalid profile colors.');colors[key]=field;}}result.colors=colors;
  }
  if(value.counts!==undefined){
    if(!object(value.counts))throw Error('Xbox returned invalid profile counts.');const counts:XboxPlayerDetails['counts']={};
    for(const key of ['friends','followers','following'] as const){const field=value.counts[key];if(field!==undefined){if(typeof field!=='number'||!Number.isSafeInteger(field)||field<0||field>1_000_000_000)throw Error('Xbox returned invalid profile counts.');counts[key]=field;}}result.counts=counts;
  }
  return result;
}
function cleanGame(value:unknown):XboxProfileGame{
  if(!object(value)||!id(value.titleId)||BigInt(value.titleId)>4294967295n||!string(value.name,512)||!value.name)throw Error('Xbox returned an invalid game.');
  const game:XboxProfileGame={titleId:value.titleId,name:value.name};
  if(value.imageUrl!==undefined){
    if(typeof value.imageUrl!=='string'||value.imageUrl.length>8192)throw Error('Xbox returned an invalid game image.');
    const url=new URL(value.imageUrl);
    if(url.protocol!=='https:'||url.username||url.password||url.port||!['store-images.s-microsoft.com','images-eds-ssl.xboxlive.com','images-assets-ssl.xboxlive.com'].includes(url.hostname))throw Error('Xbox returned an invalid game image.');game.imageUrl=url.href;
  }
  if(value.lastPlayed!==undefined){if(!string(value.lastPlayed,64)||!Number.isFinite(Date.parse(value.lastPlayed)))throw Error('Xbox returned an invalid game timestamp.');game.lastPlayed=value.lastPlayed;}
  for(const key of ['currentGamerscore','totalGamerscore','achievementsUnlocked','achievementsTotal'] as const){
    const field=value[key];if(field!==undefined){if(typeof field!=='number'||!Number.isSafeInteger(field)||field<0||field>1_000_000_000)throw Error('Xbox returned invalid achievement counts.');game[key]=field;}
  }
  return game;
}
function conversation(value: unknown): value is XboxConversation {
  return object(value) && string(value.id,256) && (value.type === null || string(value.type,32))
    && Array.isArray(value.participants) && value.participants.length <= 100 && value.participants.every(id)
    && string(value.gamertag,256)
    &&optionalAvatar(value.avatarUrl)
    && typeof value.unread === 'boolean' && (value.lastMessage === null || message(value.lastMessage));
}
const cleanMessage = ({id,sender,timestamp,text,hidden,mine}: XboxMessage): XboxMessage => ({id,sender,timestamp,text:hidden?'':text,hidden,mine});
function cleanItems(kind: string,items: unknown[]): unknown[] {
  if(kind==='sent')return (items as XboxMessageReceipt[]).map(({id})=>({id}));
  if(kind==='profile')return (items as XboxPlayerProfile[]).map(({xuid,gamertag,gamerscore,avatarUrl})=>({xuid,gamertag,gamerscore,...picture(avatarUrl)}));
  if(kind==='friends') return (items as XboxFriend[]).map(({xuid,gamertag,online,presence,favorite,inParty,avatarUrl})=>({xuid,gamertag,online,presence,favorite,inParty,...picture(avatarUrl)}));
  if(kind==='conversation') return (items as XboxMessage[]).map(cleanMessage);
  if(kind==='inbox') return (items as XboxConversation[]).map(({id,type,participants,gamertag,unread,lastMessage,avatarUrl})=>({id,type,participants,gamertag,unread,lastMessage:lastMessage?cleanMessage(lastMessage):null,...picture(avatarUrl)}));
  return [];
}

function socialFailure(diagnostic:string):Error{
      const stage=[...diagnostic.matchAll(/Xbox social unavailable \(([a-z-]{1,64})\)\./g)].at(-1)?.[1];
      const status=/NEXUS_SOCIAL_HTTP_DIAGNOSTIC_V1 (?:party|people(?:-read|-mutation)?) ([1-5][0-9]{2})/.exec(diagnostic)?.[1];
      let serviceMessage:string|undefined;
      try{const text=/NEXUS_SOCIAL_SERVICE_DIAGNOSTIC_V1 (\{[^\r\n]+\})/.exec(diagnostic)?.[1];const value=text?JSON.parse(text):undefined;
        if(typeof value?.message==='string'&&value.message.length<=1024)serviceMessage=value.message;
        else if(Array.isArray(value?.errorKeys))serviceMessage=`Response fields: ${value.errorKeys.join(',')}`;
      }catch{}
      const messages:Record<string,string>={
        'privacy-or-access-denied':'Xbox did not authorize this message. Check your Xbox communication and privacy permissions.',
        'sign-in-required':'Sign in through Nexus Settings again before sending Xbox messages.',
        'rate-limited':'Xbox is limiting chat requests. Wait a moment before trying again.',
        'send-unconfirmed':'Xbox did not confirm this message. Refresh the conversation before trying again.',
        'party-already-active':'You already have an Xbox party active. Leave it or join it before creating another.',
        'party-permission-denied':'Xbox did not authorize this party request. Check your Xbox communication permissions.',
        'party-rate-limited':'Xbox is limiting party requests. Wait a moment before trying again.',
        'party-offer-shape':'The voice connection could not be prepared. Reopen Xbox Social and try again.',
        'people-mutation-uncertain':'Xbox did not confirm whether this change completed. Refresh the profile before trying again.',
        'people-relationship-changed':'The relationship changed. Refresh this profile and select the action again.',
        'people-permission-denied':'Xbox did not authorize this player action. Check your account’s social and privacy permissions.',
        'people-rate-limited':'Xbox is limiting social requests. Wait a moment before refreshing.',
        'people-relationship-unavailable':'Xbox could not establish this player’s current relationship. Refresh the profile to check again.',
        'people-self-action':'You cannot perform this relationship action on your own Xbox profile.',
      };
      return new Error((stage&&messages[stage])||'Xbox social request failed. Check your connection and account permissions, then try again.',{cause:{stage,status:status?Number(status):undefined,serviceMessage}});
}

export async function readXboxSocial(binary: string, args: string[], input: string | undefined, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if(await supportsSocialBroker(binary)){signal.throwIfAborted();return readSocialBroker(binary,args,input,signal,socialFailure);}
  signal.throwIfAborted();
  const task = spawnTracked(binary, ['native-social',...args], { stdoutOnly: true, maxOutput: 8_000_000, env: { ...process.env, XODUS_LOG: 'error' } });
  let diagnostic='';
  task.child.stderr.on('data',(bytes:Buffer)=>{diagnostic=(diagnostic+bytes.toString('utf8')).slice(-8192);});
  task.child.stdin.on('error', () => {});
  task.child.stdin.end(input);
  const stop = () => task.child.kill('SIGTERM');
  signal.addEventListener('abort',stop,{once:true});
  if (signal.aborted) stop();
  const timer = setTimeout(stop,args[0]==='send-message'?60_000:50_000);timer.unref();
  try {
    const result = await task.result;
    signal.throwIfAborted();
    if (result.code !== 0) {
      throw socialFailure(diagnostic);
    }
    return result.output;
  } finally {clearTimeout(timer);signal.removeEventListener('abort',stop);}
}

/** Backend-only authentication; no remote web page, token IPC, or message history on disk. */
export class XboxSocial {
  private readonly controllers = new Set<AbortController>();
  private readonly reads = new Map<string, { connection: Connection; expires: number; promise: Promise<unknown[]> }>();
  private readonly peopleReads = new Map<string,{connection:Connection;expires:number;promise:Promise<unknown>}>();
  private readonly peopleMutations = new Set<string>();
  constructor(private readonly connection: () => Connection | undefined, private readonly reader: Reader = readXboxSocial) {}
  clear(): void {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();this.reads.clear();this.peopleReads.clear();
  }
  private async peopleRequest(operation:string,fields:Record<string,string>={},mutating=false):Promise<unknown>{
    const connection=this.connection();if(!connection)throw Error('Sign in and use a Nexus backend with Xbox social support.');
    const key=JSON.stringify([operation,fields]),cached=this.peopleReads.get(key);
    if(!mutating&&cached&&cached.connection.account===connection.account&&cached.connection.binary===connection.binary&&cached.expires>Date.now())return cached.promise;
    const controller=new AbortController();this.controllers.add(controller);
    const promise=(async()=>{
      const output=await this.reader(connection.binary,['people'],JSON.stringify({account:connection.account,operation,...fields}),controller.signal);
      controller.signal.throwIfAborted();const current=this.connection();
      if(!current||current.account!==connection.account||current.binary!==connection.binary)throw Error('Xbox account changed. Open Social again.');
      if(output.length>8_000_000)throw Error('Xbox social response is too large.');
      const value:unknown=JSON.parse(output);
      if(!object(value)||value.schema!==1||value.account!==connection.account||value.kind!=='people'||value.operation!==operation)throw Error('Xbox social response has the wrong account or format.');
      const result=value.result;
      if(mutating){if(!object(result)||result.success!==true||result.xuid!==fields.xuid)throw Error('Xbox did not confirm this player action.');return;}
      if(operation==='relationship'){
        if(!relationship(result)||result.xuid!==fields.xuid)throw Error('Xbox returned a different player relationship.');return cleanRelationship(result);
      }
      if(operation==='profile'){
        const details=cleanDetails(result);if(fields.xuid!=='me'&&details.xuid!==fields.xuid)throw Error('Xbox returned a different player profile.');return details;
      }
      if(!object(result)||!Array.isArray(result.items)||result.items.length>100||result.continuation!==undefined&&result.continuation!==null&&!string(result.continuation,2048)||result.truncated!==undefined&&typeof result.truncated!=='boolean')throw Error('Xbox returned an invalid people list.');
      if(operation==='games')return {items:result.items.map(cleanGame),continuation:result.continuation??null,truncated:result.truncated===true};
      return {items:result.items.map(cleanPerson),...(result.continuation===undefined?{}:{continuation:result.continuation}),...(result.truncated===undefined?{}:{truncated:result.truncated})};
    })().finally(()=>this.controllers.delete(controller));
    if(!mutating){this.peopleReads.set(key,{connection,expires:Date.now()+5000,promise});void promise.catch(()=>{if(this.peopleReads.get(key)?.promise===promise)this.peopleReads.delete(key);});}
    return promise;
  }
  people(list:XboxPeopleList,query?:string):Promise<XboxPeoplePage>{
    if(!peopleLists.has(list))return Promise.reject(Error('Select an Xbox people list.'));
    if(list==='search'&&(!string(query,64)||query.trim().length<2))return Promise.reject(Error('Enter at least two characters of a gamertag.'));
    return this.peopleRequest(list,list==='search'?{query:query!.trim()}:{}) as Promise<XboxPeoplePage>;
  }
  relationship(xuid:string):Promise<XboxRelationship>{
    if(!id(xuid))return Promise.reject(Error('Select an Xbox player.'));
    return this.peopleRequest('relationship',{xuid}) as Promise<XboxRelationship>;
  }
  details(xuid:string):Promise<XboxPlayerDetails>{
    if(xuid!=='me'&&!id(xuid))return Promise.reject(Error('Select an Xbox player.'));
    return this.peopleRequest('profile',{xuid}) as Promise<XboxPlayerDetails>;
  }
  games(xuid:string):Promise<XboxProfileGames>{
    if(xuid!=='me'&&!id(xuid))return Promise.reject(Error('Select an Xbox player.'));
    return this.peopleRequest('games',{xuid}) as Promise<XboxProfileGames>;
  }
  async changeRelationship(account:string,xuid:string,action:XboxRelationshipAction):Promise<void>{
    if(this.connection()?.account!==account)throw Error('Xbox account changed. Open Social again.');
    if(!id(xuid)||!relationshipActions.has(action))throw Error('Select an Xbox player action.');
    const key=JSON.stringify([account,xuid]);if(this.peopleMutations.has(key))throw Error('Wait for the current player action to finish.');
    this.peopleMutations.add(key);
    // A lost acknowledgement must never duplicate a friend request or block operation.
    try{await this.peopleRequest(action,{xuid},true);}finally{this.peopleMutations.delete(key);this.peopleReads.clear();this.reads.delete('friends');}
  }
  private async request(kind: string, args: string[], input?: string): Promise<unknown[]> {
    const connection = this.connection();
    if (!connection) throw Error('Sign in and use a Nexus backend with Xbox social support.');
    const key = args.join(':');
    const cached = this.reads.get(key);
    if (input === undefined && cached && cached.connection.account === connection.account && cached.connection.binary === connection.binary && cached.expires > Date.now()) return cached.promise;
    const controller = new AbortController();this.controllers.add(controller);
    const promise = (async () => {
      const output = await this.reader(connection.binary,args,input,controller.signal);
      controller.signal.throwIfAborted();
      const current = this.connection();
      if (!current || current.account !== connection.account || current.binary !== connection.binary) throw Error('Xbox account changed. Open Social again.');
      if (output.length > 8_000_000) throw Error('Xbox social response is too large.');
      const value: unknown = JSON.parse(output);
      if (!object(value) || value.schema !== 1 || value.account !== connection.account || value.kind !== kind || !Array.isArray(value.items)) throw Error('Xbox social response has the wrong account or format.');
      const check = kind === 'friends' ? friend : kind === 'profile'?playerProfile:kind === 'inbox' ? conversation : kind === 'conversation' ? message : (item: unknown) => object(item) && string(item.id,256);
      if (value.items.length > (kind === 'friends' ? 2000 : 100) || !value.items.every(check)) throw Error('Xbox social response has an invalid format.');
      if(kind==='sent'&&(value.items.length!==1||!value.items[0].id.trim()||/[\x00-\x1f\x7f]/.test(value.items[0].id)))throw Error('Xbox did not confirm this message.');
      if(kind==='conversation'){
        const messages=value.items as XboxMessage[];
        if(new Set(messages.map(message=>message.id)).size!==messages.length||messages.some(message=>message.timestamp===null||message.sender==='0'||(message.mine?message.sender===args[1]:message.sender!==args[1])))throw Error('Xbox returned a different conversation.');
        messages.sort((a,b)=>Date.parse(a.timestamp!)-Date.parse(b.timestamp!));
      }
      return cleanItems(kind,value.items);
    })().finally(() => this.controllers.delete(controller));
    if (input === undefined) {
      while(this.reads.size>=128)this.reads.delete(this.reads.keys().next().value!);
      this.reads.set(key,{connection,expires:Date.now()+(kind==='conversation'?3_000:kind==='inbox'?15_000:30_000),promise});
      void promise.catch(() => {if (this.reads.get(key)?.promise === promise) this.reads.delete(key);});
    }
    return promise;
  }
  friends(): Promise<XboxFriend[]> {return this.request('friends',['friends']) as Promise<XboxFriend[]>;}
  inbox(): Promise<XboxConversation[]> {return this.request('inbox',['inbox']) as Promise<XboxConversation[]>;}
  async profile(xuid:string):Promise<XboxPlayerProfile>{
    if(xuid!=='me'&&!id(xuid))throw Error('Select an Xbox player to view their profile.');
    const items=await this.request('profile',['profile',xuid]) as XboxPlayerProfile[];
    if(items.length!==1||(xuid!=='me'&&items[0].xuid!==xuid))throw Error('Xbox returned a different player profile.');return items[0];
  }
  conversation(xuid: string): Promise<XboxMessage[]> {
    if (!id(xuid)) return Promise.reject(Error('Select an Xbox player to open chat.'));
    return this.request('conversation',['conversation',xuid]) as Promise<XboxMessage[]>;
  }
  async send(account: string, xuid: string, text: string): Promise<XboxMessageReceipt> {
    if (this.connection()?.account !== account) throw Error('Xbox account changed. Open Social again.');
    if (!id(xuid) || !string(text,1024) || !text.trim() || [...text].length > 256) throw Error('Choose a player and enter a message of 1–256 characters.');
    // No retry: a lost acknowledgement must not duplicate a sent message.
    // A read started during the POST must not leave pre-send history cached.
    this.reads.delete('inbox');this.reads.delete(`conversation:${xuid}`);
    try{return (await this.request('sent',['send-message'],JSON.stringify({account,xuid,text})))[0] as XboxMessageReceipt;}
    finally{this.reads.delete('inbox');this.reads.delete(`conversation:${xuid}`);}
  }
}
