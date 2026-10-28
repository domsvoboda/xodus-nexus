import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({windows:[] as any[],handlers:new Map<string,Function>()}));
vi.mock('electron',()=>({
 ipcMain:{handle:(name:string,handler:Function)=>h.handlers.set(name,handler),removeHandler:(name:string)=>h.handlers.delete(name)},
 BrowserWindow:class{
  destroyed=false;options:any;handlers=new Map<string,Function>();webHandlers=new Map<string,Function>();
  webContents={mainFrame:{},send:vi.fn(),setWindowOpenHandler:vi.fn(),on:(name:string,handler:Function)=>this.webHandlers.set(name,handler),session:{setPermissionCheckHandler:vi.fn(),setPermissionRequestHandler:vi.fn()}};
  loadFile=vi.fn(async()=>{});loadURL=vi.fn(async()=>{});isDestroyed=()=>this.destroyed;
  on=(name:string,handler:Function)=>this.handlers.set(name,handler);
  destroy=()=>{this.destroyed=true;this.handlers.get('closed')?.();};
  constructor(options:any){this.options=options;h.windows.push(this);}
 }
}));
import {XboxVoiceHost,voiceCommand} from './xbox-voice-host.js';
const hosts:XboxVoiceHost[]=[];
beforeEach(()=>{h.windows=[];h.handlers.clear();delete process.env.VITE_DEV_SERVER_URL;});
afterEach(async()=>{for(const host of hosts.splice(0))await host.shutdown();vi.useRealTimers();});
function fixture(){
 const guide={mainFrame:{}},otherGuide={mainFrame:{}},changed=vi.fn(),leave=vi.fn(async()=>{}),busyWhenSettled:boolean[]=[];
 let host!:XboxVoiceHost;const settled=vi.fn(()=>busyWhenSettled.push(host.busy)),canConnect=vi.fn(()=>true);
 host=new XboxVoiceHost('/app/dist-electron/main',{authorizeControl:event=>(event.sender===guide||event.sender===otherGuide)&&event.senderFrame===event.sender.mainFrame,stateChanged:changed,leave,settled,canConnect});hosts.push(host);
 const ipc=(name:string,event:any,...args:any[])=>h.handlers.get(name)!(event,...args);
 const own=()=>({sender:h.windows.at(-1).webContents,senderFrame:h.windows.at(-1).webContents.mainFrame});
 const event={sender:guide,senderFrame:guide.mainFrame};
 return {host,guide,otherGuide,event,own,ipc,changed,leave,settled,busyWhenSettled,canConnect};
}
async function loaded(){await vi.waitFor(()=>expect(h.windows).toHaveLength(1));return h.windows[0];}
function sent(window:any,index=0){return window.webContents.send.mock.calls[index][1] as {id:string;command:any};}

