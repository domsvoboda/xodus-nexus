import { expect,it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NotificationBell } from './Notifications';
import { Sidebar } from './App';
import { demoSnapshot } from '../shared/demo-data';
import type {XboxConversation} from '../shared/types';
import { canCheckNotificationUpdates, messageNoticeKey, notificationBadge, notificationItems, parseNotificationReads, rememberNotices, type Notice } from './notification-state';
const notice=(i:number):Notice=>({key:String(i),kind:'message',target:String(i+1),title:'Fixture',unread:true});
const thread=(peer='42',id='a'):XboxConversation=>({id:'conversation-'+peer,type:'OneToOne',participants:[peer],gamertag:'Xbox player',unread:true,lastMessage:{id,sender:peer,mine:false,hidden:false,text:'Fixture',timestamp:'2026-10-28T00:00:00Z'}});
it.each([[0,''],[1,'1'],[9,'9'],[10,'9+'],[100,'9+']])('caps bell badges at 9+ (%s)',(count,badge)=>{
  expect(notificationBadge(count as number)).toBe(badge);
  const html=renderToStaticMarkup(<NotificationBell notices={Array.from({length:count as number},(_,i)=>notice(i))} onSelect={()=>{}}/>);
  if(count)expect(html).toContain(`>${badge}</span>`);else expect(html).not.toContain('notification-badge');
  expect(html).toContain('aria-expanded="false"');expect(html).not.toContain('notification-panel');
});
it('puts the bell beside the account with independent buttons and an accessible exact count',()=>{
  const html=renderToStaticMarkup(<Sidebar data={demoSnapshot()} page="home" go={()=>{}} notifications={<NotificationBell notices={[notice(1),{...notice(2),unread:false}]} onSelect={()=>{}}/>}/>);
  expect(html).toContain('account-header');expect(html).toContain('Notifications, 1 unread');
  expect(html.indexOf('notification-bell')).toBeGreaterThan(html.indexOf('</button>'));
});
it('counts only actual unread summaries and known available updates, not checking/error/removed games',()=>{
  const data=demoSnapshot();const game=data.games[0];
  data.gameUpdates={[game.id]:{checking:false,available:true,latestVersion:'2'},removed:{checking:false,available:true,latestVersion:'2'}};
  const inbox=[thread()];
  const first=notificationItems(data,inbox,new Map([['42','Friend']]),[]);expect(first).toHaveLength(2);expect(first.every(value=>value.unread)).toBe(true);
  const seen=rememberNotices([],first.map(value=>value.key));expect(notificationItems(data,inbox,new Map(),seen).some(value=>value.unread)).toBe(false);
  // Neither opening the bell nor rendering the list mutates the ledger.
  expect(seen).toHaveLength(2);expect(first[0].title).toBe('Friend');
  inbox[0].lastMessage!.id='b';data.gameUpdates[game.id].latestVersion='3';
  expect(notificationItems(data,inbox,new Map(),seen).filter(value=>value.unread)).toHaveLength(2);
  data.gameUpdates[game.id].error='Fixture failure';expect(notificationItems(data,undefined,new Map(),[])).toEqual([]);
});
it('acknowledges exact viewed message IDs, not future messages or another peer',()=>{
  const seen=rememberNotices([],[messageNoticeKey('42','a')]);const data=demoSnapshot();
  const items=notificationItems(data,[thread('42','b'),thread('43','a')],new Map(),seen);
  expect(items.every(value=>value.unread)).toBe(true);
});
it('does not notify read, group, system or empty conversations as unread direct messages',()=>{
 const data=demoSnapshot();expect(notificationItems(data,[{...thread(),unread:false},{...thread('43'),type:'Group'}, {...thread('44'),type:'System'}, {...thread('45'),lastMessage:null}],new Map(),[])).toEqual([]);
});
it('bounds local read metadata, handles corrupt storage without trusting objects or message text',()=>{
  for(const raw of ['null','{}','[7]','["'+ 'x'.repeat(513)+'"]','x'.repeat(300001),'invalid'])expect(parseNotificationReads(raw)).toEqual([]);
  expect(parseNotificationReads('["a","a","b"]')).toEqual(['a','b']);
  expect(rememberNotices(['old'],Array.from({length:501},(_,i)=>String(i)))).toHaveLength(500);
});
it('does not automatically check updates during first-run, sign-in, games, downloads or existing checks',()=>{
  const data=demoSnapshot();data.downloads=[];data.settings.firstRunCompleted=true;data.games[0].storeId='9TEST';data.games[0].installedVersion='1';data.games[0].installState='ready';
  expect(canCheckNotificationUpdates(data)).toBe(true);
  data.auth.running=true;expect(canCheckNotificationUpdates(data)).toBe(false);data.auth.running=false;
  data.settings.firstRunCompleted=false;expect(canCheckNotificationUpdates(data)).toBe(false);data.settings.firstRunCompleted=true;
  data.gameOperation={gameId:'fixture',title:'Fixture',kind:'run',status:'running',log:[]} as any;expect(canCheckNotificationUpdates(data)).toBe(false);data.gameOperation=undefined;
  data.gameUpdates={fixture:{checking:true}};expect(canCheckNotificationUpdates(data)).toBe(false);
});
