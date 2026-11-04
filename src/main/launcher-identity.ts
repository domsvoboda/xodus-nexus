import path from 'node:path';

export const launcherDisplayName='Nexus Launcher';
export const launcherIdentity='xodus-nexus';
export const launcherDesktopId='org.xodusgaming.nexus.desktop';

/** Electron 44 uses package.productName || package.name in both startup modes. */
export function legacyLauncherProfile(appData:string,current:string,currentName:string,profile?:string):string {
  if(profile!==undefined)return profile;
  const legacy=path.join(appData,launcherIdentity);
  // Preserve an explicitly supplied profile, including private demo harnesses.
  return current===path.join(appData,currentName)||current===legacy?legacy:current;
}
interface Application {
 getPath(name:'appData'|'userData'):string;
 getName?:()=>string;
 setPath(name:'userData',value:string):void;
 setDesktopName?:(name:string)=>void;
}
/** Called before app readiness and the profile-scoped single-instance lock. */
export function preserveLauncherIdentity(app:Application,profile?:string,platform=process.platform):void {
  app.setPath('userData',legacyLauncherProfile(app.getPath('appData'),app.getPath('userData'),app.getName?.()??launcherIdentity,profile));
  if(platform==='linux'){
    app.setDesktopName?.(launcherDesktopId);
  }
}
