import type {XboxGameInviteAvailability} from '../shared/types';

/** Availability is local IPC only. Never sends an invite or calls Xbox itself. */
export function watchGameInviteAvailability(read:()=>Promise<XboxGameInviteAvailability>,publish:(value:XboxGameInviteAvailability)=>void){
 let alive=true,pending=false;
 const refresh=async()=>{
  if(!alive||pending)return;pending=true;
  try{const value=await read();if(alive)publish(value);}
  catch{if(alive)publish({canInvite:false,reason:'Xbox could not check game invitations.'});}
  finally{pending=false;}
 };
 const timer=setInterval(()=>void refresh(),3000);void refresh();
 return {refresh,stop(){alive=false;clearInterval(timer);}};
}
