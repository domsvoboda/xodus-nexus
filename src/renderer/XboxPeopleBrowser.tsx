import {ui} from './i18n';
import {useEffect,useLayoutEffect,useRef,useState,type KeyboardEvent,type ReactNode} from 'react';
import {LoaderCircle,MoreHorizontal,RefreshCw,Search} from 'lucide-react';
import type {XboxFriend,XboxPeopleList,XboxPeoplePage,XboxPerson,XboxSocialApi} from '../shared/types';
import {XboxAvatar,XboxGamertag} from './XboxAvatar';
import {XboxPlayerActions} from './XboxPlayerActions';

const failure=(value:unknown)=>value instanceof Error?value.message.replace(/^Error invoking remote method '[^']+': Error: /,''):'Xbox could not load people. Try again.';
type PeopleScope={account:string;list:XboxPeopleList;query?:string};
export type XboxPeopleState={key?:string;api?:XboxSocialApi;items:XboxPerson[];truncated?:boolean;busy:boolean;problem?:string};
const empty=():XboxPeopleState=>({items:[],busy:false});
const scopeKey=(value:PeopleScope)=>JSON.stringify([value.account,value.list,value.query??'']);

/** Only the selected account/list/search may publish a response. */
export class XboxPeopleResults {
  private generation=0;
  private state=empty();
  constructor(private readonly changed:(value:XboxPeopleState)=>void){}
  cancel():void{this.generation++;}
  clear():void{this.cancel();this.state=empty();this.changed(this.state);}
  async select(api:XboxSocialApi,scope:PeopleScope):Promise<void>{
    const generation=++this.generation,key=scopeKey(scope);
    this.state={key,api,items:[],busy:false};
    if(scope.list==='search'&&(!scope.query||scope.query.trim().length<2||scope.query.length>64)){
      this.state.problem='Enter at least two characters to search Xbox.';this.changed(this.state);return;
    }
    this.state={...this.state,busy:true,problem:undefined};this.changed(this.state);
    try{
      const page:XboxPeoplePage=await api.getXboxPeople(scope.list,scope.query);
      if(generation!==this.generation)return;
      const people=new Map<string,XboxPerson>();
      for(const person of page.items)people.set(person.xuid,person);
      this.state={key,api,items:[...people.values()],truncated:Boolean(page.truncated),busy:false};this.changed(this.state);
    }catch(error){
      if(generation!==this.generation)return;
      this.state={...this.state,busy:false,problem:failure(error)};this.changed(this.state);
    }
  }
}

const ordered=(people:XboxPerson[])=>[...people].sort((a,b)=>Number(b.online)-Number(a.online)||Number(b.favorite)-Number(a.favorite)||a.gamertag.localeCompare(b.gamertag));
const useBrowserLayoutEffect=typeof window==='undefined'?useEffect:useLayoutEffect;
type VerticalBounds={top:number;bottom:number};
export function peopleMenuPlacement(row:VerticalBounds,anchor:VerticalBounds,viewport:VerticalBounds,height:number){
  const above=Math.max(0,anchor.top-viewport.top-8),below=Math.max(0,viewport.bottom-anchor.bottom-8);
  const up=height>below&&above>below;
  return {up,offset:up?row.bottom-anchor.top+4:anchor.bottom-row.top+4,maxHeight:Math.floor(up?above:below)};
}

