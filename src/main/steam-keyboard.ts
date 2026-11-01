import {execFile} from 'node:child_process';
import type {BrowserWindow,IpcMainInvokeEvent} from 'electron';
import {externalLauncherEnvironment} from './launcher-environment.js';
import type {SteamKeyboardRequest} from '../shared/types.js';

export function steamKeyboardUrl(field?: unknown): string {
  if (field === undefined) return 'steam://open/keyboard';
  if (!field || typeof field !== 'object') throw Error('Invalid keyboard field.');
  const value = field as Partial<SteamKeyboardRequest>;
  for (const name of ['x', 'y', 'width', 'height', 'mode'] as const) {
    const number = value[name];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 100_000) throw Error('Invalid keyboard field.');
  }
  if (![0, 1, 2, 3].includes(value.mode!) || !value.width || !value.height) throw Error('Invalid keyboard field.');
  // The same URL parameters used by SDL's Steam on-screen keyboard integration.
  return `steam://open/keyboard?XPosition=${Math.round(value.x!)}&YPosition=${Math.round(value.y!)}&Width=${Math.max(1, Math.round(value.width))}&Height=${Math.max(1, Math.round(value.height))}&Mode=${value.mode}`;
}

async function openKeyboard(url:string):Promise<void>{
  await new Promise<void>((resolve,reject)=>execFile('steam',['-ifrunning',url],{
    env:externalLauncherEnvironment(),timeout:2000,killSignal:'SIGKILL',maxBuffer:8192,
  },error=>error?reject(error):resolve()));
}

/** One explicit touch/controller activation, never a focus/retry loop or a new Steam session. */
export class SteamKeyboard {
  private pending=false;
  private last=-Infinity;
  constructor(private open:(url:string)=>Promise<void>=openKeyboard,private now=()=>performance.now(),private platform=process.platform){}
  async show(event:IpcMainInvokeEvent,window:BrowserWindow|null,field?:unknown):Promise<boolean>{
    if(this.platform!=='linux'||!window||window.isDestroyed()||!window.isFocused()
      ||event.sender!==window.webContents||event.senderFrame!==event.sender.mainFrame)return false;
    let url:string;
    try { url=steamKeyboardUrl(field); } catch { return false; }
    const now=this.now();if(this.pending||now-this.last<500)return false;
    this.last=now;this.pending=true;
    try{await this.open(url);return true;}catch{console.warn('Steam keyboard request failed. Check that the running Steam client is accessible from Nexus.');return false;}finally{this.pending=false;}
  }
}
