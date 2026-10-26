import {xboxUserId} from '../shared/social.js';

// Only the running title's genuine XUser token and PoP signatures authorize this.
export const titlePresenceBody='{"state":"active"}';
export const titlePresenceUrl=(user:string):string=>`https://userpresence.xboxlive.com/users/xuid(${user})/devices/current/titles/current`;
type Credentials={user:string;authorization:string;post:string;remove:string};
type Request=(url:string,init:RequestInit)=>Promise<Response>;
export class XboxTitlePresence {
  private credentials?:Credentials;
  private user?:string;
  private lastSeen=0;
  private nextAttempt=0;
  private sent=false;
  private closed=false;
  private pending?:Promise<void>;
  private abort?:AbortController;
  private timer?:ReturnType<typeof setInterval>;
  private closing?:Promise<void>;
  private retiring?:Promise<void>;
  constructor(private current:()=>boolean,private report:(line:string)=>void=()=>{},private request:Request=fetch,private now=Date.now){}
  private diagnostic(line:string):void{try{this.report(line);}catch{/* Optional presence must not fail a game because its log is unavailable. */}}
  accept(user:string,authorization:string,post:string,remove:string):boolean{
    if(this.closed||this.retiring||!this.current()||!xboxUserId(user)||(this.user&&this.user!==user))return false;
    if(!/^XBL3\.0 x=[A-Za-z0-9_-]{1,128};[\x21-\x7e]{1,8000}$/.test(authorization)||authorization.length>8192)return false;
    if(![post,remove].every(value=>/^[A-Za-z0-9+/]{102}==$/.test(value)))return false;
    this.user=user;this.credentials={user,authorization,post,remove};this.lastSeen=this.now();
    if(!this.timer){this.timer=setInterval(()=>{if(!this.current())void this.stop();else if(this.credentials&&!this.retiring&&this.now()-this.lastSeen>=90000)void this.retire();},1000);this.timer.unref();}
    if(!this.pending&&this.now()>=this.nextAttempt){
      this.nextAttempt=this.now()+30000;this.abort=new AbortController();
      const credentials=this.credentials;
      // Even a timed-out POST may have reached the service, so clean it up.
      this.sent=true;
      this.pending=this.send('POST',credentials,this.abort.signal).finally(()=>{this.pending=undefined;this.abort=undefined;});
    }
    return true;
  }
  private async send(method:'POST'|'DELETE',credentials:Credentials,cancel?:AbortSignal):Promise<void>{
    try{
      const signal=cancel?AbortSignal.any([cancel,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000);
      const response=await this.request(titlePresenceUrl(credentials.user),{
        method,redirect:'error',signal,headers:{Authorization:credentials.authorization,Signature:method==='POST'?credentials.post:credentials.remove,'x-xbl-contract-version':'3','Content-Type':'application/json'},
        ...(method==='POST'?{body:titlePresenceBody}:{}),
      });
      await response.body?.cancel().catch(()=>{});
      const success=method==='POST'?[200,201].includes(response.status):[200,204,404].includes(response.status);
      if(response.status===429){
        const retry=response.headers.get('retry-after')??'';
        const delay=/^\d{1,6}$/.test(retry)?Number(retry)*1000:Date.parse(retry)-this.now();
        this.nextAttempt=this.now()+Math.max(300000,Number.isFinite(delay)?Math.min(86400000,delay):0);
      }
      else if(response.status>=500)this.nextAttempt=this.now()+60000;
      // Never log responses, tokens, signatures or account identifiers.
      this.diagnostic(`Xbox title presence ${method==='POST'?'update':'cleanup'}: HTTP ${response.status}${success?'':' (not confirmed)'}.`);
    }catch{this.diagnostic(`Xbox title presence ${method==='POST'?'update':'cleanup'} was not confirmed.`);}
  }
  private retire():Promise<void>{
    if(this.retiring)return this.retiring;
    const credentials=this.credentials,sent=this.sent,pending=this.pending;
    this.credentials=undefined;this.sent=false;this.abort?.abort();
    this.retiring=(async()=>{await pending;if(sent&&credentials)await this.send('DELETE',credentials);})().finally(()=>{this.retiring=undefined;});
    return this.retiring;
  }
  stop():Promise<void>{
    if(this.closing)return this.closing;
    this.closed=true;if(this.timer)clearInterval(this.timer);this.timer=undefined;this.abort?.abort();
    this.closing=this.retire();
    return this.closing;
  }
}
