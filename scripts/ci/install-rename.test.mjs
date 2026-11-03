import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('../install.sh',import.meta.url));
test('renamed installation keeps existing locations, command, desktop identity and saved state',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-install-rename-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const prefix=root+'/prefix with spaces',data=root+'/data',app=prefix+'/opt/xodus-nexus',tools=root+'/tools';
 for(const dir of [app,data+'/applications',tools])await fs.mkdir(dir,{recursive:true});
 await fs.writeFile(app+'/Xodus-Nexus.AppImage','old launcher');await fs.writeFile(root+'/new.AppImage','synthetic new launcher');
 await fs.writeFile(data+'/applications/xodus-nexus.desktop','[Desktop Entry]\nName=Xodus Nexus\n');
 const saved=[root+'/.config/xodus-nexus/launcher-state.json',data+'/xodus-nexus/runtimes/current.json',root+'/Games/Xodus Nexus/Existing/save.dat'];
 for(const file of saved){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'keep');}
 await fs.writeFile(tools+'/curl','#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then shift; output="$1"; fi; shift; done\nprintf icon > "$output"\n',{mode:0o700});
 await fs.writeFile(tools+'/update-desktop-database','#!/bin/sh\nexit 0\n',{mode:0o700});
 const run=spawnSync('bash',[script],{env:{...process.env,HOME:root,PATH:tools+':'+process.env.PATH,XODUS_NEXUS_PREFIX:prefix,XDG_DATA_HOME:data,XODUS_NEXUS_APPIMAGE:root+'/new.AppImage',XODUS_NEXUS_SKIP_DEPS:'1'},encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);assert.equal(await fs.readFile(app+'/Xodus-Nexus.AppImage','utf8'),'synthetic new launcher');
 assert.equal(await fs.readlink(prefix+'/bin/xodus-nexus'),app+'/Xodus-Nexus.AppImage');
 const entry=await fs.readFile(data+'/applications/xodus-nexus.desktop','utf8');assert.match(entry,/^Name=Nexus Launcher$/m);assert.match(entry,/^StartupWMClass=xodus-nexus$/m);assert.ok(entry.includes('Exec='+prefix+'/bin/xodus-nexus %U'));
 assert.deepEqual(await fs.readdir(data+'/applications'),['xodus-nexus.desktop']);for(const file of saved)assert.equal(await fs.readFile(file,'utf8'),'keep');
});
