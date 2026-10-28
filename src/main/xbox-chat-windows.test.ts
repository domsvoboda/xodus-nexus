import {beforeEach,expect,it,vi} from 'vitest';

const h=vi.hoisted(()=>({windows:[] as any[],load:vi.fn<(...args:any[])=>Promise<void>>()}));
vi.mock('electron',()=>({BrowserWindow:class{
  options:any;destroyed=false;minimized=false;visible=false;focused=false;url='';
  handlers=new Map<string,Function>();webHandlers=new Map<string,Function>();
  webContents={mainFrame:{},getURL:()=>this.url,setWindowOpenHandler:vi.fn(),
    on:(event:string,callback:Function)=>this.webHandlers.set(event,callback),
    session:{setPermissionCheckHandler:vi.fn(),setPermissionRequestHandler:vi.fn()}};
  loadURL=vi.fn((url:string)=>{this.url=url;return h.load(url,this);});
  show=vi.fn(()=>{this.visible=true;});focus=vi.fn(()=>{this.focused=true;});restore=vi.fn(()=>{this.minimized=false;});setTitle=vi.fn();
  isDestroyed=()=>this.destroyed;isMinimized=()=>this.minimized;
  isVisible=()=>this.visible;isFocused=()=>this.focused;
  on=(event:string,callback:Function)=>this.handlers.set(event,callback);
  close=vi.fn(()=>{if(this.destroyed)return;this.destroyed=true;this.handlers.get('closed')?.();});
  destroy=vi.fn(()=>{if(this.destroyed)return;this.destroyed=true;this.handlers.get('closed')?.();});
  constructor(options:unknown){this.options=options;h.windows.push(this);}
}}));

