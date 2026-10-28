import { useEffect, useRef, useState } from 'react';
import { Bell, Download, MessageCircle, X } from 'lucide-react';
import type { AppSnapshot, XboxConversation } from '../shared/types';
import { FriendsRefresh } from './friends-refresh';
import { canCheckNotificationUpdates, messageNoticeKey, notificationBadge, notificationItems, parseNotificationReads, rememberNotices, type Notice } from './notification-state';
import { ui } from './i18n';
import './notifications.css';

export function useNotifications(data:AppSnapshot) {
  const identity=JSON.stringify([data.auth.stored===true?data.auth.username:null,data.backend.binaryPath]);
  const storageKey=data.auth.stored===true&&data.auth.username?'nexus.notifications.v1.'+encodeURIComponent(data.auth.username):undefined;
  const [reads,setReads]=useState<{identity:string;keys:string[]}>({identity:'',keys:[]});
  const [inbox,setInbox]=useState<{identity:string;value:XboxConversation[]}>();
  const [names,setNames]=useState<{identity:string;value:Map<string,string>}>();
  const [failed,setFailed]=useState(false);
  const snapshot=useRef(data);snapshot.current=data;
  const currentIdentity=useRef(identity);currentIdentity.current=identity;
  const lastViewed=useRef<{identity:string;keys:string[]}>({identity,keys:[]});
  const supported=data.auth.stored===true&&!data.auth.running&&data.backend.available&&data.backend.capabilities.nativeSocial===true;
  useEffect(()=>{
    let keys:string[]=[];
    try{if(storageKey)keys=parseNotificationReads(localStorage.getItem(storageKey));}catch{/* Read state is optional if storage is unavailable. */}
    setReads({identity,keys});lastViewed.current={identity,keys:[]};setFailed(false);
  },[identity,storageKey]);
  const remember=(keys:string[])=>{
    if(!storageKey||currentIdentity.current!==identity)return;
    setReads(previous=>{
      if(currentIdentity.current!==identity)return previous;
      const value=rememberNotices(previous.identity===identity?previous.keys:[],keys);
      if(previous.identity===identity&&value.length===previous.keys.length&&value.every((key,index)=>key===previous.keys[index]))return previous;
      try{localStorage.setItem(storageKey,JSON.stringify(value));}catch{/* Keep this session's acknowledgements even if persistence fails. */}
      return {identity,keys:value};
    });
  };
  useEffect(()=>{
    if(!supported)return;
    let active=true;
    const receive=(state:Awaited<ReturnType<typeof window.launcher.getXboxChatReads>>)=>{
      if(active&&currentIdentity.current===identity&&state&&state.account===data.auth.username&&state.binary===data.backend.binaryPath)
        remember(parseNotificationReads(JSON.stringify(state.keys)));
    };
    const unsubscribe=window.launcher.onXboxChatReads(receive);
    // The broker retains exact IDs if the main window was closed while a chat stayed open.
    void window.launcher.getXboxChatReads().then(receive,()=>{});
    return()=>{active=false;unsubscribe();};
  },[identity,supported]);
  useEffect(()=>{
    if(!supported)return;
    let active=true;
    const refresh=async()=>{
      try{
        const value=await window.launcher.nativeSocial.getXboxInbox();
        if(!active||currentIdentity.current!==identity)return true;
        setInbox({identity,value});setFailed(false);
        if(lastViewed.current.identity===identity)remember(lastViewed.current.keys);
        if(value.some(row=>row.unread)){
          try{
            const friends=await window.launcher.nativeSocial.getXboxFriends();
            if(active&&currentIdentity.current===identity)setNames({identity,value:new Map(friends.map(friend=>[friend.xuid,friend.gamertag]))});
          }catch{/* Unread state remains useful even when a friend's name is unavailable. */}
        }
        return true;
      }catch{if(active&&currentIdentity.current===identity)setFailed(true);return false;}
    };
    const visible=()=>document.visibilityState==='visible';
    const polling=new FriendsRefresh(refresh,visible,60_000);
    // Initial poll is deferred briefly, avoiding authentication/startup contention.
    const first=window.setTimeout(()=>{if(visible())void refresh().finally(()=>{if(active)polling.start();});else polling.start();},3000);
    const wake=()=>{if(visible())polling.wake();};document.addEventListener('visibilitychange',wake);
    return()=>{active=false;clearTimeout(first);polling.stop();document.removeEventListener('visibilitychange',wake);};
  },[identity,supported]);
  useEffect(()=>{
    let active=true,running=false,next=Date.now()+20_000;
    const timer=window.setInterval(()=>{
      if(!active||running||Date.now()<next||document.visibilityState!=='visible'||!canCheckNotificationUpdates(snapshot.current))return;
      const games=snapshot.current.games.filter(game=>game.installState==='ready'&&game.storeId&&game.installedVersion);
      const fresh=games.every(game=>Date.now()-Date.parse(snapshot.current.gameUpdates?.[game.id]?.checkedAt??'')<30*60_000);
      if(fresh)return;
      running=true;next=Date.now()+30*60_000;
      void window.launcher.checkGameUpdates().catch(()=>{/* The normal Library update status retains any error. */}).finally(()=>{running=false;});
    },10_000);
    return()=>{active=false;clearInterval(timer);};
  },[identity]);
  const notices=notificationItems(data,supported&&inbox?.identity===identity?inbox.value:undefined,names?.identity===identity?names.value:new Map(),reads.identity===identity?reads.keys:[]);
  return {notices,readKeys:reads.identity===identity?reads.keys:[],failed:supported&&failed,unsupported:data.auth.stored===true&&!data.backend.capabilities.nativeSocial,
    acknowledge:(notice:Notice)=>{if(notice.kind==='update')remember([notice.key]);},
    viewed:(peer:string,ids:string[])=>{
      const keys=ids.map(id=>messageNoticeKey(peer,id));
      lastViewed.current={identity,keys};remember(keys);
      if(supported&&data.auth.username&&data.backend.binaryPath)
        void window.launcher.viewedXboxChat(data.auth.username,data.backend.binaryPath,peer,ids).catch(()=>{/* Local read state is still retained. */});
    }};
}

