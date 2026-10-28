import {ui} from './i18n';
import {useEffect,useRef,useState} from 'react';
import {X} from 'lucide-react';
import type {XboxSocialApi} from '../shared/types';
import {XboxChat} from './XboxChat';

export function overlayChatPosition(x:number,y:number,width:number,height:number,viewport:{width:number;height:number}){
 return {x:Math.max(8,Math.min(x,Math.max(8,viewport.width-width-8))),y:Math.max(8,Math.min(y,Math.max(8,viewport.height-height-8)))};
}
export function XboxOverlayChat({api,account,xuid,index,close,raise,openProfile,side='left',active=true}:{api:XboxSocialApi;account:string;xuid:string;index:number;side?:'left'|'right';active?:boolean;close:()=>void;raise:()=>void;openProfile:(xuid:string)=>void}){
 const root=useRef<HTMLElement>(null),drag=useRef<{id:number;x:number;y:number;left:number;top:number}>();
 const [position,setPosition]=useState(()=>overlayChatPosition(side==='right'?window.innerWidth-890-index*28:470+index*28,72+index*28,420,620,{width:window.innerWidth,height:window.innerHeight}));
 useEffect(()=>{root.current?.querySelector('textarea')?.focus();},[]);
 useEffect(()=>{
  const keepVisible=()=>{const rect=root.current?.getBoundingClientRect();if(rect)setPosition(value=>overlayChatPosition(value.x,value.y,rect.width,rect.height,{width:window.innerWidth,height:window.innerHeight}));};
  window.addEventListener('resize',keepVisible);return()=>window.removeEventListener('resize',keepVisible);
 },[]);
 return <section ref={root} className="xbox-social xbox-guide game-guide-chat-window" role="dialog" aria-label={ui("social.xbox_chat_window_285e4b")} style={{left:position.x,top:position.y,zIndex:10+index,maxWidth:`calc(100vw - ${position.x+8}px)`,maxHeight:`calc(100vh - ${position.y+8}px)`}} onPointerDownCapture={raise}>
  <header className="game-guide-chat-titlebar"
   onPointerDown={event=>{if((event.target as HTMLElement).closest('button'))return;event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);drag.current={id:event.pointerId,x:event.clientX,y:event.clientY,left:position.x,top:position.y};}}
   onPointerMove={event=>{const start=drag.current,rect=root.current?.getBoundingClientRect();if(!start||start.id!==event.pointerId||!rect)return;setPosition(overlayChatPosition(start.left+event.clientX-start.x,start.top+event.clientY-start.y,rect.width,rect.height,{width:window.innerWidth,height:window.innerHeight}));}}
   onPointerUp={()=>{drag.current=undefined;}} onPointerCancel={()=>{drag.current=undefined;}}>
   <span>{ui("social.xbox_chat_ed1ef2")}</span><button className="social-circle-button social-close" aria-label={ui("social.close_chat_window_bed35c")} onClick={close}><X/></button>
  </header>
  <XboxChat api={api} account={account} xuid={xuid} active={active} openProfile={openProfile}/>
 </section>;
}
