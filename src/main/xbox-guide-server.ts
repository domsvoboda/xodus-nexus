import {createServer,type Server,type ServerResponse} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';

const methods=new Set([
  'getXboxPlayerDetails','getXboxPlayerGames','getXboxPeople','getXboxRelationship','changeXboxRelationship',
  'getXboxPlayerProfile','getXboxProfileRequest','completeXboxProfileRequest','getXboxFriends',
  'getXboxInbox','getXboxConversation','sendXboxMessage','getXboxGameInviteAvailability','sendXboxGameInvite',
  'chooseGameInviteRecipient','cancelGameInvite','acceptGameInvite',
  'getXboxParty','getXboxVoiceState','getXboxActiveParties','getXboxInvites',
  'leaveExistingXboxParty','inviteXboxPartyFriend','controlXboxVoice',
  'closeXboxGuide',
]);
const media:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.woff':'font/woff','.woff2':'font/woff2','.svg':'image/svg+xml','.png':'image/png'};
export type GuideEvent='auth'|'party'|'voice'|'invites'|'profile'|'overlay'|'runtimeInvites'|'visibility'|'language';
export type GuideInitial=Partial<Record<GuideEvent,unknown>>&{auth:unknown;profile:unknown};
type Options={directory:string;account:()=>string|undefined;initial:()=>GuideInitial;invoke:(method:string,args:unknown[])=>Promise<unknown>};
const fail=(response:ServerResponse,status:number,message:string)=>{response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify({error:message}));};

/** Local view transport only. The game/account binding is revoked when either changes. */
export class XboxGuideServer {
  readonly token=randomBytes(32).toString('hex');
  private server?:Server;
  private bound?:string;
  private origin='';
  private readonly clients=new Set<ServerResponse>();
  private inflight=0;
  private timer?:ReturnType<typeof setInterval>;
  constructor(private readonly options:Options){}
  async start():Promise<string>{
    if(this.server)throw Error('Nexus Guide is already running.');
    this.bound=this.options.account();if(!this.bound)throw Error('Sign in to Nexus to open Nexus Guide.');
    const server=createServer((request,response)=>{void (async()=>{
      response.setHeader('Cache-Control','no-store');response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('Referrer-Policy','no-referrer');
      if(request.headers.host!==this.origin.slice(7))return fail(response,403,'Invalid Guide host.');
      const route=request.url??'';
      if(route==='/rpc'||route==='/events'){
        if(!this.bound||this.options.account()!==this.bound)return fail(response,401,'Xbox account changed. Reopen the Guide.');
        const auth=request.headers.authorization??'',expected=`Bearer ${this.token}`;
        if(Buffer.byteLength(auth)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(auth),Buffer.from(expected)))return fail(response,403,'Invalid Guide session.');
        if(request.headers.origin!==undefined&&request.headers.origin!==this.origin)return fail(response,403,'Invalid Guide origin.');
        if(route==='/events'){
          if(request.method!=='GET'||this.clients.size>=8)return fail(response,405,'Guide events unavailable.');
          response.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive','X-Accel-Buffering':'no'});
          this.clients.add(response);response.on('close',()=>this.clients.delete(response));
          for(const [event,value] of Object.entries(this.options.initial()))this.event(response,event,value);
          return;
        }
        if(request.method!=='POST'||!request.headers['content-type']?.startsWith('application/json'))return fail(response,405,'Invalid Guide request.');
        if(this.inflight>=16)return fail(response,429,'Wait for the current Guide request.');
        const chunks:Buffer[]=[];let size=0;
        for await(const chunk of request){size+=chunk.length;if(size>16_384)return fail(response,413,'Guide request too large.');chunks.push(chunk);}
        let value:unknown;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return fail(response,400,'Invalid Guide request.');}
        if(!value||typeof value!=='object'||Array.isArray(value))return fail(response,400,'Invalid Guide request.');
        const {method,args}=value as {method?:unknown;args?:unknown};
        if(Object.keys(value).some(key=>!['method','args'].includes(key))||typeof method!=='string'||!methods.has(method)||!Array.isArray(args)||args.length>4)return fail(response,400,'Unsupported Guide request.');
        if(this.inflight>=16)return fail(response,429,'Wait for the current Guide request.');
        this.inflight++;
        try{
          if(this.options.account()!==this.bound)return fail(response,401,'Xbox account changed.');
          const result=await this.options.invoke(method,args);
          if(!this.bound||this.options.account()!==this.bound)return fail(response,401,'Xbox account changed.');
          response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({result:result??null}));
        }catch(error){fail(response,400,error instanceof Error?error.message:'Nexus Guide request failed.');}
        finally{this.inflight--;}
        return;
      }
      if(request.method!=='GET')return fail(response,405,'Invalid Guide request.');
      if(route!=='/overlay.html'&&!/^\/assets\/[a-zA-Z0-9_.-]+$/.test(route))return fail(response,404,'Not found.');
      const filename=path.join(this.options.directory,route);
      const type=media[path.extname(filename)];if(!type)return fail(response,404,'Not found.');
      const bytes=await fs.readFile(filename).catch(()=>undefined);if(!bytes)return fail(response,404,'Not found.');
      response.writeHead(200,{'Content-Type':type,'Content-Security-Policy':"default-src 'self'; base-uri 'none'; frame-ancestors 'none'; frame-src 'none'; form-action 'none'; img-src 'self' data: https://store-images.s-microsoft.com https://images-assets-ssl.xboxlive.com https://images-eds-ssl.xboxlive.com https://gamerpic.xboxlive.com https://avatar-ssl.xboxlive.com https://xboxavatargamerpic.azureedge.net; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; media-src 'none'; object-src 'none'"});response.end(bytes);
    })().catch(()=>{if(!response.headersSent)fail(response,500,'Nexus Guide unavailable.');else response.end();});});
    this.server=server;server.requestTimeout=15_000;server.headersTimeout=10_000;server.maxConnections=16;server.on('clientError',(_error,socket)=>socket.destroy());
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
    const address=server.address();if(!address||typeof address==='string')throw Error('Nexus Guide address unavailable.');
    this.origin=`http://127.0.0.1:${address.port}`;
    this.timer=setInterval(()=>{if(this.options.account()!==this.bound){void this.stop();return;}for(const client of this.clients)this.write(client,': keepalive\n\n');},20_000);this.timer.unref();
    return `${this.origin}/overlay.html`;
  }
  private write(client:ServerResponse,frame:string):void{
    if(client.destroyed||client.writableLength+Buffer.byteLength(frame)>1_000_000){client.destroy();this.clients.delete(client);return;}
    client.write(frame);
  }
  private event(client:ServerResponse,event:string,value:unknown):void{
    this.write(client,`event: ${event}\ndata: ${JSON.stringify(value??null)}\n\n`);
  }
  publish(event:GuideEvent,value:unknown):void{
    if(!this.bound||this.options.account()!==this.bound)return;
    for(const client of this.clients)this.event(client,event,value);
  }
  async stop():Promise<void>{
    clearInterval(this.timer);this.bound=undefined;
    for(const client of this.clients)client.end();this.clients.clear();
    const server=this.server;this.server=undefined;
    if(server)await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});
  }
}
