import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('../install.sh',import.meta.url));
const arch=process.arch==='arm64'?'arm64':'x86_64';

const fakeCurl=`#!/bin/sh
out=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift; out="$1" ;;
    http*) url="$1" ;;
  esac
  shift
done
case "$url" in
  *api.github.com*releases/latest*)
    if [ -n "$out" ]; then printf '%s\\n' "$FAKE_RELEASE_JSON" > "$out"; else printf '%s\\n' "$FAKE_RELEASE_JSON"; fi ;;
  *icon.png)
    if [ -n "$out" ]; then printf icon > "$out"; else printf icon; fi ;;
  *Nexus-Launcher-*.AppImage)
    if [ -n "$out" ]; then printf '%s' "$FAKE_NEW_IMAGE" > "$out"; else printf '%s' "$FAKE_NEW_IMAGE"; fi ;;
  *Xodus-Nexus-*.AppImage)
    if [ -n "$out" ]; then printf '%s' "$FAKE_LEGACY_IMAGE" > "$out"; else printf '%s' "$FAKE_LEGACY_IMAGE"; fi ;;
  *) exit 22 ;;
esac
`;

async function fixture(t,{legacy=false,commandFile=false}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-install-rename-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const prefix=path.join(root,'prefix with spaces'),data=path.join(root,'data'),app=path.join(prefix,'opt/xodus-nexus'),tools=path.join(root,'tools');
 for(const dir of [app,data+'/applications',tools,prefix+'/bin'])await fs.mkdir(dir,{recursive:true});
 if(legacy)await fs.writeFile(app+'/Xodus-Nexus.AppImage','old launcher');
 const newImage=path.join(root,'new.AppImage');await fs.writeFile(newImage,'synthetic new launcher');
 await fs.writeFile(data+'/applications/xodus-nexus.desktop','[Desktop Entry]\nName=Xodus Nexus\n');
 const saved=[root+'/.config/xodus-nexus/launcher-state.json',data+'/xodus-nexus/runtimes/current.json',root+'/Games/Xodus Nexus/Existing/save.dat'];
 for(const file of saved){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'keep');}
 await fs.writeFile(tools+'/curl',fakeCurl,{mode:0o700});
 await fs.writeFile(tools+'/update-desktop-database','#!/bin/sh\nexit 0\n',{mode:0o700});
 if(commandFile)await fs.writeFile(prefix+'/bin/xodus-nexus','real user command');
 const env={...process.env,HOME:root,PATH:tools+':'+process.env.PATH,XODUS_NEXUS_PREFIX:prefix,XDG_DATA_HOME:data,XODUS_NEXUS_SKIP_DEPS:'1'};
 delete env.XODUS_NEXUS_APPIMAGE;
 const run=(extra={})=>spawnSync('bash',[script],{env:{...env,...extra},encoding:'utf8'});
 const kept=async()=>{for(const file of saved)assert.equal(await fs.readFile(file,'utf8'),'keep');};
 const desktop=async()=>{const entry=await fs.readFile(data+'/applications/xodus-nexus.desktop','utf8');assert.match(entry,/^Name=Nexus Launcher$/m);assert.match(entry,/^StartupWMClass=xodus-nexus$/m);assert.ok(entry.includes('Exec='+prefix+'/bin/xodus-nexus %U'));};
 return {root,prefix,data,app,tools,newImage,run,kept,desktop};
}
async function absent(file){await assert.rejects(fs.lstat(file),{code:'ENOENT'});}
function release(family,version='0.5.1'){
 const name=`${family}-${version}-${arch}.AppImage`;
 return {name,browser_download_url:`https://github.com/domsvoboda/nexus-launcher/releases/download/v${version}/${name}`};
}

test('upgrades a legacy Xodus-Nexus installation in place without moving saved state',async t=>{
 const f=await fixture(t,{legacy:true});
 const run=f.run({XODUS_NEXUS_APPIMAGE:f.newImage});
 assert.equal(run.status,0,run.stderr);
 assert.equal(await fs.readFile(f.app+'/Xodus-Nexus.AppImage','utf8'),'synthetic new launcher');
 await absent(f.app+'/Nexus-Launcher.AppImage');
 assert.equal(await fs.readlink(f.prefix+'/bin/xodus-nexus'),f.app+'/Xodus-Nexus.AppImage');
 await f.desktop();await f.kept();
});