it('creates one hidden sandboxed media owner and serializes both guides through real readiness and completion',async()=>{
 const f=fixture();expect(h.windows).toHaveLength(0);
 const first=f.host.control({type:'start'}),second=f.host.control({type:'mute',xuid:'2',muted:true});const w=await loaded();
 expect(w.options).toMatchObject({show:false,skipTaskbar:true,webPreferences:{partition:'xbox-party-media',backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});
 expect(w.loadFile).toHaveBeenCalledWith('/app/dist/index.html',{hash:'xbox-media'});expect(w.webContents.send).not.toHaveBeenCalled();
 f.ipc('xbox-voice-owner-ready',f.own());expect(w.webContents.send).toHaveBeenCalledTimes(1);expect(sent(w).command).toEqual({type:'start'});
 f.ipc('xbox-voice-owner-state',f.own(),{connected:true,muted:true,audioBlocked:false,mutedMembers:[]});
 expect(f.ipc('xbox-voice-state',f.event)).toEqual(f.host.state);expect(f.changed).toHaveBeenLastCalledWith(f.host.state);
 f.ipc('xbox-voice-owner-complete',f.own(),sent(w).id);await first;expect(w.webContents.send).toHaveBeenCalledTimes(2);
 expect(sent(w,1).command).toEqual({type:'mute',xuid:'2',muted:true});
 f.ipc('xbox-voice-owner-complete',f.own(),sent(w,1).id);await second;
 expect(f.ipc('xbox-voice-state',{sender:f.otherGuide,senderFrame:f.otherGuide.mainFrame}).connected).toBe(true);expect(h.windows).toHaveLength(1);
});
it('rejects foreign/subframe owner IPC, self-issued controls, malformed commands and private state fields',async()=>{
 const f=fixture();const command=f.host.control({type:'start'});const w=await loaded();
 for(const name of ['xbox-voice-owner-ready','xbox-voice-owner-state','xbox-voice-owner-complete']){
  expect(()=>f.ipc(name,f.event)).toThrow('media owner');expect(()=>f.ipc(name,{sender:w.webContents,senderFrame:{}})).toThrow('media owner');
 }
 expect(()=>f.ipc('xbox-voice-control',f.own(),{type:'setMuted',muted:false})).toThrow('controls');
 expect(()=>f.ipc('xbox-voice-owner-state',f.own(),{connected:true,muted:true,audioBlocked:false,mutedMembers:[],authKey:'private'})).toThrow('state');
 for(const value of [{type:'start',partyId:'../other'},{type:'accept',inviteId:'game:notice'},{type:'setMuted',muted:'false'},{type:'mute',xuid:'18446744073709551616',muted:true},{type:'resume',secret:'private'}])expect(()=>voiceCommand(value)).toThrow('command');
 const stopped=expect(command).rejects.toThrow();await f.host.reset();await stopped;
});
it('grants only one own main-frame audio capture request during an explicitly dispatched unmute',async()=>{
 const f=fixture();const start=f.host.control({type:'start'});const w=await loaded();f.ipc('xbox-voice-owner-ready',f.own());f.ipc('xbox-voice-owner-complete',f.own(),sent(w).id);await start;
 const check=w.webContents.session.setPermissionCheckHandler.mock.calls[0][0],request=w.webContents.session.setPermissionRequestHandler.mock.calls[0][0],answer=vi.fn();
 expect(check(w.webContents,'media','file://',{mediaType:'audio'})).toBe(false);expect(()=>f.host.allowMicrophone()).toThrow('controls');
 const unmute=f.host.control({type:'setMuted',muted:false});await vi.waitFor(()=>expect(w.webContents.send).toHaveBeenCalledTimes(2));f.host.allowMicrophone();
 expect(check(w.webContents,'media','file://',{mediaType:'audio'})).toBe(true);expect(check(w.webContents,'media','file://',{mediaType:'video'})).toBe(false);expect(check({},'media','file://',{mediaType:'audio'})).toBe(false);
 request(w.webContents,'media',answer,{isMainFrame:false,mediaTypes:['audio']});expect(answer).toHaveBeenLastCalledWith(false);
 f.host.allowMicrophone();request(w.webContents,'media',answer,{isMainFrame:true,mediaTypes:['audio','video']});expect(answer).toHaveBeenLastCalledWith(false);
 f.host.allowMicrophone();request(w.webContents,'media',answer,{isMainFrame:true,mediaTypes:['audio']});expect(answer).toHaveBeenLastCalledWith(true);expect(check(w.webContents,'media','file://',{mediaType:'audio'})).toBe(false);
 f.ipc('xbox-voice-owner-complete',f.own(),sent(w,1).id);await unmute;expect(()=>f.host.allowMicrophone()).toThrow('controls');
});
it('fails all pending commands and leaves the actual party once when the media owner dies',async()=>{
 const f=fixture();const outcomes=Array.from({length:8},(_,index)=>f.host.control(index===0?{type:'start'}:{type:'setMuted',muted:true}).then(()=>null,error=>error));const w=await loaded();
 await expect(f.host.control({type:'setMuted',muted:true})).rejects.toThrow('busy');f.ipc('xbox-voice-owner-ready',f.own());
 w.webHandlers.get('render-process-gone')();expect((await Promise.all(outcomes)).every(value=>value instanceof Error)).toBe(true);
 await vi.waitFor(()=>expect(f.leave).toHaveBeenCalledOnce());expect(w.destroyed).toBe(true);expect(f.host.contents).toBeUndefined();expect(f.host.state).toMatchObject({connected:false,muted:true,mutedMembers:[]});expect(h.windows).toHaveLength(1);
});

it('rejects duplicate start or accept from a second view without touching the first connection',async()=>{
 const f=fixture();const first=f.host.control({type:'start'}),w=await loaded();
 await expect(f.host.control({type:'start'})).rejects.toThrow('already connecting');
 await expect(f.host.control({type:'accept',inviteId:'party:fixture'})).rejects.toThrow('already connecting');
 f.ipc('xbox-voice-owner-ready',f.own());
 f.canConnect.mockReturnValue(false); // Server party exists before ICE finishes.
 f.ipc('xbox-voice-owner-complete',f.own(),sent(w).id);await first;
 expect(f.host.state.connected).toBe(false);
 await expect(f.host.control({type:'start'})).rejects.toThrow('already connecting');
 await expect(f.host.control({type:'accept',inviteId:'party:fixture'})).rejects.toThrow('already connecting');
 f.canConnect.mockReturnValue(true);
 f.ipc('xbox-voice-owner-state',f.own(),{connected:true,muted:true,audioBlocked:false,mutedMembers:[]});
 await expect(f.host.control({type:'start'})).rejects.toThrow('already connecting');
 await expect(f.host.control({type:'accept',inviteId:'party:fixture'})).rejects.toThrow('already connecting');
 expect(w.webContents.send).toHaveBeenCalledOnce();expect(w.destroyed).toBe(false);expect(f.leave).not.toHaveBeenCalled();
 expect(f.host.state.connected).toBe(true);expect(h.windows).toHaveLength(1);
});
it('lets Leave interrupt a connecting owner and waits for actual-party cleanup without reconnecting',async()=>{
 const f=fixture();let finish!:()=>void;f.leave.mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=resolve;}));
 const starting=expect(f.host.control({type:'start'})).rejects.toThrow('left');const w=await loaded();f.ipc('xbox-voice-owner-ready',f.own());
 let left=false;const leaving=f.host.control({type:'leave'}).then(()=>{left=true;});await starting;await vi.waitFor(()=>expect(f.leave).toHaveBeenCalledOnce());expect(w.destroyed).toBe(true);expect(left).toBe(false);finish();await leaving;expect(left).toBe(true);expect(h.windows).toHaveLength(1);
});
it('times out an unready or hung owner and releases its actual party without automatically reconnecting',async()=>{
 vi.useFakeTimers();const f=fixture();
 const unready=expect(f.host.control({type:'start'})).rejects.toThrow('ready');await Promise.resolve();expect(h.windows).toHaveLength(1);
 await vi.advanceTimersByTimeAsync(15_001);await unready;expect(f.leave).toHaveBeenCalledOnce();expect(h.windows[0].destroyed).toBe(true);
 const hung=expect(f.host.control({type:'start'})).rejects.toThrow('responding');await Promise.resolve();expect(h.windows).toHaveLength(2);
 f.ipc('xbox-voice-owner-ready',f.own());await vi.advanceTimersByTimeAsync(120_001);await hung;expect(f.leave).toHaveBeenCalledTimes(2);expect(h.windows[1].destroyed).toBe(true);expect(h.windows).toHaveLength(2);
});
it('keeps media cleanup independent of a closing guide and retries uncertain cleanup only on explicit Leave',async()=>{
 const f=fixture();f.changed.mockImplementation(()=>{throw Error('guide closed');});f.leave.mockRejectedValueOnce(Error('network unavailable'));
 const start=expect(f.host.control({type:'start'})).rejects.toThrow();const w=await loaded();w.webHandlers.get('render-process-gone')();await start;
 await vi.waitFor(()=>expect(f.host.state.error).toContain('confirm'));expect(w.destroyed).toBe(true);expect(f.leave).toHaveBeenCalledOnce();
 await expect(f.host.control({type:'start'})).rejects.toThrow('previous party');expect(h.windows).toHaveLength(1);
 await f.host.control({type:'leave'});expect(f.leave).toHaveBeenCalledTimes(2);expect(h.windows).toHaveLength(1);
});
it('keeps the application alive through owner readiness, pending commands and actual-party cleanup',async()=>{
 const f=fixture();expect(f.host.busy).toBe(false);
 const first=f.host.control({type:'start'}),w=await loaded();expect(f.host.busy).toBe(true);
 f.ipc('xbox-voice-owner-ready',f.own());expect(f.host.busy).toBe(true);
 f.ipc('xbox-voice-owner-complete',f.own(),sent(w).id);await first;expect(f.host.busy).toBe(false);expect(f.busyWhenSettled.at(-1)).toBe(false);
 let finish!:()=>void;f.leave.mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=resolve;}));
 const next=expect(f.host.control({type:'start'})).rejects.toThrow();await vi.waitFor(()=>expect(w.webContents.send).toHaveBeenCalledTimes(2));
 const reset=f.host.reset();await next;await vi.waitFor(()=>expect(f.leave).toHaveBeenCalledOnce());expect(f.host.busy).toBe(true);
 const waiting=f.host.control({type:'start'});finish();await reset;await vi.waitFor(()=>expect(h.windows).toHaveLength(2));
 expect(f.host.busy).toBe(true);expect(f.busyWhenSettled.at(-1)).toBe(true);
 const replacement=h.windows[1];f.ipc('xbox-voice-owner-ready',f.own());f.ipc('xbox-voice-owner-complete',f.own(),sent(replacement).id);await waiting;
 expect(f.host.busy).toBe(false);expect(f.busyWhenSettled.at(-1)).toBe(false);
});
it('rejects an old control waiting for cleanup when an account reset changes the session',async()=>{
 const f=fixture();let finish!:()=>void;f.leave.mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=resolve;}));
 const starting=expect(f.host.control({type:'start'})).rejects.toThrow();const w=await loaded();w.webHandlers.get('render-process-gone')();await starting;
 await vi.waitFor(()=>expect(f.leave).toHaveBeenCalledOnce());
 const stale=expect(f.host.control({type:'setMuted',muted:false})).rejects.toThrow('session changed');
 const reset=f.host.reset();finish();await reset;await stale;expect(h.windows).toHaveLength(1);expect(f.host.contents).toBeUndefined();
});
it('rejects remote or credential-bearing media renderers before creating an owner',async()=>{
 const f=fixture();
 for(const url of ['https://example.test','file:///tmp/other.html','http://user:password@localhost:5173']){
  process.env.VITE_DEV_SERVER_URL=url;await expect(f.host.control({type:'start'})).rejects.toThrow('could not start');
 }
 expect(h.windows).toHaveLength(0);expect(f.leave).not.toHaveBeenCalled();
});
it('uses a query-free local media route and blocks navigation, redirects and popups',async()=>{
 process.env.VITE_DEV_SERVER_URL='http://localhost:5173/?unused=private';const f=fixture();
 const pending=expect(f.host.control({type:'start'})).rejects.toThrow();const w=await loaded();
 expect(w.loadURL).toHaveBeenCalledWith('http://localhost:5173/#xbox-media');
 for(const name of ['will-navigate','will-redirect']){const preventDefault=vi.fn();w.webHandlers.get(name)({preventDefault});expect(preventDefault).toHaveBeenCalledOnce();}
 expect(w.webContents.setWindowOpenHandler.mock.calls[0][0]({url:'https://example.test'})).toEqual({action:'deny'});
 await f.host.reset();await pending;
});
