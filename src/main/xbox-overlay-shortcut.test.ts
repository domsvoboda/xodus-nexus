import {afterEach,expect,it,vi} from 'vitest';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {XboxOverlayShortcut,ensureOverlayDesktopEntry} from './xbox-overlay-shortcut.js';
import {xboxOverlaySettings,xboxOverlayShortcut,xboxOverlayPatch} from '../shared/xbox-overlay-settings.js';
import type {Settings} from '../shared/types.js';
const settings=(patch:Partial<Settings>={})=>({...patch} as Settings);
const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(dir=>fs.rm(dir,{recursive:true,force:true})));});
it('defaults off with left edge and Super+G, validates stored versus requested preferences',()=>{
 expect(xboxOverlaySettings({})).toEqual({overlayEnabled:false,overlaySide:'left',overlayShortcut:'Super+G'});
 expect(xboxOverlaySettings({overlayShortcut:'bad',overlaySide:'right'}).overlayShortcut).toBe('Super+G');
 expect(xboxOverlayShortcut('Shift + Control + G')).toBe('Control+Shift+G');expect(xboxOverlayShortcut('Shift+Tab')).toBe('Shift+Tab');
 for(const value of ['G','Super+G; exec bad','Super+Super+G','Super+','Control+alt+G','Super+G\n'])expect(()=>xboxOverlayShortcut(value)).toThrow();
 expect(()=>xboxOverlayPatch({overlaySide:'top' as 'left'})).toThrow();
});
it('neither probes dependencies nor registers keys unless explicitly enabled',async()=>{
 const api={register:vi.fn(()=>true),unregister:vi.fn()},prepare=vi.fn(async()=>{});
 const shortcut=new XboxOverlayShortcut(api,async()=>{},vi.fn(),{prepare,environment:{HYPRLAND_INSTANCE_SIGNATURE:'fixture'}});
 await shortcut.configure(settings());expect(shortcut.current.state).toBe('disabled');
 expect(prepare).not.toHaveBeenCalled();expect(api.register).not.toHaveBeenCalled();await shortcut.shutdown();
});
it('uses only the desktop shortcut API and confirms Wayland delivery before claiming it works',async()=>{
 const callbacks=new Map<string,()=>void>(),api={register:vi.fn((key:string,cb:()=>void)=>{callbacks.set(key,cb);return true;}),unregister:vi.fn()},toggle=vi.fn(async()=>{});
 const shortcut=new XboxOverlayShortcut(api,toggle,vi.fn(),{environment:{WAYLAND_DISPLAY:'wayland-0',HYPRLAND_INSTANCE_SIGNATURE:'fixture'}});
 const enabled=settings({overlayEnabled:true});
 await shortcut.configure(enabled);expect(shortcut.current.state).toBe('requested');callbacks.get('Super+G')!();await Promise.resolve();
 expect(toggle).toHaveBeenCalledOnce();expect(shortcut.current.state).toBe('registered');
 await shortcut.configure({...enabled,overlaySide:'right'});expect(api.register).toHaveBeenCalledOnce();
 await shortcut.configure({...enabled,overlayShortcut:'Control+Shift+G'});expect(api.unregister).toHaveBeenCalledWith('Super+G');
 await shortcut.configure(settings());expect(shortcut.current.state).toBe('disabled');await shortcut.shutdown();
});
it('keeps missing dependencies and failed registration honest',async()=>{
 const api={register:vi.fn(()=>false),unregister:vi.fn()};
 const unavailable=new XboxOverlayShortcut(api,async()=>{},vi.fn(),{prepare:async()=>{throw Error('Dependencies missing.');}});
 await unavailable.configure(settings({overlayEnabled:true}));expect(unavailable.current).toMatchObject({state:'unavailable',message:'Dependencies missing.'});
 expect(api.register).not.toHaveBeenCalled();await unavailable.shutdown();
 const shortcut=new XboxOverlayShortcut(api,async()=>{},vi.fn(),{environment:{}});
 await shortcut.configure(settings({overlayEnabled:true}));expect(shortcut.current.state).toBe('unavailable');await shortcut.shutdown();
});
it('restores the saved shortcut after recording without modifying compositor configuration',async()=>{
 const api={register:vi.fn(()=>true),unregister:vi.fn()},enabled=settings({overlayEnabled:true});
 const shortcut=new XboxOverlayShortcut(api,async()=>{},vi.fn(),{environment:{}});
 await shortcut.configure(enabled);await shortcut.record(enabled,true);
 expect(shortcut.current.state).toBe('recording');expect(api.unregister).toHaveBeenCalledWith('Super+G');
 await shortcut.record(enabled,false);expect(shortcut.current.state).toBe('registered');
 await shortcut.record(enabled,true);await shortcut.record({...enabled,overlayShortcut:'Control+Shift+G'},false);
 expect(api.register.mock.calls.at(-1)?.[0]).toBe('Control+Shift+G');await shortcut.shutdown();
});
it('installs a hidden portal identity without replacing user-managed desktop entries',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-desktop-identity-'));directories.push(root);
 await ensureOverlayDesktopEntry('/opt/Nexus $special.AppImage',root);
 const file=path.join(root,'applications/org.xodusgaming.nexus.desktop');
 expect(await fs.readFile(file,'utf8')).toContain('\\$special');
 await fs.writeFile(file,'[Desktop Entry]\nName=User entry\n');await ensureOverlayDesktopEntry('/opt/new.AppImage',root);
 expect(await fs.readFile(file,'utf8')).toContain('Name=User entry');
});