test('fresh installation uses the canonical Nexus-Launcher path',async t=>{
 const f=await fixture(t);
 const run=f.run({XODUS_NEXUS_APPIMAGE:f.newImage});
 assert.equal(run.status,0,run.stderr);
 assert.equal(await fs.readFile(f.app+'/Nexus-Launcher.AppImage','utf8'),'synthetic new launcher');
 await absent(f.app+'/Xodus-Nexus.AppImage');
 assert.equal(await fs.readlink(f.prefix+'/bin/xodus-nexus'),f.app+'/Nexus-Launcher.AppImage');
 await f.desktop();await f.kept();
});

test('download selects the canonical asset when a release also carries the legacy family',async t=>{
 const f=await fixture(t);
 const assets=[release('Xodus-Nexus'),release('Nexus-Launcher')];
 const run=f.run({FAKE_RELEASE_JSON:JSON.stringify({assets}),FAKE_NEW_IMAGE:'canonical bytes',FAKE_LEGACY_IMAGE:'legacy bytes'});
 assert.equal(run.status,0,run.stderr);
 assert.equal(await fs.readFile(f.app+'/Nexus-Launcher.AppImage','utf8'),'canonical bytes');
 await f.desktop();await f.kept();
});

test('download falls back to a legacy-only release and still installs',async t=>{
 const f=await fixture(t);
 const run=f.run({FAKE_RELEASE_JSON:JSON.stringify({assets:[release('Xodus-Nexus')]}),FAKE_LEGACY_IMAGE:'legacy bytes'});
 assert.equal(run.status,0,run.stderr);
 assert.equal(await fs.readFile(f.app+'/Nexus-Launcher.AppImage','utf8'),'legacy bytes');
 await f.desktop();await f.kept();
});

test('a legacy-only release upgrades an existing legacy image in place',async t=>{
 const f=await fixture(t,{legacy:true});
 const run=f.run({FAKE_RELEASE_JSON:JSON.stringify({assets:[release('Xodus-Nexus')]}),FAKE_LEGACY_IMAGE:'legacy bytes'});
 assert.equal(run.status,0,run.stderr);
 assert.equal(await fs.readFile(f.app+'/Xodus-Nexus.AppImage','utf8'),'legacy bytes');
 await absent(f.app+'/Nexus-Launcher.AppImage');
 await f.desktop();await f.kept();
});

test('does not replace a real command file in the user bin directory',async t=>{
 const f=await fixture(t,{commandFile:true});
 const run=f.run({XODUS_NEXUS_APPIMAGE:f.newImage});
 assert.equal(run.status,0,run.stderr);
 assert.equal(await fs.readFile(f.prefix+'/bin/xodus-nexus','utf8'),'real user command');
 assert.match(run.stdout,/Not replacing/);
 assert.equal(await fs.readFile(f.app+'/Nexus-Launcher.AppImage','utf8'),'synthetic new launcher');
 await f.kept();
});

test('refuses to follow a symlinked legacy launcher image',async t=>{
 const f=await fixture(t);
 const external=path.join(f.root,'external.AppImage');await fs.writeFile(external,'external file');
 await fs.symlink(external,f.app+'/Xodus-Nexus.AppImage');
 const run=f.run({XODUS_NEXUS_APPIMAGE:f.newImage});
 assert.notEqual(run.status,0);
 assert.match(run.stderr,/symlinked launcher/);
 assert.equal(await fs.readFile(external,'utf8'),'external file');
 assert.equal((await fs.lstat(f.app+'/Xodus-Nexus.AppImage')).isSymbolicLink(),true);
 await f.kept();
});

test('refuses a symlinked application directory',async t=>{
 const f=await fixture(t);
 const actual=path.join(f.root,'redirected');await fs.rename(f.app,actual);await fs.symlink(actual,f.app);
 const run=f.run({XODUS_NEXUS_APPIMAGE:f.newImage});
 assert.notEqual(run.status,0);
 assert.match(run.stderr,/application directory is a symlink/);
 await absent(actual+'/Xodus-Nexus.AppImage');
 await absent(actual+'/Nexus-Launcher.AppImage');
 await f.kept();
});
