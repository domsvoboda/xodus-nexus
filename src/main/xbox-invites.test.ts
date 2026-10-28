import {expect,it,vi} from 'vitest';
import {XboxInvites,inviteDate} from './xbox-invites.js';
const row=(extra:Record<string,unknown>={})=>({id:'notice',kind:'party',handle:'private-invite-handle',handleType:'mpsd',gamertag:'Friend',sender:'2',expiration:'2099-10-23T17:00:00Z',timestamp:'2026-10-23T16:00:00Z',titleId:null,titleName:null,activationInfo:null,...extra});
const result=(items:unknown[],account='account',recipient='1')=>JSON.stringify({schema:1,kind:'invites',account,recipient,items});
it('keeps handles and activation data in main and resolves only an unexpired inbox party entry',async()=>{
 const read=vi.fn(async()=>result([row()]));const inbox=new XboxInvites(()=>({binary:'cli',account:'account'}),read);
 const items=await inbox.list();expect(items[0]).toMatchObject({id:'party:notice',gamertag:'Friend'});expect(JSON.stringify(items)).not.toContain('private');
 expect(await inbox.partyHandle('party:notice')).toBe('private-invite-handle');
 await expect(inbox.partyHandle('party:other')).rejects.toThrow('unavailable');
 const expired=new XboxInvites(()=>({binary:'cli',account:'account'}),async()=>result([row({expiration:'2000-01-01T00:00:00Z'})]));
 await expect(expired.partyHandle('party:notice')).rejects.toThrow('expired');
});
it('does not toast historic invitations or return a mismatched account and emits only safe new-invite fields',async()=>{
 let rows=[row()];const inbox=new XboxInvites(()=>({binary:'cli',account:'account'}),async()=>result(rows));const notified=vi.fn();inbox.on('invite',notified);
 await inbox.list();expect(notified).not.toHaveBeenCalled();rows=[row(),row({id:'new-notice',handle:'other-private-handle'})];await inbox.list(true);
 expect(notified).toHaveBeenCalledOnce();expect(JSON.stringify(notified.mock.calls)).not.toContain('private');
 const wrong=new XboxInvites(()=>({binary:'cli',account:'account'}),async()=>result([row()],'another-account'));await expect(wrong.list()).rejects.toThrow('Invalid');
});
it('uses UTC for the shipped activity-expiry format and rejects invalid or ambiguous dates',()=>{
 expect(inviteDate('10/23/2026 12:30:00 PM')).toBe(Date.UTC(2026,9,23,12,30));
 expect(inviteDate('10/23/2026 12:30:00 AM')).toBe(Date.UTC(2026,9,23,0,30));
 for(const value of ['2/30/2026 1:00:00 PM','1/1/2026 13:00:00 PM','tomorrow','2026-10-23 12:00:00'])expect(()=>inviteDate(value)).toThrow('Invalid');
});
it('builds distinct session and activity acceptance URIs for the authenticated recipient only',async()=>{
 const handle='11111111-2222-3333-4444-555555555555';
 let rows=[row({kind:'game',handle,titleId:'6BE41AB5'})];
 const inbox=new XboxInvites(()=>({binary:'cli',account:'account'}),async()=>result(rows));
 const session=await inbox.gameInvite('game:notice');expect(session.titleId).toBe(String(0x6be41ab5));
 const sessionUri=new URL(session.uri);expect(sessionUri.hostname).toBe('inviteHandleAccept');expect(sessionUri.searchParams.get('handle')).toBe(handle);expect(sessionUri.searchParams.get('invitedXuid')).toBe('1');expect(sessionUri.searchParams.get('senderXuid')).toBe('2');expect(sessionUri.searchParams.has('context')).toBe(false);
 rows=[row({kind:'game',handle:'opaque/session?key=a b&value=\"quoted\"',handleType:'activity',titleId:String(0x6be41ab5)})];
 const activity=await inbox.gameInvite('game:notice'),activityUri=new URL(activity.uri);
 expect(activityUri.hostname).toBe('inviteAccept');expect(activityUri.searchParams.get('connectionString')).toBe('opaque/session?key=a b&value=\"quoted\"');expect(activityUri.searchParams.get('invitedUser')).toBe('1');expect(activityUri.searchParams.has('handle')).toBe(false);expect(activity.uri).not.toContain('"');expect(activity.uri).toContain('%20');
});
it('rejects expired, malformed, wrong-kind, or unbound game invitations',async()=>{
 for(const extra of [{kind:'party'},{kind:'game',expiration:'2000-01-01T00:00:00Z'},{kind:'game',titleId:null},{kind:'game',titleId:'not-a-game'},{kind:'game',titleId:'4294967296'},{kind:'game',titleId:'123',handle:'not-a-guid'}]){
  const inbox=new XboxInvites(()=>({binary:'cli',account:'account'}),async()=>result([row(extra)]));await expect(inbox.gameInvite(extra.kind+':notice')).rejects.toThrow();
 }
 const missing=new XboxInvites(()=>({binary:'cli',account:'account'}),async()=>JSON.stringify({schema:1,kind:'invites',account:'account',items:[row({kind:'game',titleId:'123'})]}));
 await expect(missing.gameInvite('game:notice')).rejects.toThrow('backend');
 const wrong=new XboxInvites(()=>({binary:'cli',account:'account'}),async()=>result([], 'account','18446744073709551616'));await expect(wrong.list()).rejects.toThrow('recipient');
});
it('prefers the real PC activation title over a different console notification title',async()=>{
 const base={kind:'game',handle:'11111111-2222-3333-4444-555555555555',titleId:'999'};
 for(const activationInfo of ['{"win32":{"titleId":123},"xboxone":{"titleId":999}}','{"win32":{"titleId":"123"}}']){
  const inbox=new XboxInvites(()=>({binary:'cli',account:'account'}),async()=>result([row({...base,activationInfo})]));expect((await inbox.gameInvite('game:notice')).titleId).toBe('123');
 }
 for(const activationInfo of ['{"win32":{"titleId":0}}','{"xboxone":{"titleId":999}}','{"xcloud":{"titleId":123}}','{"windows-onecore":{"titleId":"123","pfn":"example"}}','malformed']){
  const inbox=new XboxInvites(()=>({binary:'cli',account:'account'}),async()=>result([row({...base,activationInfo})]));await expect(inbox.gameInvite('game:notice')).rejects.toThrow();
 }
});
