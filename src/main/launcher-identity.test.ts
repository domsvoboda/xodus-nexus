import {expect,it,vi} from 'vitest';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {legacyLauncherProfile,preserveLauncherIdentity} from './launcher-identity';
import {StateStore} from './store';

it('pins the observed legacy dev and packaged Electron profile while preserving explicit profiles',()=>{
 const data='/isolated/config',legacy=data+'/xodus-nexus';
 expect(legacyLauncherProfile(data,legacy,'xodus-nexus')).toBe(legacy);
 expect(legacyLauncherProfile(data,data+'/Nexus Launcher','Nexus Launcher')).toBe(legacy);
 const explicit='/isolated/custom profile/../chosen';expect(legacyLauncherProfile(data,data+'/Nexus Launcher','Nexus Launcher',explicit)).toBe(explicit);
 expect(legacyLauncherProfile(data,'/isolated/demo-profile','Electron')).toBe('/isolated/demo-profile');
 let selected=data+'/Nexus Launcher';const events:string[]=[];
 const app={getPath:(name:string)=>name==='appData'?data:selected,getName:()=> 'Nexus Launcher',setPath:(_name:string,value:string)=>{selected=value;events.push('profile');},setDesktopName:vi.fn(),commandLine:{appendSwitch:vi.fn()}};
 preserveLauncherIdentity(app,undefined,'linux');events.push('lock:'+selected);
 expect(events).toEqual(['profile','lock:'+legacy]);expect(app.setDesktopName).toHaveBeenCalledWith('org.xodusgaming.nexus.desktop');
});
it('loads old settings and games without moving or rewriting profile/runtime/save state',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-rename-profile-'));
 try{
  const config=root+'/config',profile=config+'/xodus-nexus',runtime=root+'/data/xodus-nexus/runtimes',game=root+'/Games/Xodus Nexus/Existing';
  await fs.mkdir(profile,{recursive:true});await fs.mkdir(runtime,{recursive:true});await fs.mkdir(game,{recursive:true});
  const state=JSON.stringify({settings:{installRoot:root+'/Games/Xodus Nexus',runtimeRoot:runtime,multiAccountEnabled:true},games:[{id:'0123456789abcdef',title:'Existing',path:game,addedAt:'2026-11-01T00:00:00Z'}],downloads:[]});
  await fs.writeFile(profile+'/launcher-state.json',state);await fs.writeFile(runtime+'/current.json','existing runtime');await fs.writeFile(game+'/save.dat','existing save');
  const selected=legacyLauncherProfile(config,config+'/Nexus Launcher','Nexus Launcher');const store=new StateStore(selected);await store.load();
  expect(store.games[0].path).toBe(game);expect(store.settings.runtimeRoot).toBe(runtime);expect(store.settings.multiAccountEnabled).toBe(true);
  expect(await fs.readFile(profile+'/launcher-state.json','utf8')).toBe(state);expect(await fs.readFile(runtime+'/current.json','utf8')).toBe('existing runtime');expect(await fs.readFile(game+'/save.dat','utf8')).toBe('existing save');
  await expect(fs.stat(config+'/Nexus Launcher')).rejects.toThrow();
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
