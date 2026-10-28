import {BrowserWindow,ipcMain} from 'electron';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import type {XboxVoiceCommand,XboxVoiceState} from '../shared/types.js';

type Options={authorizeControl:(event:Electron.IpcMainInvokeEvent)=>boolean;stateChanged:(state:XboxVoiceState)=>void;leave:()=>Promise<void>;settled?:()=>void;canConnect?:()=>boolean};
type Pending={id:string;command:XboxVoiceCommand;resolve:()=>void;reject:(error:Error)=>void;timer?:ReturnType<typeof setTimeout>};
const channels=['xbox-voice-state','xbox-voice-control','xbox-voice-owner-ready','xbox-voice-owner-state','xbox-voice-owner-complete'];
const initial=():XboxVoiceState=>({connected:false,muted:true,audioBlocked:false,mutedMembers:[]});
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);
const xuid=(value:unknown):value is string=>typeof value==='string'&&/^[1-9][0-9]{0,19}$/.test(value)&&BigInt(value)<=18446744073709551615n;
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));

export function voiceCommand(value:unknown):XboxVoiceCommand{
  if(!object(value))throw Error('Invalid Xbox voice command.');
  const keys=Object.keys(value),only=(allowed:string[])=>keys.every(key=>allowed.includes(key));
  if(value.type==='start'&&only(['type','partyId'])&&(value.partyId===undefined||(text(value.partyId,128)&&/^[A-Za-z0-9_-]+$/.test(value.partyId))))return {type:'start',...(value.partyId?{partyId:value.partyId}: {})};
  if(value.type==='accept'&&only(['type','inviteId'])&&text(value.inviteId,262)&&value.inviteId.startsWith('party:')&&value.inviteId.length>6)return {type:'accept',inviteId:value.inviteId};
  if(value.type==='mute'&&only(['type','xuid','muted'])&&xuid(value.xuid)&&typeof value.muted==='boolean')return {type:'mute',xuid:value.xuid,muted:value.muted};
  if(value.type==='setMuted'&&only(['type','muted'])&&typeof value.muted==='boolean')return {type:'setMuted',muted:value.muted};
  if((value.type==='leave'||value.type==='resume')&&only(['type']))return {type:value.type};
  throw Error('Invalid Xbox voice command.');
}

function voiceState(value:unknown):XboxVoiceState{
  if(!object(value)||Object.keys(value).some(key=>!['connected','muted','audioBlocked','mutedMembers','error'].includes(key))
    ||typeof value.connected!=='boolean'||typeof value.muted!=='boolean'||typeof value.audioBlocked!=='boolean'
    ||!Array.isArray(value.mutedMembers)||value.mutedMembers.length>128||!value.mutedMembers.every(xuid)
    ||(value.error!==undefined&&!text(value.error,1024)))throw Error('Invalid Xbox voice state.');
  return {connected:value.connected,muted:value.muted,audioBlocked:value.audioBlocked,mutedMembers:[...new Set(value.mutedMembers)],...(value.error?{error:value.error as string}:{})};
}

