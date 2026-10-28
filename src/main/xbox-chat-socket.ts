import { EventEmitter } from 'node:events';
import { readXboxSocial } from './xbox-native-social.js';

type Connection = {binary:string;account:string};
type Identity = {xuid:string;connectionId:string;serverNonce:string};
type Socket = Pick<WebSocket,'addEventListener'|'removeEventListener'|'send'|'close'>;
const bounded = (value: unknown,max:number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

/** Chat/party push transport. The short-lived socket key never leaves the main process. */
export class XboxChatSocket extends EventEmitter {
  private socket?: Socket;
  private controller?: AbortController;
  private generation=0;
  private sequence=0;
  private identity?: Identity;
  private bound?: Connection;
  private starting?: Promise<Identity>;
  constructor(private readonly connection:()=>Connection|undefined,
    private readonly read=readXboxSocial,
    private readonly createSocket:(url:string,protocol:string)=>Socket=(url,protocol)=>new WebSocket(url,protocol)) {super();}
  private send(channel: {type:string;id?:string},messageType:string): void {
    this.socket?.send(JSON.stringify({clientSeqNum:++this.sequence,channel,messageType}));
  }
  connect(): Promise<Identity> {
    const connection=this.connection();
    if(this.bound&&(this.bound.account!==connection?.account||this.bound.binary!==connection?.binary))this.close();
    if(this.identity && this.bound?.account===connection?.account && this.bound?.binary===connection?.binary)return Promise.resolve(this.identity);
    if(this.identity)this.close();
    if(this.starting)return this.starting;
    if(!connection)return Promise.reject(Error('Sign in to connect Xbox social.'));
    this.bound={...connection};
    const generation=++this.generation;
    const controller=new AbortController();this.controller=controller;
    const job=this.open(controller.signal,generation);
    this.starting=job;
    void job.catch(()=>{if(this.generation===generation)this.close();}).finally(()=>{if(this.starting===job)this.starting=undefined;});
    return job;
  }
  private async open(signal: AbortSignal,generation:number): Promise<Identity> {
    const connection=this.connection();if(!connection)throw Error('Sign in to connect Xbox social.');
    const output=await this.read(connection.binary,['chat-auth'],undefined,signal);signal.throwIfAborted();
    if(output.length>64*1024)throw Error('Invalid Xbox socket credentials.');
    const result=JSON.parse(output);
    if(result.schema!==1 || result.kind!=='chat-auth' || result.account!==connection.account || this.connection()?.account!==connection.account || this.connection()?.binary!==connection.binary
      || !bounded(result.xuid,20) || !/^[1-9][0-9]*$/.test(result.xuid) || BigInt(result.xuid)>18446744073709551615n || !bounded(result.authKey,16*1024)) throw Error('Xbox socket account changed or authentication failed.');
    const socket=this.createSocket(`wss://chat.xboxlive.com/users/xuid(${result.xuid})/chat/connect?AuthKey=${encodeURIComponent(result.authKey)}`,'chat');
    this.socket=socket;
    // Never emit or log the authentication response, WebSocket URL, or raw error object.
    return await new Promise<Identity>((resolve,reject)=>{
      let settled=false;
      let disconnected=false;
      const fail=()=>{if(!settled){settled=true;clearTimeout(timer);reject(Error('Xbox social socket disconnected before its handshake completed.'));}
        if(generation===this.generation && !disconnected){disconnected=true;this.identity=undefined;this.bound=undefined;this.emit('disconnected');}};
      const timer=setTimeout(()=>{fail();socket.close();},20_000);timer.unref();
      const aborted=()=>{fail();socket.close();};signal.addEventListener('abort',aborted,{once:true});
      socket.addEventListener('open',()=>{if(generation===this.generation)this.send({type:'System'},'WhoAmI');});
      socket.addEventListener('error',fail);
      socket.addEventListener('close',()=>{signal.removeEventListener('abort',aborted);fail();});
      socket.addEventListener('message',event=>{
        if(generation!==this.generation || signal.aborted || this.connection()?.account!==connection.account || this.connection()?.binary!==connection.binary){aborted();return;}
        if(typeof event.data!=='string' || event.data.length>256*1024){aborted();return;}
        try {
          const message=JSON.parse(event.data);
          if(message.channel?.type==='System' && message.messageType==='WhoAmI' && !settled) {
            if(!bounded(message.connectionId,512) || !bounded(message.serverNonce,4096)){aborted();return;}
            settled=true;clearTimeout(timer);this.identity={xuid:result.xuid,connectionId:message.connectionId,serverNonce:message.serverNonce};this.bound=connection;
            this.send({type:'Party',id:result.xuid},'JoinChannel');resolve(this.identity);
          } else if(message.channel?.type==='Party' && message.channel.id===result.xuid && message.messageType==='Party') {
            const payload=message.payload;
            if(payload?.type==='ShoulderTap' && bounded(payload.partyId,128) && Number.isSafeInteger(payload.changeNumber))this.emit('party-changed',{partyId:payload.partyId,changeNumber:payload.changeNumber});
            else if(payload?.type==='Kicked')this.emit('party-removed');
          }
        }catch{aborted();}
      });
    });
  }
  close(): void {
    this.generation++;this.controller?.abort();this.controller=undefined;this.socket?.close();this.socket=undefined;this.identity=undefined;this.bound=undefined;this.starting=undefined;this.sequence=0;
  }
}
