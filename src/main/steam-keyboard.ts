import {execFile} from 'node:child_process';
import type {BrowserWindow,IpcMainInvokeEvent} from 'electron';
import {externalLauncherEnvironment} from './launcher-environment.js';

async function openKeyboard():Promise<void>{
  await new Promise<void>((resolve,reject)=>execFile('steam',['-ifrunning','steam://open/keyboard'],{
    env:externalLauncherEnvironment(),timeout:2000,killSignal:'SIGKILL',maxBuffer:8192,
  },error=>error?reject(error):resolve()));
}

/** One explicit touch gesture, never a focus/retry loop or a new Steam session. */
export class SteamKeyboard {
  private pending=false;
  private last=-Infinity;
  constructor(private open:()=>Promise<void>=openKeyboard,private now=()=>performance.now(),private platform=process.platform){}
  async show(event:IpcMainInvokeEvent,window:BrowserWindow|null):Promise<boolean>{
    if(this.platform!=='linux'||!window||window.isDestroyed()||!window.isFocused()
      ||event.sender!==window.webContents||event.senderFrame!==event.sender.mainFrame)return false;
    const now=this.now();if(this.pending||now-this.last<500)return false;
    this.last=now;this.pending=true;
    try{await this.open();return true;}catch{return false;}finally{this.pending=false;}
  }
}