export function NotificationBell({notices,failed=false,unsupported=false,openNotice,onSelect}: {
  notices:Notice[]; failed?:boolean; unsupported?:boolean; openNotice?:(open:boolean)=>void; onSelect:(notice:Notice)=>void;
}) {
  const [open,setOpen]=useState(false),root=useRef<HTMLDivElement>(null),bell=useRef<HTMLButtonElement>(null);
  const count=notices.filter(notice=>notice.unread).length;
  const toggle=(value:boolean)=>{setOpen(value);openNotice?.(value);};
  useEffect(()=>{
    if(!open)return;
    root.current?.querySelector<HTMLElement>('[data-gamepad-initial]')?.focus({preventScroll:true});
    const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))toggle(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();toggle(false);bell.current?.focus({preventScroll:true});}};
    document.addEventListener('pointerdown',outside);window.addEventListener('keydown',escape,true);
    return()=>{document.removeEventListener('pointerdown',outside);window.removeEventListener('keydown',escape,true);};
  },[open]);
  return <div className="notifications" ref={root}>
    <button ref={bell} className="notification-bell" aria-label={count?ui('notifications.unread',{count}):ui('notifications.title')} title={ui('notifications.title')} aria-expanded={open} aria-controls={open?'notification-panel':undefined} onClick={()=>toggle(!open)}>
      <Bell aria-hidden="true"/>{count>0?<span className="notification-badge" aria-hidden="true">{notificationBadge(count)}</span>:null}
    </button>
    {open?<section id="notification-panel" className="notification-panel" role="dialog" aria-label={ui('notifications.title')} data-gamepad-layer>
      <header><h2>{ui('notifications.title')}</h2><button data-gamepad-initial data-gamepad-cancel aria-label={ui('notifications.close')} onClick={()=>{toggle(false);bell.current?.focus({preventScroll:true});}}><X/></button></header>
      {failed?<p role="status">{ui('notifications.refresh_failed')}</p>:unsupported?<p>{ui('notifications.unsupported')}</p>:null}
      {!notices.length?<p>{ui('notifications.empty')}</p>:<ul>{notices.map(notice=><li key={notice.key}>
        <button className={notice.unread?'unread':''} onClick={()=>{toggle(false);onSelect(notice);}}>
          {notice.kind==='message'?<MessageCircle aria-hidden="true"/>:<Download aria-hidden="true"/>}
          <span><strong>{notice.kind==='message'?notice.title||ui('notifications.player'):notice.title}</strong><small>{notice.kind==='message'?ui('notifications.message'):ui('notifications.update',{version:notice.detail??''})}</small></span>
          {notice.unread?<i aria-label={ui('notifications.new')}/>:null}
        </button>
      </li>)}</ul>}
    </section>:null}
  </div>;
}