function PeopleRow({person,choose,open,showMenu,closeMenu,actions}:{person:XboxPerson;choose:()=>void;open:boolean;showMenu?:()=>void;closeMenu:()=>void;actions?:ReactNode}){
  const row=useRef<HTMLDivElement>(null),menu=useRef<HTMLDivElement>(null),more=useRef<HTMLButtonElement>(null);
  const [placement,setPlacement]=useState<ReturnType<typeof peopleMenuPlacement>>();
  const close=(restore=false)=>{closeMenu();if(restore)more.current?.focus();};
  useBrowserLayoutEffect(()=>{
    if(!open||!row.current||!menu.current||!more.current)return;
    const place=()=>{
      if(!row.current||!menu.current||!more.current)return;
      const anchor=more.current.getBoundingClientRect(),bounds={top:0,bottom:window.innerHeight};
      for(let parent=row.current.parentElement;parent;parent=parent.parentElement){
        if(!/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY))continue;
        const rect=parent.getBoundingClientRect();bounds.top=Math.max(bounds.top,rect.top);bounds.bottom=Math.min(bounds.bottom,rect.bottom);
      }
      if(anchor.bottom<=bounds.top||anchor.top>=bounds.bottom){closeMenu();return;}
      const next=peopleMenuPlacement(row.current.getBoundingClientRect(),anchor,bounds,
        Math.max(menu.current.scrollHeight,menu.current.firstElementChild?.scrollHeight??0));
      setPlacement(previous=>previous?.up===next.up&&previous.offset===next.offset&&previous.maxHeight===next.maxHeight?previous:next);
    };
    place();window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    const observer=new ResizeObserver(place);observer.observe(menu.current);
    if(menu.current.firstElementChild)observer.observe(menu.current.firstElementChild);
    return()=>{observer.disconnect();window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
  },[open]);
  useEffect(()=>{
    if(!open)return;
    const outside=(event:PointerEvent)=>{if(!row.current?.contains(event.target as Node))closeMenu();};
    document.addEventListener('pointerdown',outside);
    (menu.current?.querySelector<HTMLElement>('button:not([disabled])')??menu.current)?.focus();
    return()=>document.removeEventListener('pointerdown',outside);
  },[open]);
  const keys=(event:KeyboardEvent<HTMLDivElement>)=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);return;}
    if(event.key==='Tab'){close(true);return;}
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    const buttons=[...menu.current?.querySelectorAll<HTMLElement>('button:not([disabled]),[role="menuitem"]:not([disabled]):not([aria-disabled="true"])')??[]];
    if(!buttons.length)return;event.preventDefault();event.stopPropagation();
    const index=buttons.indexOf(document.activeElement as HTMLElement);
    const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:index<0?(event.key==='ArrowDown'?0:buttons.length-1):(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;
    buttons[next]?.focus();
  };
  return <div className="social-person-row" ref={row}
    onContextMenu={showMenu?event=>{event.preventDefault();showMenu();}:undefined}
    onKeyDown={showMenu?event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){event.preventDefault();showMenu();}}:undefined}>
    <button className="social-person" onClick={choose}>
      <XboxAvatar src={person.avatarUrl} name={person.gamertag} online={person.online}/>
      <span className="social-person-text"><strong><XboxGamertag name={person.gamertag}/></strong>
        <small>{person.presence||(person.online?'Online':'Offline')}{person.inParty?' · In a party':''}</small>
        {person.reason?<small className="social-person-reason">{person.reason}</small>:null}
        {person.lastSeen?<small className="social-person-last-seen">{ui("social.last_seen_21fd79")} {person.lastSeen}</small>:null}
      </span>
    </button>
    {showMenu?<button type="button" className="social-circle-button social-person-more" ref={more}
      aria-label={'Actions for '+person.gamertag} aria-haspopup="menu" aria-expanded={open} aria-controls={open?'people-actions-'+person.xuid:undefined}
      onClick={()=>open?close(true):showMenu()} onKeyDown={event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();showMenu();}}}><MoreHorizontal/></button>:null}
    {open?<div className={'social-person-menu'+(placement?.up?' opens-up':'')} style={{top:placement?.up?'auto':placement?.offset??58,
      bottom:placement?.up?placement.offset:undefined,maxHeight:placement?.maxHeight,overflowY:'auto'}}
      id={'people-actions-'+person.xuid} role="menu" aria-label={'Actions for '+person.gamertag} ref={menu} tabIndex={-1} onKeyDown={keys}>{actions}</div>:null}
  </div>;
}

