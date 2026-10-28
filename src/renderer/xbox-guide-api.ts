import type {AuthStatus,XboxSocialApi} from '../shared/types';

declare global {interface Window {readonly nexusOverlaySession?:string}}
type Event='auth'|'party'|'voice'|'invites'|'profile'|'overlay'|'runtimeInvites'|'visibility'|'language';
const listeners=new Map<Event,Set<(value:any)=>void>>();
const cached=new Map<Event,unknown>();
const token=window.nexusOverlaySession;
const headers={Authorization:`Bearer ${token??''}`};
let connection:AbortController|undefined;
export async function guideRpc<T>(method:string,...args:unknown[]):Promise<T>{
  if(!token)throw Error('Nexus Guide session unavailable.');
  const response=await fetch('/rpc',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({method,args}),credentials:'omit',cache:'no-store',redirect:'error'});
  const body=await response.json();if(!response.ok)throw Error(typeof body.error==='string'?body.error:'Nexus Guide request failed.');
  return body.result??undefined;
}
export function onGuideEvent(event:Event,listener:(value:any)=>void):()=>void{
  let group=listeners.get(event);if(!group){group=new Set();listeners.set(event,group);}group.add(listener);
  if(cached.has(event))listener(cached.get(event)??undefined);
  return()=>{group.delete(listener);};
}
/** Reconnect only the read-only event stream. User mutations are never retried. */
export function connectGuideEvents(problem:(error:string|undefined)=>void):()=>void{
  connection?.abort();const controller=new AbortController();connection=controller;
  void(async()=>{
    while(!controller.signal.aborted){
      try{
        const response=await fetch('/events',{headers,signal:controller.signal,credentials:'omit',cache:'no-store',redirect:'error'});
        if(!response.ok||!response.body)throw Error('Nexus Guide session ended. Reopen it from the game.');
        problem(undefined);const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';
        while(!controller.signal.aborted){
          const {done,value}=await reader.read();if(done)throw Error('Nexus Guide disconnected.');
          pending+=decoder.decode(value,{stream:true});if(pending.length>2_000_000)throw Error('Nexus Guide event too large.');
          let boundary:number;
          while((boundary=pending.indexOf('\n\n'))>=0){
            const frame=pending.slice(0,boundary);pending=pending.slice(boundary+2);
            const event=/^event: (auth|party|voice|invites|profile|overlay|runtimeInvites|visibility|language)$/m.exec(frame)?.[1] as Event|undefined;
            const data=/^data: (.+)$/m.exec(frame)?.[1];if(!event||!data)continue;
            const value=JSON.parse(data);cached.set(event,value);for(const listener of listeners.get(event)??[])listener(value??undefined);
          }
        }
      }catch(error){
        if(controller.signal.aborted)return;
        problem(error instanceof Error?error.message:'Nexus Guide disconnected.');
        await new Promise<void>(resolve=>{
          const done=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',done);resolve();};
          const timer=setTimeout(done,1500);controller.signal.addEventListener('abort',done,{once:true});
          if(controller.signal.aborted)done();
        });
      }
    }
  })();
  return()=>{controller.abort();if(connection===controller)connection=undefined;};
}
export const guideApi:XboxSocialApi&Required<Pick<XboxSocialApi,'getXboxProfileRequest'|'onXboxProfileRequest'|'completeXboxProfileRequest'>>={
  openXboxPlayerProfile:async()=>{throw Error('Open profiles from the Guide view.');},
  popOutXboxChat:async()=>{throw Error('Pop out chats from the Guide view.');},
  getXboxPlayerDetails:xuid=>guideRpc('getXboxPlayerDetails',xuid),
  getXboxPlayerGames:xuid=>guideRpc('getXboxPlayerGames',xuid),
  getXboxPeople:(list,query)=>guideRpc('getXboxPeople',list,query),
  getXboxRelationship:xuid=>guideRpc('getXboxRelationship',xuid),
  changeXboxRelationship:(account,xuid,action)=>guideRpc('changeXboxRelationship',account,xuid,action),
  getXboxPlayerProfile:xuid=>guideRpc('getXboxPlayerProfile',xuid),
  getXboxProfileRequest:()=>guideRpc('getXboxProfileRequest'),onXboxProfileRequest:callback=>onGuideEvent('profile',callback),
  completeXboxProfileRequest:(id,hide)=>hide===undefined?guideRpc('completeXboxProfileRequest',id):guideRpc('completeXboxProfileRequest',id,hide),
  getXboxFriends:()=>guideRpc('getXboxFriends'),getXboxInbox:()=>guideRpc('getXboxInbox'),
  getXboxConversation:xuid=>guideRpc('getXboxConversation',xuid),sendXboxMessage:(account,xuid,text)=>guideRpc('sendXboxMessage',account,xuid,text),
  getXboxGameInviteAvailability:()=>guideRpc('getXboxGameInviteAvailability'),sendXboxGameInvite:xuid=>guideRpc('sendXboxGameInvite',xuid),

};
export const onGuideAuth=(callback:(auth:AuthStatus)=>void)=>onGuideEvent('auth',callback);
