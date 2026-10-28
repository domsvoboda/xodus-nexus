import { expect,it,vi } from 'vitest';
import { XboxChatSocket } from './xbox-chat-socket.js';
const xuid='2533270000000001';
const credentials=(account='account')=>JSON.stringify({schema:1,kind:'chat-auth',account,xuid,authKey:'private socket key'});
class FakeSocket extends EventTarget {
  send=vi.fn();close=vi.fn(()=>this.dispatchEvent(new Event('close')));
  message(data:unknown){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(data)}));}
}
it('performs the shipped WhoAmI/Party-channel handshake and emits only selected party metadata',async()=>{
  const socket=new FakeSocket();const create=vi.fn(()=>socket as unknown as WebSocket);
  const client=new XboxChatSocket(()=>({binary:'cli',account:'account'}),async()=>credentials(),create);
  const changed=vi.fn();client.on('party-changed',changed);const job=client.connect();await vi.waitFor(()=>expect(create).toHaveBeenCalledOnce());
  socket.dispatchEvent(new Event('open'));expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({clientSeqNum:1,channel:{type:'System'},messageType:'WhoAmI'});
  socket.message({channel:{type:'System'},messageType:'WhoAmI',connectionId:'connection',serverNonce:'nonce',unusedSecret:'do not forward'});
  expect(await job).toEqual({xuid,connectionId:'connection',serverNonce:'nonce'});
  expect(JSON.parse(socket.send.mock.calls[1][0])).toEqual({clientSeqNum:2,channel:{type:'Party',id:xuid},messageType:'JoinChannel'});
  socket.message({channel:{type:'Party',id:xuid},messageType:'Party',payload:{type:'ShoulderTap',partyId:'party-id',changeNumber:2,extra:'private'}});
  expect(changed).toHaveBeenCalledOnce();expect(changed).toHaveBeenCalledWith({partyId:'party-id',changeNumber:2});client.close();
});
it('rejects a mismatched account before opening a socket',async()=>{
  const create=vi.fn();const client=new XboxChatSocket(()=>({binary:'cli',account:'account'}),async()=>credentials('other'),create);
  await expect(client.connect()).rejects.toThrow('account changed');expect(create).not.toHaveBeenCalled();
});
it('keeps socket credentials out of connection-failure messages',async()=>{
  const socket=new FakeSocket();const client=new XboxChatSocket(()=>({binary:'cli',account:'account'}),async()=>credentials(),()=>socket as unknown as WebSocket);
  const job=client.connect();await Promise.resolve();await Promise.resolve();socket.dispatchEvent(new Event('error'));
  await expect(job).rejects.toThrow('disconnected before its handshake');client.close();
});
it('rejects a backend change during authentication before opening a socket',async()=>{
 let connection={binary:'first',account:'account'},release!:(value:string)=>void;const create=vi.fn();
 const client=new XboxChatSocket(()=>connection,()=>new Promise<string>(resolve=>{release=resolve;}),create);
 const pending=client.connect(),rejected=expect(pending).rejects.toThrow('account changed');connection={binary:'second',account:'account'};release(credentials());await rejected;
 expect(create).not.toHaveBeenCalled();client.close();
});
it('discards old pending authentication when a new backend connects',async()=>{
 let connection={binary:'first',account:'account'},release!:(value:string)=>void;const socket=new FakeSocket(),create=vi.fn(()=>socket as unknown as WebSocket);
 const read=vi.fn().mockImplementationOnce(()=>new Promise<string>(resolve=>{release=resolve;})).mockResolvedValueOnce(credentials());
 const client=new XboxChatSocket(()=>connection,read,create);const old=client.connect(),rejected=expect(old).rejects.toThrow();
 connection={binary:'second',account:'account'};const next=client.connect();release(credentials());await rejected;
 await vi.waitFor(()=>expect(create).toHaveBeenCalledOnce());socket.message({channel:{type:'System'},messageType:'WhoAmI',connectionId:'new',serverNonce:'nonce'});
 expect(await next).toMatchObject({connectionId:'new'});client.close();
});