it('suspends recording without another portal registration and rebinds only on Save',async()=>{
 const callbacks=new Map<string,()=>void>(),api={register:vi.fn((key:string,cb:()=>void)=>{callbacks.set(key,cb);return true;}),unregister:vi.fn(),setSuspended:vi.fn()},toggle=vi.fn(async()=>{});
 const enabled=settings({overlayEnabled:true}),shortcut=new XboxOverlayShortcut(api,toggle,vi.fn(),{environment:{WAYLAND_DISPLAY:'fixture'}});
 await shortcut.configure(enabled);await shortcut.record(enabled,true);callbacks.get('Super+G')!();
 expect(toggle).not.toHaveBeenCalled();expect(api.setSuspended).toHaveBeenLastCalledWith(true);expect(api.unregister).not.toHaveBeenCalled();
 await shortcut.record(enabled,false);expect(api.setSuspended).toHaveBeenLastCalledWith(false);expect(api.register).toHaveBeenCalledOnce();expect(shortcut.current.state).toBe('requested');
 await shortcut.configure({...enabled,overlayShortcut:'Shift+Tab'});expect(api.register).toHaveBeenCalledTimes(2);expect(api.unregister).toHaveBeenCalledOnce();expect(api.unregister).toHaveBeenCalledWith('Super+G');
 callbacks.get('Super+G')!();expect(toggle).not.toHaveBeenCalled();callbacks.get('Shift+Tab')!();expect(toggle).toHaveBeenCalledOnce();
 await shortcut.configure(settings());callbacks.get('Shift+Tab')!();expect(toggle).toHaveBeenCalledOnce();await shortcut.shutdown();
});

it('does not request consent if Guide is disabled while its dependency check is pending',async()=>{
 let release!:()=>void;const api={register:vi.fn(()=>true),unregister:vi.fn(),setSuspended:vi.fn()},prepare=vi.fn(()=>new Promise<void>(resolve=>{release=resolve;}));
 const shortcut=new XboxOverlayShortcut(api,async()=>{},vi.fn(),{prepare});
 const enabled=shortcut.configure(settings({overlayEnabled:true}));await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
 const disabled=shortcut.configure(settings());release();await enabled;await disabled;
 expect(api.register).not.toHaveBeenCalled();expect(shortcut.current.state).toBe('disabled');await shortcut.shutdown();
});

it('does not resurrect registration when preparation or a blur restore finishes after shutdown',async()=>{
 let release!:()=>void;const api={register:vi.fn(()=>true),unregister:vi.fn()};
 const shortcut=new XboxOverlayShortcut(api,async()=>{},vi.fn(),{prepare:()=>new Promise<void>(resolve=>{release=resolve;})});
 const configure=shortcut.configure(settings({overlayEnabled:true}));
 await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
 const close=shortcut.shutdown();release();await configure;await close;
 await shortcut.record(settings({overlayEnabled:true}),false);
 expect(api.register).not.toHaveBeenCalled();expect(shortcut.current.state).toBe('disabled');
});
