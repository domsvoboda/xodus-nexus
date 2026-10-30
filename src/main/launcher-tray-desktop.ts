import {execFileSync} from 'node:child_process';
import {externalLauncherEnvironment} from './launcher-environment.js';
function watcher():boolean{
  const output=execFileSync('gdbus',['call','--session','--dest','org.freedesktop.DBus','--object-path','/org/freedesktop/DBus',
    '--method','org.freedesktop.DBus.NameHasOwner','org.kde.StatusNotifierWatcher'],{
    encoding:'utf8',timeout:1000,maxBuffer:4096,env:externalLauncherEnvironment(),stdio:['ignore','pipe','ignore'],
  });
  return /^\(true,\)\s*$/.test(output);
}
export function desktopTrayAvailable(environment:NodeJS.ProcessEnv=process.env,check=watcher):boolean{
  if(environment.XDG_CURRENT_DESKTOP?.split(':').some(value=>value.toLowerCase()==='gamescope'))return false;
  try{return check();}catch{return false;}
}
