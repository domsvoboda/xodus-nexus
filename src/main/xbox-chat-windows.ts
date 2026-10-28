import {BrowserWindow} from 'electron';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const title='Nexus Chat';
const unavailable=()=>Error('The Xbox chat window could not load. Reopen it and try again.');
type ChatWindow={window:BrowserWindow;loading:Promise<void>;failed:boolean};

export function xboxChatTarget(value:unknown):string{
  if(typeof value!=='string'||!/^[1-9][0-9]{0,19}$/.test(value)||BigInt(value)>18446744073709551615n)throw Error('Invalid Xbox chat recipient.');
  return value;
}

function rendererUrl(directory:string,xuid:string):string{
  const development=process.env.VITE_DEV_SERVER_URL;
  const url=development?new URL(development):pathToFileURL(path.join(directory,'..','..','dist','index.html'));
  if(development&&(url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password))throw Error('The Nexus chat renderer must be local.');
  url.search='';url.hash='xbox-chat='+xuid;return url.href;
}

/** Individual desktop chats; the Guide and shared party-media owner remain separate. */
export class XboxChatWindows {
  private readonly windows=new Map<string,ChatWindow>();
  constructor(private readonly directory:string,private readonly closed:()=>void){}

  get contents():Electron.WebContents[]{
    return [...this.windows.values()].filter(entry=>!entry.window.isDestroyed()).map(entry=>entry.window.webContents);
  }
  get hasWindow():boolean{return this.contents.length>0;}
  owns(event:Pick<Electron.IpcMainInvokeEvent,'sender'|'senderFrame'>):boolean{
    return this.contents.some(contents=>event.sender===contents&&event.senderFrame===contents.mainFrame);
  }
  canView(event:Pick<Electron.IpcMainInvokeEvent,'sender'|'senderFrame'>,peer:unknown):boolean{
    if(typeof peer!=='string'||!this.owns(event))return false;
    const window=this.windows.get(peer)?.window;
    return Boolean(window&&!window.isDestroyed()&&window.webContents===event.sender&&window.isVisible()&&!window.isMinimized()&&window.isFocused());
  }

  async show(value:unknown):Promise<void>{
    const xuid=xboxChatTarget(value),url=rendererUrl(this.directory,xuid);
    let entry=this.windows.get(xuid);
    if(!entry||entry.window.isDestroyed()){
      if(this.contents.length>=8)throw Error('Close an Xbox chat window before opening another. Up to eight chats can be open.');
      const window=new BrowserWindow({
        title,width:500,height:720,minWidth:400,minHeight:500,resizable:true,
        show:false,alwaysOnTop:false,autoHideMenuBar:true,backgroundColor:'#1a1b1e',
        webPreferences:{preload:path.join(this.directory,'..','preload','index.cjs'),partition:'xbox-chat-local',
          contextIsolation:true,nodeIntegration:false,sandbox:true},
      });
      const created:ChatWindow={window,loading:Promise.resolve(),failed:false};
      // Reserve the XUID and resource slot before loading or yielding to another show request.
      this.windows.set(xuid,created);entry=created;
      window.webContents.session.setPermissionCheckHandler(()=>false);
      window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
      window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      window.webContents.on('will-navigate',event=>event.preventDefault());
      window.webContents.on('will-redirect',event=>event.preventDefault());
      window.webContents.on('page-title-updated',event=>{event.preventDefault();window.setTitle(title);});
      window.webContents.on('render-process-gone',()=>{
        if(this.windows.get(xuid)!==created||window.isDestroyed())return;
        created.failed=true;window.destroy();
      });
      window.on('closed',()=>{
        if(this.windows.get(xuid)!==created)return;
        this.windows.delete(xuid);this.closed();
      });
      try{created.loading=window.loadURL(url);}
      catch{created.failed=true;window.destroy();throw unavailable();}
    }
    try{await entry.loading;}
    catch{
      if(this.windows.get(xuid)===entry&&!entry.window.isDestroyed()){entry.failed=true;entry.window.destroy();}
      if(entry.failed)throw unavailable();
      return; // Explicit close/account cleanup may abort a pending load without reopening it.
    }
    if(entry.failed)throw unavailable();
    if(this.windows.get(xuid)!==entry||entry.window.isDestroyed())return;
    if(entry.window.isMinimized())entry.window.restore();
    entry.window.show();entry.window.focus();
  }

  close(contents:Electron.WebContents):void{
    const entry=[...this.windows.values()].find(value=>value.window.webContents===contents);
    if(entry&&!entry.window.isDestroyed())entry.window.close();
  }
  shutdown():void{
    for(const entry of [...this.windows.values()])if(!entry.window.isDestroyed())entry.window.destroy();
  }
}
