export interface TrayHandle { destroy():void }

/** Close-to-tray is explicit and only active after an icon was created. */
export class LauncherTray {
  private icon?:TrayHandle;
  private quitting=false;
  constructor(private create:()=>TrayHandle,private available:()=>boolean=()=>true){}
  configure(enabled:boolean):boolean{
    if(!enabled){this.icon?.destroy();this.icon=undefined;return true;}
    if(this.quitting||!this.available())return false;
    if(this.icon)return true;
    try{this.icon=this.create();return true;}catch{return false;}
  }
  close(event:{preventDefault():void},hide:()=>void):boolean{
    if(!this.icon||this.quitting)return false;
    event.preventDefault();hide();return true;
  }
  quit():void{this.quitting=true;this.icon?.destroy();this.icon=undefined;}
}