import {XboxChatWindows,xboxChatTarget} from './xbox-chat-windows.js';
function deferred(){let resolve!:()=>void,reject!:(error:Error)=>void;const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
beforeEach(()=>{h.windows=[];h.load.mockReset().mockResolvedValue(undefined);delete process.env.VITE_DEV_SERVER_URL;});

it('opens a normal resizable sandboxed local chat in a nonpersistent media-denied partition',async()=>{
  const chats=new XboxChatWindows('/app/dist-electron/main',vi.fn());await chats.show('2533274790000000');const w=h.windows[0];
  expect(w.options).toMatchObject({title:'Nexus Chat',width:500,height:720,minWidth:400,minHeight:500,resizable:true,show:false,alwaysOnTop:false});
  expect(w.options.webPreferences).toEqual({preload:'/app/dist-electron/preload/index.cjs',partition:'xbox-chat-local',contextIsolation:true,nodeIntegration:false,sandbox:true});
  expect(w.loadURL).toHaveBeenCalledWith('file:///app/dist/index.html#xbox-chat=2533274790000000');
  expect(w.show).toHaveBeenCalledOnce();expect(w.focus).toHaveBeenCalledOnce();expect(chats.contents).toEqual([w.webContents]);expect(chats.hasWindow).toBe(true);
});

it('reuses only the selected recipient window and restores it without reloading messages',async()=>{
  const chats=new XboxChatWindows('/app/dist-electron/main',vi.fn());await chats.show('1');await chats.show('2');
  const first=h.windows[0];first.minimized=true;await chats.show('1');
  expect(h.windows).toHaveLength(2);expect(first.loadURL).toHaveBeenCalledOnce();expect(first.restore).toHaveBeenCalledOnce();expect(first.focus).toHaveBeenCalledTimes(2);
  expect(h.windows[1].loadURL).toHaveBeenCalledWith('file:///app/dist/index.html#xbox-chat=2');
});

it('reserves one recipient slot under concurrent show requests and loads its renderer once',async()=>{
  const pending=deferred();h.load.mockReturnValueOnce(pending.promise);const chats=new XboxChatWindows('/app/dist-electron/main',vi.fn());
  const first=chats.show('1'),second=chats.show('1');expect(h.windows).toHaveLength(1);expect(h.load).toHaveBeenCalledOnce();expect(chats.hasWindow).toBe(true);
  expect(h.windows[0].show).not.toHaveBeenCalled();pending.resolve();await Promise.all([first,second]);expect(h.windows).toHaveLength(1);
});

it('validates a nonzero UInt64 recipient before creating a window and rejects me',async()=>{
  const chats=new XboxChatWindows('/app/dist-electron/main',vi.fn());
  for(const id of ['me','0','00','01','-1','1.0','1#xbox-media','1?token=secret','18446744073709551616','',1,null,{}])await expect(chats.show(id)).rejects.toThrow('Invalid Xbox chat recipient');
  expect(h.windows).toHaveLength(0);expect(xboxChatTarget('18446744073709551615')).toBe('18446744073709551615');
});

it('caps open windows at eight, including pending loads, while permitting reuse and releasing closed slots',async()=>{
  const pending=deferred();h.load.mockReturnValue(pending.promise);const chats=new XboxChatWindows('/app/dist-electron/main',vi.fn());
  const openings=Array.from({length:8},(_,index)=>chats.show(String(index+1)));expect(chats.contents).toHaveLength(8);
  await expect(chats.show('9')).rejects.toThrow('Up to eight');expect(h.windows).toHaveLength(8);
  const reused=chats.show('1');chats.close(h.windows[7].webContents);const replacement=chats.show('9');
  expect(chats.contents).toHaveLength(8);pending.resolve();await Promise.all([...openings,reused,replacement]);
  expect(h.windows).toHaveLength(9);expect(h.windows[7].show).not.toHaveBeenCalled();
});

it('allows only its own main-frame callers and cannot close another surface',async()=>{
  const closed=vi.fn(),chats=new XboxChatWindows('/app/dist-electron/main',closed);await chats.show('1');await chats.show('2');
  const own=h.windows[0].webContents,other={mainFrame:{}};
  expect(chats.owns({sender:own,senderFrame:own.mainFrame})).toBe(true);
  expect(chats.owns({sender:own,senderFrame:{} as any})).toBe(false);expect(chats.owns({sender:other as any,senderFrame:other.mainFrame as any})).toBe(false);
  chats.close(other as any);expect(chats.contents).toHaveLength(2);chats.close(own);
  expect(chats.owns({sender:own,senderFrame:own.mainFrame})).toBe(false);expect(chats.contents).toEqual([h.windows[1].webContents]);expect(closed).toHaveBeenCalledOnce();
});

it('blocks navigation, redirects, popups, media and other permission requests',async()=>{
  const chats=new XboxChatWindows('/app/dist-electron/main',vi.fn());await chats.show('1');const w=h.windows[0];
  for(const name of ['will-navigate','will-redirect']){const preventDefault=vi.fn();w.webHandlers.get(name)({preventDefault},'https://xbox.com');expect(preventDefault).toHaveBeenCalledOnce();}
  expect(w.webContents.setWindowOpenHandler.mock.calls[0][0]({url:'https://xbox.com'})).toEqual({action:'deny'});
  expect(w.webContents.session.setPermissionCheckHandler.mock.calls[0][0](w.webContents,'media','file://',{mediaType:'audio'})).toBe(false);
  const answer=vi.fn();w.webContents.session.setPermissionRequestHandler.mock.calls[0][0](w.webContents,'media',answer,{isMainFrame:true,mediaTypes:['audio']});expect(answer).toHaveBeenCalledWith(false);
  const preventDefault=vi.fn();w.webHandlers.get('page-title-updated')({preventDefault});expect(preventDefault).toHaveBeenCalledOnce();expect(w.setTitle).toHaveBeenCalledWith('Nexus Chat');
});

it('acknowledges only the focused visible recipient window, never another peer or a subframe',async()=>{
  const chats=new XboxChatWindows('/app/dist-electron/main',vi.fn());await chats.show('1');await chats.show('2');
  const w=h.windows[0],event={sender:w.webContents,senderFrame:w.webContents.mainFrame};
  expect(chats.canView(event,'1')).toBe(true);expect(chats.canView(event,'2')).toBe(false);
  expect(chats.canView({...event,senderFrame:{} as any},'1')).toBe(false);
  expect(chats.canView(event,1)).toBe(false);
  w.focused=false;expect(chats.canView(event,'1')).toBe(false);w.focused=true;
  w.visible=false;expect(chats.canView(event,'1')).toBe(false);w.visible=true;
  w.minimized=true;expect(chats.canView(event,'1')).toBe(false);w.minimized=false;
  chats.close(w.webContents);expect(chats.canView(event,'1')).toBe(false);
});

it('permits only a vetted loopback development URL and keeps query data out of the route',async()=>{
  process.env.VITE_DEV_SERVER_URL='http://localhost:5173/?unused=private';
  const chats=new XboxChatWindows('/app/dist-electron/main',vi.fn());await chats.show('1');expect(h.windows[0].url).toBe('http://localhost:5173/#xbox-chat=1');
  for(const url of ['https://xbox.com','file:///tmp/other.html','http://user:password@localhost:5173']){
    process.env.VITE_DEV_SERVER_URL=url;await expect(chats.show('2')).rejects.toThrow('must be local');
  }
  expect(h.windows).toHaveLength(1);
});

it('cleans up a failed renderer load, reports a safe error to every pending opener and permits a fresh retry',async()=>{
  const pending=deferred();h.load.mockReturnValueOnce(pending.promise);const closed=vi.fn(),chats=new XboxChatWindows('/app/dist-electron/main',closed);
  const first=chats.show('1'),second=chats.show('1'),outcomes=Promise.allSettled([first,second]);pending.reject(Error('Raw URL load details'));
  const results=await outcomes;expect(results.every(result=>result.status==='rejected'&&result.reason.message==='The Xbox chat window could not load. Reopen it and try again.')).toBe(true);
  expect(chats.hasWindow).toBe(false);expect(closed).toHaveBeenCalledOnce();await chats.show('1');expect(h.windows).toHaveLength(2);expect(chats.hasWindow).toBe(true);
});

it('releases a slot when native loading throws synchronously',async()=>{
  h.load.mockImplementationOnce(()=>{throw Error('Native failure');});const chats=new XboxChatWindows('/app/dist-electron/main',vi.fn());
  await expect(chats.show('1')).rejects.toThrow('could not load');expect(chats.hasWindow).toBe(false);await chats.show('1');expect(h.windows).toHaveLength(2);
});

it('does not resurrect a closed loading chat or let its late callback remove the replacement',async()=>{
  const pending=deferred();h.load.mockReturnValueOnce(pending.promise);const closed=vi.fn(),chats=new XboxChatWindows('/app/dist-electron/main',closed);
  const previous=chats.show('1'),old=h.windows[0];chats.close(old.webContents);await chats.show('1');
  old.webHandlers.get('render-process-gone')();pending.resolve();await previous;
  old.handlers.get('closed')();expect(chats.contents).toEqual([h.windows[1].webContents]);expect(old.show).not.toHaveBeenCalled();expect(old.focus).not.toHaveBeenCalled();expect(closed).toHaveBeenCalledOnce();
});

it('releases crashed chats and rejects a crash during startup without affecting other recipients',async()=>{
  const chats=new XboxChatWindows('/app/dist-electron/main',vi.fn());await chats.show('1');await chats.show('2');
  h.windows[0].webHandlers.get('render-process-gone')();expect(chats.contents).toEqual([h.windows[1].webContents]);
  const pending=deferred();h.load.mockReturnValueOnce(pending.promise);const opening=chats.show('3'),result=expect(opening).rejects.toThrow('could not load');
  h.windows[2].webHandlers.get('render-process-gone')();pending.resolve();await result;
  expect(chats.contents).toEqual([h.windows[1].webContents]);await chats.show('3');expect(chats.contents).toHaveLength(2);
});

it('closes all chats during account cleanup and leaves late loads inert without disabling later sessions',async()=>{
  const pending=deferred();h.load.mockReturnValueOnce(pending.promise);const closed=vi.fn(),chats=new XboxChatWindows('/app/dist-electron/main',closed);
  const opening=chats.show('1');await chats.show('2');chats.shutdown();expect(chats.hasWindow).toBe(false);expect(closed).toHaveBeenCalledTimes(2);
  pending.reject(Error('Aborted by cleanup'));await opening;expect(h.windows[0].show).not.toHaveBeenCalled();
  await chats.show('1');expect(chats.contents).toHaveLength(1);expect(h.windows).toHaveLength(3);
});