/** Shared plain friend rendering remains usable by the social presentation tests. */
export function SocialFriends({friends,chooseChat}:{friends:XboxFriend[];chooseChat:(xuid:string)=>void}){
  return <div className="social-friends">{ordered(friends).map(person=><PeopleRow key={person.xuid} person={person} choose={()=>chooseChat(person.xuid)} open={false} closeMenu={()=>{}}/>)}</div>;
}

type Props={api:XboxSocialApi;account:string;friends:XboxFriend[];friendsChanged:(friends:XboxFriend[])=>void;openProfile:(xuid:string)=>void;
  chooseChat?:(xuid:string)=>void;party?:(person:XboxFriend)=>void;choosingChat?:boolean};
const lists=[['friends','Friends'],['recent','Recent players'],['suggested','Suggested'],['received-requests','Friend requests'],['sent-requests','Sent requests'],['blocked','Blocked']] as const;
type View='friends'|XboxPeopleList;

export function XboxPeopleBrowser({api,account,friends,friendsChanged,openProfile,chooseChat,party,choosingChat=false}:Props){
  const [view,setView]=useState<View>('friends'),[query,setQuery]=useState(''),[search,setSearch]=useState('');
  const [remote,setRemote]=useState<XboxPeopleState>(empty);
  const [friendsStatus,setFriendsStatus]=useState<{account?:string;api?:XboxSocialApi;busy:boolean;ready:boolean;problem?:string}>({busy:false,ready:false});
  const [menu,setMenu]=useState<{key:string;xuid:string}>();
  const requests=useRef<XboxPeopleResults>();if(!requests.current)requests.current=new XboxPeopleResults(setRemote);
  const friendGeneration=useRef(0),identity=useRef({api,account}),changed=useRef(friendsChanged);
  identity.current={api,account};changed.current=friendsChanged;
  const list:View=choosingChat&&view!=='search'?'friends':view;
  const key=list==='friends'?JSON.stringify([account,'friends']):scopeKey({account,list,query:list==='search'?search:undefined});
  const sameFriends=friendsStatus.account===account&&friendsStatus.api===api;
  const readyFriends=sameFriends&&friendsStatus.ready;
  const sameRemote=remote.key===key&&remote.api===api;
  const rows=list==='friends'?(readyFriends?ordered(friends.filter(person=>person.gamertag.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))):[]):sameRemote?remote.items:[];
  const busy=list==='friends'?!sameFriends||friendsStatus.busy:!sameRemote||remote.busy;
  const problem=list==='friends'?(sameFriends?friendsStatus.problem:undefined):sameRemote?remote.problem:undefined;
  const label=list==='search'?'Xbox results for “'+search+'”':lists.find(entry=>entry[0]===list)?.[1]??'People';

  async function refreshFriends(){
    const generation=++friendGeneration.current,bound={api,account};
    setFriendsStatus(previous=>({...previous,...bound,busy:true,ready:previous.account===account&&previous.api===api&&previous.ready,problem:undefined}));
    try{
      const value=await api.getXboxFriends();
      if(generation!==friendGeneration.current||identity.current.account!==account||identity.current.api!==api)return;
      changed.current(value);setFriendsStatus({...bound,busy:false,ready:true});
    }catch(error){
      if(generation!==friendGeneration.current||identity.current.account!==account||identity.current.api!==api)return;
      setFriendsStatus(previous=>({...previous,...bound,busy:false,problem:failure(error)}));
    }
  }
  useEffect(()=>{void refreshFriends();return()=>{friendGeneration.current++;};},[api,account]);
  useEffect(()=>{
    setMenu(undefined);
    if(list==='friends')requests.current!.clear();
    else void requests.current!.select(api,{account,list,query:list==='search'?search:undefined});
    return()=>requests.current!.cancel();
  },[api,account,list,search,choosingChat]);
  const select=(next:View)=>{requests.current!.cancel();setMenu(undefined);setView(next);setQuery('');setSearch('');};
  const refresh=()=>{
    setMenu(undefined);void refreshFriends();
    if(list!=='friends')void requests.current!.select(api,{account,list,query:list==='search'?search:undefined});
  };
  const pick=(xuid:string)=>{setMenu(undefined);if(chooseChat)chooseChat(xuid);else openProfile(xuid);};

  return <div className="social-people-pane" aria-busy={busy}>
    <div className="social-page-heading"><h2>{choosingChat?'New chat':'People'}</h2>
      <button type="button" className="social-circle-button" onClick={refresh} disabled={busy} aria-label={ui("social.refresh_xbox_people_66d233")} title={ui("social.refresh_xbox_people_66d233")}><RefreshCw/></button>
    </div>
    {!choosingChat?<label className="social-people-selector"><span className="social-sr-only">{ui("social.people_list_8dcadc")}</span>
      <select aria-label={ui("social.people_list_8dcadc")} value={list} onChange={event=>select(event.target.value as View)}>
        {lists.map(([value,text])=><option value={value} key={value}>{text}</option>)}
        {list==='search'?<option value="search">{ui("social.search_results_e978b0")}</option>:null}
      </select>
    </label>:null}
    <form className="social-people-search-form" onSubmit={event=>{event.preventDefault();const value=query.trim();if(value.length<2)return;requests.current!.cancel();setMenu(undefined);setSearch(value);setView('search');
      if(list==='search'&&search===value)void requests.current!.select(api,{account,list:'search',query:value});}}>
      <label className="social-search"><Search/><input value={query} maxLength={64} onChange={event=>{
        setQuery(event.target.value);setMenu(undefined);if(list==='search'){requests.current!.cancel();setView('friends');setSearch('');}
      }} placeholder={ui("social.search_gamertags_f72069")} aria-label={ui("social.find_an_xbox_player_1a269c")}/></label>
      <button className="social-people-search-submit" type="submit" disabled={query.trim().length<2}>{ui("social.search_xbox_b4c198")}</button>
    </form>
    <p className="social-people-search-hint">{ui("social.search_xbox_gamertags_with_at_least_two_characters_1f63df")}</p>
    {list==='search'?<button type="button" className="social-menu-action" onClick={()=>select('friends')}>{ui("social.back_to_friends_88bd70")}</button>:null}
    <div className="social-list-heading"><span>{label}</span><span>{rows.length}</span></div>
    <div className="social-friends">{rows.map(person=>{
      const open=menu?.key===key&&menu.xuid===person.xuid;
      return <PeopleRow key={account+':'+person.xuid} person={person} choose={()=>pick(person.xuid)} open={open}
        showMenu={()=>setMenu({key,xuid:person.xuid})} closeMenu={()=>setMenu(undefined)}
        actions={open?<XboxPlayerActions api={api} account={account} xuid={person.xuid} gamertag={person.gamertag} compact listedBlocked={list==='blocked'}
          openProfile={()=>{setMenu(undefined);openProfile(person.xuid);}}
          chat={chooseChat?()=>{setMenu(undefined);chooseChat(person.xuid);}:undefined}
          party={party?()=>{setMenu(undefined);party(person);}:undefined} changed={refresh}/>:undefined}/>;
    })}</div>
    {problem?<p className="social-error" role="alert">{problem}</p>:null}
    {busy?<div className="social-loading" role="status"><LoaderCircle className="spin"/><span>{ui("ui.loading_dc38088")} {list==='friends'?'friends':'Xbox people'}…</span></div>:null}
    {!busy&&!problem&&!rows.length?<p className="social-empty">{list==='friends'?(query?'No friends match. Use Search Xbox to find other players.':'No Xbox friends to display.'):'No '+(list==='search'?'Xbox players found.':label.toLocaleLowerCase()+' to display.')}</p>:null}
    {list!=='friends'&&sameRemote&&remote.truncated?<p className="social-people-search-hint">{ui("social.showing_d60431")} {rows.length} {ui("social.players_xbox_reports_that_this_list_is_incomplete_804adb")}</p>:null}
  </div>;
}