/** A single hidden local renderer owns party media; guides expose only remote controls. */
export class XboxVoiceHost {
  private window?:BrowserWindow;
  private ready=false;
  private readyTimer?:ReturnType<typeof setTimeout>;
  private microphoneUntil=0;
  private stopped=false;
  private current=initial();
  private readonly pending=new Map<string,Pending>();
  private active?:Pending;
  private cleanup:Promise<void>=Promise.resolve();
  private cleanupFailed=false;
  private cleaning=0;
  private generation=0;
  private waiting=0;
  private connecting=false;
  constructor(private readonly directory:string,private readonly options:Options){
    const control=(event:Electron.IpcMainInvokeEvent)=>{if(!this.owns(event)&&!options.authorizeControl(event))throw Error('Use Xbox voice controls from Nexus.');};
    ipcMain.handle('xbox-voice-state',event=>{control(event);return this.state;});
    ipcMain.handle('xbox-voice-control',(event,command:unknown)=>{if(this.owns(event)||!options.authorizeControl(event))throw Error('Use Xbox voice controls from Nexus.');return this.control(command);});
    ipcMain.handle('xbox-voice-owner-ready',event=>{this.owner(event);if(this.ready)return;this.ready=true;clearTimeout(this.readyTimer);this.pump();});
    ipcMain.handle('xbox-voice-owner-state',(event,value:unknown)=>{this.owner(event);this.publish(voiceState(value));});
    ipcMain.handle('xbox-voice-owner-complete',(event,id:unknown,error:unknown)=>{
      this.owner(event);if(!text(id,36)||!/^[a-f0-9-]{36}$/.test(id)||(error!==undefined&&!text(error,1024)))throw Error('Invalid Xbox voice result.');
      const job=this.active;if(!job||job.id!==id)return;
      this.pending.delete(job.id);this.active=undefined;clearTimeout(job.timer);this.microphoneUntil=0;
      if(error)job.reject(Error(error as string));else job.resolve();this.pump();this.options.settled?.();
    });
  }
  get contents():Electron.WebContents|undefined{return this.window&&!this.window.isDestroyed()?this.window.webContents:undefined;}
  get state():XboxVoiceState{return {...this.current,mutedMembers:[...this.current.mutedMembers]};}
  get busy():boolean{return this.waiting>0||this.pending.size>0||this.cleaning>0;}
  owns(event:Pick<Electron.IpcMainInvokeEvent,'sender'|'senderFrame'>):boolean{
    const contents=this.contents;return Boolean(contents&&event.sender===contents&&event.senderFrame===contents.mainFrame);
  }
  private owner(event:Electron.IpcMainInvokeEvent):void{if(!this.owns(event))throw Error('Only the Nexus party media owner can send this request.');}
  private publish(state:XboxVoiceState):void{this.current=state;try{this.options.stateChanged(this.state);}catch{/* A closing guide must not interrupt media cleanup. */}}
  async control(value:unknown):Promise<void>{
    const command=voiceCommand(value);if(this.stopped)throw Error('Xbox party media is shutting down.');
    if(command.type==='leave'){const retry=!this.window&&this.cleanupFailed;this.fail(Error('Xbox party was left.'),false);if(retry)this.leaveParty();await this.cleanup;if(this.cleanupFailed)throw Error('Xbox could not confirm that the party was left.');return;}
    if(this.waiting>=8)throw Error('Xbox voice controls are busy. Wait a moment.');
    const connecting=command.type==='start'||command.type==='accept';
    if(connecting&&(this.connecting||this.current.connected||this.options.canConnect?.()===false))throw Error('Xbox party is already connecting or connected. Leave it before starting another.');
    if(connecting)this.connecting=true;
    this.waiting++;
    try{
    const generation=this.generation;await this.cleanup;
    if(generation!==this.generation)throw Error('Xbox party session changed. Select the control again.');
    if(this.cleanupFailed)throw Error('Xbox could not confirm the previous party was left. Leave it before reconnecting.');
    if(this.stopped)throw Error('Xbox party media is shutting down.');
    if(this.pending.size>=8)throw Error('Xbox voice controls are busy. Wait a moment.');
    return await new Promise<void>((resolve,reject)=>{
      const job:Pending={id:randomUUID(),command,resolve,reject};this.pending.set(job.id,job);
      try{this.ensureWindow();this.pump();}catch{this.fail(Error('Xbox party media could not start.'));}
    });
    }finally{if(connecting)this.connecting=false;this.waiting--;this.options.settled?.();}
  }
  private ensureWindow():void{
    if(this.contents)return;
    let development:URL|undefined;
    if(process.env.VITE_DEV_SERVER_URL){
      development=new URL(process.env.VITE_DEV_SERVER_URL);
      if(development.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(development.hostname)||development.username||development.password)throw Error('The Nexus party media renderer must be local.');
      development.search='';development.hash='xbox-media';
    }
    const window=new BrowserWindow({title:'Nexus Xbox party media',show:false,width:1,height:1,skipTaskbar:true,autoHideMenuBar:true,
      webPreferences:{preload:path.join(this.directory,'..','preload','index.cjs'),partition:'xbox-party-media',contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required'}});
    this.window=window;this.ready=false;
    window.webContents.session.setPermissionCheckHandler((contents,permission,_origin,details)=>contents===this.contents&&permission==='media'&&details.mediaType==='audio'&&Date.now()<this.microphoneUntil);
    window.webContents.session.setPermissionRequestHandler((contents,permission,callback,details)=>{
      const allowed=contents===this.contents&&permission==='media'&&details.isMainFrame&&'mediaTypes' in details&&details.mediaTypes?.length===1&&details.mediaTypes[0]==='audio'&&Date.now()<this.microphoneUntil;
      this.microphoneUntil=0;callback(Boolean(allowed));
    });
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',event=>event.preventDefault());
    window.webContents.on('will-redirect',event=>event.preventDefault());
    window.webContents.on('render-process-gone',()=>{if(this.window===window)this.fail(Error('Xbox party media stopped. Reconnect the party.'));});
    window.on('closed',()=>{if(this.window===window)this.fail(Error('Xbox party media closed. Reconnect the party.'));});
    this.readyTimer=setTimeout(()=>{if(this.window===window&&!this.ready)this.fail(Error('Xbox party media did not become ready.'));},15_000);this.readyTimer.unref();
    const loaded=development?window.loadURL(development.href):window.loadFile(path.join(this.directory,'..','..','dist','index.html'),{hash:'xbox-media'});
    void loaded.catch(()=>{if(this.window===window)this.fail(Error('Xbox party media could not load.'));});
  }
  private pump():void{
    if(!this.ready||this.active||!this.contents)return;
    const job=this.pending.values().next().value as Pending|undefined;if(!job)return;
    this.active=job;this.microphoneUntil=0;
    job.timer=setTimeout(()=>{if(this.active===job)this.fail(Error('Xbox party media stopped responding. Reconnect the party.'));},job.command.type==='start'||job.command.type==='accept'?120_000:30_000);job.timer.unref();
    try{this.contents.send('xbox-voice-owner-command',{id:job.id,command:job.command});}
    catch{this.fail(Error('Xbox party media stopped. Reconnect the party.'));}
  }
  /** Called by the owner-only raw mic IPC after an explicit unmute control was dispatched. */
  allowMicrophone():void{
    if(this.active?.command.type!=='setMuted'||this.active.command.muted)throw Error('Enable the microphone with Xbox party controls.');
    this.microphoneUntil=Date.now()+10_000;
  }
  private fail(error:Error,report=true):void{
    this.generation++;
    const window=this.window;this.window=undefined;this.ready=false;clearTimeout(this.readyTimer);this.microphoneUntil=0;
    for(const job of this.pending.values()){clearTimeout(job.timer);job.reject(error);}this.pending.clear();this.active=undefined;
    this.publish({...initial(),...(report?{error:error.message}:{})});
    if(window){
      if(!window.isDestroyed())window.destroy();
      this.leaveParty();
    }
  }
  private leaveParty():void{this.cleaning++;this.cleanup=this.cleanup.then(()=>this.options.leave()).then(()=>{this.cleanupFailed=false;},()=>{this.cleanupFailed=true;this.publish({...initial(),error:'Xbox could not confirm that the party was left.'});}).finally(()=>{this.cleaning--;this.options.settled?.();});}
  async reset():Promise<void>{const retry=!this.window&&this.cleanupFailed;this.fail(Error('Xbox party media was reset.'),false);if(retry)this.leaveParty();await this.cleanup;}
  async shutdown():Promise<void>{this.stopped=true;for(const channel of channels)ipcMain.removeHandler(channel);this.fail(Error('Xbox party media is shutting down.'),false);await this.cleanup;}
}
