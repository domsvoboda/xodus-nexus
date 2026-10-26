import {createServer,type Socket} from 'node:net';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {emptyGameInvites,inviteGuid,validateGameInviteUri,type GameInviteState} from '../shared/game-invites.js';
import {xboxUserId} from '../shared/social.js';
import type {XboxTitlePresence} from './xbox-title-presence.js';
const INVALID=0x80070057,ABORT=0x80004004,PENDING=0x8000000a,DENIED=0x80070005;
export function encodeInviteFields(fields:string[]):Buffer{
  const values=fields.map(value=>Buffer.from(value,'utf8'));const count=Buffer.alloc(4);count.writeUInt32LE(values.length);
  return Buffer.concat([count,...values.flatMap(value=>{const length=Buffer.alloc(4);length.writeUInt32LE(value.length);return [length,value];})]);
}
export function decodeInviteFields(body:Buffer):string[]{
  if(body.length<4||body.length>32768)throw Error('Invalid invite frame.');
  const count=body.readUInt32LE(0);if(count>16)throw Error('Invalid invite field count.');
  const fields:string[]=[];let offset=4;
  for(let i=0;i<count;i++){
    if(offset+4>body.length)throw Error('Truncated invite frame.');const length=body.readUInt32LE(offset);offset+=4;
    if(length>8192||offset+length>body.length)throw Error('Invalid invite field size.');
    fields.push(new TextDecoder('utf-8',{fatal:true}).decode(body.subarray(offset,offset+length)));offset+=length;
  }
  if(offset!==body.length||fields.some(value=>value.includes('\0')))throw Error('Invalid invite frame.');return fields;
}
type Outgoing={id:string;phase:GameInviteState['outgoing'][number]['phase'];recipient?:string;expires:number};
type Incoming={id:string;uri:string;sender:string;expires:number};
/** One random capability and one bound account/title per launch. Memory only. */
export class GameInviteBridge {
  private user?:string;
  private requests=new Map<string,Outgoing>();
  private invitations=new Map<string,Incoming>();
  private events:{sequence:number;fields:string[]}[]=[];
  private lastSeen=0;
  private sequence=0;
  private stopped=false;
  private stopping?:Promise<void>;
  private clients=new Set<Socket>();
  private server?:ReturnType<typeof createServer>;
  readonly key=randomBytes(32).toString('hex');
  port=0;
  constructor(readonly id:string,readonly game:string,readonly titleId:string,private current:()=>boolean,private changed:()=>void,private show:()=>void,private now=Date.now,private notified:(sender:string)=>void=()=>{},private presence?:XboxTitlePresence){}
  async start():Promise<void>{
    if(this.server)throw Error('Invite bridge already started.');
    const expected=Buffer.from(this.key,'ascii');
    const server=this.server=createServer(client=>{
      if(this.clients.size>=8||this.stopped){client.destroy();return;}
      this.clients.add(client);client.once('close',()=>this.clients.delete(client));client.on('error',()=>client.destroy());
      client.setTimeout(5000,()=>client.destroy());let bytes=Buffer.alloc(0),handled=false;
      client.on('data',(chunk:Buffer)=>{
        if(handled)return;bytes=Buffer.concat([bytes,chunk]);
        if(bytes.length>32840){client.destroy();return;}if(bytes.length<72)return;
        if(!timingSafeEqual(bytes.subarray(0,64),expected)||bytes.toString('ascii',64,68)!=='NXSI'){client.destroy();return;}
        const length=bytes.readUInt32LE(68);if(length>32768){client.destroy();return;}if(bytes.length<72+length)return;
        handled=true;let status=INVALID,fields:string[]=[];
        try{if(bytes.length!==72+length)throw Error('Trailing bytes');[status,fields]=this.exchange(decodeInviteFields(bytes.subarray(72)));}catch{/* Fixed HRESULT only, never payload diagnostics. */}
        const payload=encodeInviteFields(fields),header=Buffer.alloc(8);header.writeUInt32LE(payload.length+4);header.writeUInt32LE(status,4);client.end(Buffer.concat([header,payload]));
      });
    });
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
    const address=server.address();if(!address||typeof address==='string')throw Error('Invite loopback unavailable.');this.port=address.port;
  }
  private prune():void{for(const [id,value]of this.invitations)if(value.expires<=this.now())this.invitations.delete(id);for(const [id,value]of this.requests)if(value.expires<=this.now()){if(['choosing','sending'].includes(value.phase)){value.phase='cancelled';value.expires=this.now()+10000;}else this.requests.delete(id);}}
  state():GameInviteState{if(this.stopped||!this.current())return emptyGameInvites();this.prune();return {active:this.lastSeen&&this.now()-this.lastSeen<20000?[{id:this.id,game:this.game}]:[],outgoing:[...this.requests.values()].map(value=>({id:this.id+':'+value.id,game:this.game,phase:value.phase})),incoming:[...this.invitations.values()].map(value=>({id:this.id+':'+value.id,game:this.game,sender:value.sender,expires:value.expires}))};}
  exchange(fields:string[]):[number,string[]]{
    if(this.stopped||!this.current())return [DENIED,[]];this.prune();const [op,...args]=fields;
    if(op==='presence-ready'&&args.length===0)return [this.presence?0:0x80004001,[]];
    if(op==='presence'&&args.length===5&&xboxUserId(args[0])&&args[1]===this.titleId){
      if(this.user&&this.user!==args[0])return [DENIED,[]];
      if(!this.presence?.accept(args[0],args[2],args[3],args[4]))return [DENIED,[]];
      this.user=args[0];return [0,[]];
    }
    if((op==='hello'||op==='hello-events')&&args.length===2&&xboxUserId(args[0])&&args[1]===this.titleId){if(this.user&&this.user!==args[0])return [DENIED,[]];this.user=args[0];if(op==='hello-events'){const fresh=!this.lastSeen||this.now()-this.lastSeen>=20000;this.lastSeen=this.now();if(fresh)this.changed();}return [0,[]];}
    if(!this.user)return [DENIED,[]];
    if(op==='present-activity'&&args.length===1&&inviteGuid(args[0])){if(this.requests.has(args[0])||this.requests.size>=16)return [INVALID,[]];this.requests.set(args[0],{id:args[0],phase:'choosing',expires:this.now()+180000});this.changed();this.show();return [0,[]];}
    if(op==='present'&&args.length===6&&inviteGuid(args[0])&&inviteGuid(args[1])&&args[2].length>0&&args[2].length<=100&&args[3].length>0&&args[3].length<=100&&args.slice(2).every(value=>value.length<=1024&&!/[\x00-\x1f\x7f]/.test(value))){
      if(this.requests.has(args[0])||this.requests.size>=16)return [INVALID,[]];this.requests.set(args[0],{id:args[0],phase:'choosing',expires:this.now()+180000});this.changed();this.show();return [0,[]];
    }
    if(op==='selection'&&args.length===1){const value=this.requests.get(args[0]);if(!value)return [INVALID,[]];if(value.phase==='choosing')return [PENDING,[]];return value.phase==='sending'&&value.recipient?[0,[value.recipient]]:[ABORT,[]];}
    if(op==='complete'&&args.length===2&&/^\d{1,10}$/.test(args[1])){const value=this.requests.get(args[0]);if(!value||value.phase!=='sending')return [INVALID,[]];value.phase=args[1]==='0'?'sent':'failed';this.changed();return [0,[]];}
    if(op==='cancel'&&args.length===1){const value=this.requests.get(args[0]);if(value&&['choosing','sending'].includes(value.phase))value.phase='cancelled';this.changed();return [0,[]];}
    if(op==='notify'&&args.length===4&&inviteGuid(args[0])&&validateGameInviteUri(args[1],this.user)&&args[2].length<=128&&!/[\x00-\x1f\x7f]/.test(args[2])){
      const expires=Number(args[3]);if(!Number.isSafeInteger(expires)||expires<=this.now()||expires>this.now()+86400000||this.invitations.size>=32)return [INVALID,[]];
      if(!this.invitations.has(args[0])){const sender=args[2]||'Xbox player';this.invitations.set(args[0],{id:args[0],uri:args[1],sender,expires});this.changed();this.notified(sender);}return [0,[]];
    }
    if(op==='events'&&args.length===1&&/^\d{1,10}$/.test(args[0])){const event=this.events.find(value=>value.sequence>Number(args[0]));return event?[0,[String(event.sequence),...event.fields]]:[PENDING,[]];}
    if(op==='accept'&&args.length===1){const invite=[...this.invitations.values()].find(value=>value.uri===args[0]);if(!invite)return [INVALID,[]];this.accept(this.id+':'+invite.id);return [0,[]];}
    return [INVALID,[]];
  }
  choose(id:string,recipient:unknown):void{
    this.prune();if(this.stopped||!this.current()||!xboxUserId(recipient)||recipient===this.user)throw Error('Invitation is unavailable.');
    const value=this.requests.get(id.slice(this.id.length+1));if(!id.startsWith(this.id+':')||!value||value.phase!=='choosing')throw Error('Invitation is unavailable.');
    value.recipient=recipient;value.phase='sending';this.changed();
  }
  cancel(id:string):void{if(!id.startsWith(this.id+':'))return;const value=this.requests.get(id.slice(this.id.length+1));if(value&&value.phase==='choosing'){value.phase='cancelled';this.changed();}}
  invite(recipient:unknown):void{
    this.prune();if(!this.current()||this.stopped||!this.lastSeen||this.now()-this.lastSeen>=20000||!xboxUserId(recipient)||recipient===this.user||this.requests.size>=16)throw Error('The game is not ready for invitations.');
    if([...this.requests.values()].some(value=>value.phase==='sending'&&value.recipient===recipient))throw Error('An invitation is already being sent.');
    const id=randomUUID();this.requests.set(id,{id,recipient,phase:'sending',expires:this.now()+180000});
    this.events.push({sequence:++this.sequence,fields:['activity',id,recipient]});if(this.events.length>32)this.events.shift();this.changed();
  }
  accept(id:string):void{
    this.prune();if(!this.current()||this.stopped||!id.startsWith(this.id+':'))throw Error('Invitation is unavailable.');
    const key=id.slice(this.id.length+1),value=this.invitations.get(key);if(!value)throw Error('Invitation expired or was already accepted.');
    this.events.push({sequence:++this.sequence,fields:['accepted',value.uri]});if(this.events.length>32)this.events.shift();this.invitations.delete(key);this.changed();
  }
  stop():Promise<void>{
    if(this.stopping)return this.stopping;
    this.stopped=true;for(const client of this.clients)client.destroy();this.requests.clear();this.invitations.clear();this.events=[];
    this.stopping=(async()=>{if(this.server?.listening)await new Promise<void>(resolve=>this.server!.close(()=>resolve()));await this.presence?.stop();this.changed();})();
    return this.stopping;
  }
}
export function combinedInviteState(bridges:Iterable<GameInviteBridge>):GameInviteState{const state=emptyGameInvites();for(const bridge of bridges){const value=bridge.state();state.active.push(...value.active);state.outgoing.push(...value.outgoing);state.incoming.push(...value.incoming);}return state;}
