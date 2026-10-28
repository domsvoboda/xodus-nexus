import type { AppSnapshot, XboxConversation } from '../shared/types';

export type Notice = { key: string; kind: 'message' | 'update'; target: string; title: string; detail?: string; unread: boolean };
export const messageNoticeKey=(peer: string, message: string)=>JSON.stringify(['message',peer,message]);
export function notificationBadge(count: number): string { return count>9?'9+':count>0?String(count):''; }
export function notificationItems(data: AppSnapshot, inbox: XboxConversation[] | undefined, names: Map<string,string>, seen: readonly string[]): Notice[] {
  const read=new Set(seen);
  const messages=(inbox??[]).flatMap(row=>{
    const peer=row.participants.length===1?row.participants[0]:undefined;
    return row.type==='OneToOne'&&row.unread&&peer&&row.lastMessage?[{key:messageNoticeKey(peer,row.lastMessage.id),kind:'message' as const,target:peer,title:names.get(peer)??(row.gamertag==='Xbox player'?'':row.gamertag),detail:row.lastMessage.timestamp??undefined}]:[];
  });
  const updates=data.games.flatMap(game=>{
    const update=data.gameUpdates?.[game.id];
    return update?.available===true&&update.latestVersion&&!update.error
      ? [{key:JSON.stringify(['update',game.id,update.latestVersion]),kind:'update' as const,target:game.id,title:game.title,detail:update.latestVersion}]:[];
  });
  return [...messages,...updates].map(item=>({...item,unread:!read.has(item.key)}));
}
export function parseNotificationReads(raw: string|null): string[] {
  if(!raw||raw.length>300_000)return [];
  try{const value:unknown=JSON.parse(raw);return Array.isArray(value)&&value.length<=500&&value.every(key=>typeof key==='string'&&key.length<=512)?[...new Set(value)]:[];}catch{return [];}
}
export function rememberNotices(seen: readonly string[], keys: readonly string[]): string[] {
  return [...new Set([...seen,...keys])].slice(-500);
}
/** Do not interrupt games, sign-in, downloads or a manually running update check. */
export function canCheckNotificationUpdates(data:AppSnapshot):boolean {
  return data.settings.firstRunCompleted===true&&data.auth.stored===true&&!data.auth.running&&data.backend.available
    &&data.backend.capabilities.account&&data.backend.capabilities.streaming
    &&(!data.gameOperation||['complete','failed'].includes(data.gameOperation.status))
    &&!data.backend.updating&&!data.runtime.updating&&!data.launcherUpdate?.updating
    &&!data.downloads.some(task=>['running','queued','paused'].includes(task.status))
    &&!Object.values(data.gameUpdates??{}).some(value=>value.checking)
    &&data.games.some(game=>game.installState==='ready'&&game.storeId&&game.installedVersion);
}
