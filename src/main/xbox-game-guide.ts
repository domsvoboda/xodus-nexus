import {spawn,execFile,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {promisify} from 'node:util';
import type {XboxProfileRequest} from '../shared/types.js';
import {externalLauncherEnvironment} from './launcher-environment.js';
import {XboxGuideServer,type GuideEvent,type GuideInitial} from './xbox-guide-server.js';

export type GuideMonitor={x:number;y:number;width:number;height:number};
const monitorUnavailable='Nexus Guide could not locate the game window on a supported display. Keep the game open and try again.';
type Options={directory:string;helper:string;account:()=>string|undefined;initial:()=>GuideInitial;invoke:(method:string,args:unknown[])=>Promise<unknown>;problem:(message:string)=>void;monitor:()=>GuideMonitor;enabled:()=>boolean};
export async function checkGuideHost(helper:string):Promise<void>{
 try{
  const {stdout}=await promisify(execFile)('/usr/bin/python3',['-B',helper,'--check'],{env:externalLauncherEnvironment(process.env),timeout:3000,maxBuffer:8192});
  if(JSON.parse(stdout).ready!==true)throw Error('unavailable');
 }catch{throw Error('Nexus Guide requires Python 3, PyGObject, GTK 3 and WebKitGTK 4.1. Install these dependencies and try again.');}
}
export function gameGuideMonitor(value:GuideMonitor):GuideMonitor{
 if(!value||!['x','y','width','height'].every(key=>Number.isSafeInteger(value[key as keyof GuideMonitor]))||Math.abs(value.x)>131072||Math.abs(value.y)>131072||value.width<=0||value.height<=0||value.width>32768||value.height>32768)throw Error('Nexus Guide monitor unavailable.');
 return {x:value.x,y:value.y,width:value.width,height:value.height};
}

/** A game-session view using standard display bounds. Desktop windows and shared audio have independent lifetimes. */
export class XboxGameGuide {
  private game?:{id:string;title:string;pid?:number};
  private view?:{monitor:GuideMonitor};
  private http?:XboxGuideServer;
  private child?:ChildProcessWithoutNullStreams;
  private opening?:Promise<void>;
  private visible=false;
  private wanted=false;
  private generation=0;
  private session?:string;
  private checking?:Promise<void>;
  private profile?:XboxProfileRequest;
  private profileClosed?:()=>void;
  private watch?:ReturnType<typeof setInterval>;
  private readonly closing=new Set<Promise<void>>();
  constructor(private readonly options:Options){}
  get profileRequest():XboxProfileRequest|undefined{return this.profile?{...this.profile}:undefined;}
  get shown():boolean{return this.visible||this.wanted;}
  get interactive():boolean{return this.visible&&this.wanted&&Boolean(this.game)&&this.options.enabled()&&this.session===this.options.account();}
  get bound():boolean{return Boolean(this.game);}
  bind(id:string,title:string,pid?:number):void{
    if(this.game?.id===id&&this.game.pid===pid)return;
    if(pid!==undefined&&(!Number.isSafeInteger(pid)||pid<=0||pid>=2**31))throw Error('Invalid Guide game process.');
    this.unbind();this.game={id,title,pid};
    void this.refresh();this.watch=setInterval(()=>void this.refresh(),1000);this.watch.unref();

  }
  unbind(id?:string):void{
    if(id&&this.game?.id!==id)return;
    this.game=undefined;this.view=undefined;clearInterval(this.watch);this.watch=undefined;
    this.reset();
  }
  reset():void{
    this.generation++;this.opening=undefined;this.hide(false);this.session=undefined;this.view=undefined;
    const child=this.child;this.child=undefined;
    if(child){
      // A stuck GTK/WebKit helper must not survive its account or game session.
      const close=new Promise<void>(resolve=>{
        let term:ReturnType<typeof setTimeout>,kill:ReturnType<typeof setTimeout>;
        const done=()=>{clearTimeout(term);clearTimeout(kill);resolve();};
        child.once('exit',done);child.once('error',done);
        term=setTimeout(()=>{child.kill('SIGTERM');},500);term.unref();
        kill=setTimeout(()=>{child.kill('SIGKILL');},1500);kill.unref();
        child.stdin.end('quit\n');
        if(child.exitCode!==null||child.signalCode!==null)done();
      });
      this.closing.add(close);void close.finally(()=>this.closing.delete(close));
    }
    const server=this.http;this.http=undefined;
    if(server){const close=server.stop();this.closing.add(close);void close.finally(()=>this.closing.delete(close));}
  }
  private async refresh():Promise<void>{
    if(this.checking)return this.checking;if(!this.game)return;
    const bound=this.game;
    const checking=(async()=>{try{
      const account=this.options.account();
      if(!this.options.enabled()||!account){if(this.http)this.reset();this.view=undefined;return;}
      if(this.http&&this.session!==account)this.reset();
      // Pin the chosen display while the view lives, not the moving cursor.
      const next=this.http&&this.view?this.view:{monitor:gameGuideMonitor(this.options.monitor())};
      if(this.game!==bound)return;
      this.view=next;
    }catch{if(this.shown)this.hide(false);this.view=undefined;}
    })();this.checking=checking;
    try{await checking;}finally{if(this.checking===checking)this.checking=undefined;}
  }
  async toggle():Promise<boolean>{
    if(this.shown){this.hide();return true;}
    if(!this.game||!this.options.enabled())return false;
    await this.refresh();if(!this.view)return false;
    const bound=this.game;
    void this.show().catch(error=>{if(this.game===bound)this.options.problem(error instanceof Error&&error.message===monitorUnavailable?monitorUnavailable:'Nexus Guide could not open. Reopen the guide and try again.');});
    return true;
  }
  showProfile(id:string,xuid:string,closed:()=>void):void{
    if(this.profile||!this.game||!this.options.enabled())throw Error('Enable the Nexus Guide in Nexus Settings to view game profiles.');
    this.profile={id,xuid};this.profileClosed=closed;this.publish('profile',this.profileRequest);
    void this.show().catch(error=>{if(this.profile?.id===id){this.hide(false);this.options.problem(error instanceof Error&&error.message===monitorUnavailable?monitorUnavailable:'Nexus Guide could not display the player profile.');}});
  }
  completeProfile(id:string,hide=true):void{
    if(this.profile?.id!==id)return;
    this.profile=undefined;const closed=this.profileClosed;this.profileClosed=undefined;closed?.();this.publish('profile',undefined);
    if(hide)this.hide();
  }
  private async show():Promise<void>{
    if(!this.view)await this.refresh();
    if(!this.options.enabled())throw Error('Enable the Nexus Guide in Nexus Settings.');
    this.wanted=true;
    if(this.opening){await this.opening;if(this.wanted)this.child?.stdin.write('show\n');return;}
    if(this.child){this.child.stdin.write('show\n');return;}
    if(!this.game||!this.view||!this.options.account()){this.wanted=false;throw Error('Nexus Guide game session unavailable.');}
    const generation=this.generation,view=this.view,account=this.options.account();this.session=account;
    const opening=(async()=>{
      const session=()=>generation===this.generation&&this.game&&this.options.enabled()?this.options.account():undefined;
      const server=new XboxGuideServer({...this.options,account:session,initial:()=>({...this.options.initial(),profile:this.profileRequest,visibility:this.visible}),invoke:async(method,args)=>{
        if(method==='closeXboxGuide'){this.hide();return;}
        if(method==='getXboxProfileRequest')return this.profileRequest;
        if(method==='completeXboxProfileRequest'){
          if(typeof args[0]!=='string'||args[1]!==undefined&&typeof args[1]!=='boolean')throw Error('Invalid player profile request.');
          this.completeProfile(args[0],args[1] as boolean|undefined);return;
        }
        return this.options.invoke(method,args);
      }});this.http=server;
      const url=await server.start();
      if(generation!==this.generation||this.options.account()!==account||!this.options.enabled()){await server.stop();return;}
      const child=spawn('/usr/bin/python3',[this.options.helper],{env:externalLauncherEnvironment(process.env),stdio:['pipe','pipe','pipe']});this.child=child;
      child.stdin.on('error',()=>{});child.stderr.resume();
      await new Promise<void>((resolve,reject)=>{
        let ready=false,pending='';
        const timer=setTimeout(()=>{reject(Error('Nexus Guide load timed out.'));if(generation===this.generation)this.reset();else child.stdin.end('quit\n');},35_000);timer.unref();
        const failed=()=>{clearTimeout(timer);if(!ready)reject(Error('Nexus Guide host exited.'));if(this.child===child){this.child=undefined;this.hide(false);if(ready&&generation===this.generation)this.options.problem('Nexus Guide closed unexpectedly. Reopen the guide and try again.');}void server.stop();if(this.http===server)this.http=undefined;};
        child.once('error',failed);child.once('exit',failed);
        child.stdout.on('data',bytes=>{
          if(generation!==this.generation||this.child!==child)return;
          pending=(pending+bytes.toString()).slice(-8192);const lines=pending.split('\n');pending=lines.pop()??'';
          for(const line of lines){try{const value=JSON.parse(line);
            if(value.event==='ready'){ready=true;clearTimeout(timer);resolve();}
            if(value.event==='shown'){this.visible=this.wanted;this.publish('visibility',this.visible);if(!this.wanted)child.stdin.write('hide\n');}
            if(value.event==='hidden'){this.visible=false;this.wanted=false;this.publish('visibility',false);if(this.profile)this.completeProfile(this.profile.id,false);}
            if(value.event==='error'){reject(Error(value.code==='game-monitor-unavailable'?monitorUnavailable:'Nexus Guide host unavailable.'));this.reset();}
          }catch{}}
        });
        child.stdin.write(JSON.stringify({url,token:server.token,monitor:view.monitor,...(this.game?.pid?{gamePid:this.game.pid}:{})})+'\n');
      });
      if(generation===this.generation&&this.wanted)child.stdin.write('show\n');
    })();this.opening=opening;
    try{await opening;}catch(error){if(generation===this.generation)this.reset();throw error;}
    finally{if(this.opening===opening)this.opening=undefined;}
  }
  hide(restore=true):void{
    const was=this.shown;this.wanted=false;this.visible=false;this.publish('visibility',false);this.child?.stdin.write('hide\n');
    if(this.profile)this.completeProfile(this.profile.id,false);
    // Unmapping returns focus naturally; never raise the game from a desktop shortcut.
    if(restore&&was)void this.refresh();
  }
  publish(event:GuideEvent,value:unknown):void{this.http?.publish(event,value);}
  async shutdown():Promise<void>{
    this.unbind();
    await Promise.allSettled([...this.closing]);
  }
}
