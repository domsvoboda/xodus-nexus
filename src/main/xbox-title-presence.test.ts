import {afterEach,expect,it,vi} from 'vitest';
import {XboxTitlePresence,titlePresenceBody,titlePresenceUrl} from './xbox-title-presence';
import {GameInviteBridge} from './game-invite-bridge';
import {encodeInviteFields} from './game-invite-bridge';
import {createServer} from 'node:http';
import {createConnection} from 'node:net';
const post='A'.repeat(102)+'==',remove='B'.repeat(102)+'==',auth='XBL3.0 x=synthetic;synthetic-token';
const objects:XboxTitlePresence[]=[];
function fixture(status=200){
  let time=1000,current=true;
  const request=vi.fn(async(_url:string,_init:RequestInit)=>new Response(null,{status})),report=vi.fn();
  const presence=new XboxTitlePresence(()=>current,report,request,()=>time);objects.push(presence);
  return {presence,request,report,advance:(ms:number)=>{time+=ms;},invalidate:()=>{current=false;}};
}
afterEach(async()=>{for(const object of objects.splice(0))await object.stop();vi.useRealTimers();});
it('sends the running title only, without overriding game-specific activity or other devices',async()=>{
  const {presence,request,report}=fixture();expect(presence.accept('42',auth,post,remove)).toBe(true);await vi.waitFor(()=>expect(request).toHaveBeenCalledTimes(1));
  const [url,init]=request.mock.calls[0];expect(url).toBe(titlePresenceUrl('42'));expect(init.method).toBe('POST');expect(init.redirect).toBe('error');expect(init.body).toBe(titlePresenceBody);
  expect(init.headers).toEqual({Authorization:auth,Signature:post,'x-xbl-contract-version':'3','Content-Type':'application/json'});
  expect(init.signal).toBeInstanceOf(AbortSignal);await presence.stop();expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1][1]).toMatchObject({method:'DELETE',headers:{Signature:remove}});expect(request.mock.calls[1][1].body).toBeUndefined();
  expect(JSON.stringify(report.mock.calls)).not.toMatch(/synthetic|XBL3|42|AAAA|BBBB/);await presence.stop();expect(request).toHaveBeenCalledTimes(2);
  expect(presence.accept('42',auth,post,remove)).toBe(false);
});
it('rejects unsigned, mismatched, injected and malformed credentials without a network call',async()=>{
  const {presence,request}=fixture();for(const user of ['0','-1','42/foo','18446744073709551616'])expect(presence.accept(user,auth,post,remove)).toBe(false);
  for(const token of ['Bearer social-token',auth+'\r\nInjected: true',auth+'\0','XBL3.0 x=;token'])expect(presence.accept('42',token,post,remove)).toBe(false);
  for(const signature of ['',post+'A',post.slice(1),post.replace('A','\n')])expect(presence.accept('42',auth,signature,remove)).toBe(false);
  expect(request).not.toHaveBeenCalled();expect(presence.accept('42',auth,post,remove)).toBe(true);expect(presence.accept('43',auth,post,remove)).toBe(false);
});
it('deduplicates rapid refreshes and uses new signatures for a later heartbeat and cleanup',async()=>{
  const {presence,request,advance}=fixture();presence.accept('42',auth,post,remove);await new Promise(resolve=>setImmediate(resolve));
  for(let i=0;i<20;i++)presence.accept('42',auth,post,remove);expect(request).toHaveBeenCalledTimes(1);
  advance(60000);const next='C'.repeat(102)+'==';presence.accept('42',auth,next,next);await vi.waitFor(()=>expect(request).toHaveBeenCalledTimes(2));
  expect(request.mock.calls[1][1].headers).toMatchObject({Signature:next});await presence.stop();expect(request.mock.calls[2][1].headers).toMatchObject({Signature:next});
});
it('cleans up when the game heartbeat disappears, without setting the whole account offline',async()=>{
  vi.useFakeTimers();const {presence,request,advance}=fixture();presence.accept('42',auth,post,remove);await vi.advanceTimersByTimeAsync(0);
  advance(90000);await vi.advanceTimersByTimeAsync(1000);expect(request.mock.calls.map(value=>value[1].method)).toEqual(['POST','DELETE']);
  expect(presence.accept('43',auth,post,remove)).toBe(false);
  expect(presence.accept('42',auth,post,remove)).toBe(true);await vi.advanceTimersByTimeAsync(0);
  expect(request.mock.calls.map(value=>value[1].method)).toEqual(['POST','DELETE','POST']);
});
it('revokes on account/session change and never publishes for the new account using old credentials',async()=>{
  vi.useFakeTimers();const {presence,request,invalidate}=fixture();presence.accept('42',auth,post,remove);await vi.advanceTimersByTimeAsync(0);
  invalidate();expect(presence.accept('43',auth,post,remove)).toBe(false);await vi.advanceTimersByTimeAsync(1000);
  expect(request.mock.calls.map(value=>value[1].method)).toEqual(['POST','DELETE']);
});
it.each([401,403,429,500])('treats HTTP %s as optional, backs off and still attempts scoped cleanup',async status=>{
  const {presence,request,report,advance}=fixture(status);presence.accept('42',auth,post,remove);await vi.waitFor(()=>expect(report).toHaveBeenCalledTimes(1));
  expect(report.mock.calls[0][0]).toContain('not confirmed');advance(30000);presence.accept('42',auth,post,remove);
  if(status===429||status===500)expect(request).toHaveBeenCalledTimes(1);
  await presence.stop();expect(request.mock.calls.at(-1)?.[1].method).toBe('DELETE');
});
it('never issues DELETE before a pending POST has settled, even if stop is concurrent',async()=>{
  let pendingResolve:((value:Response)=>void)|undefined;
  const calls:RequestInit[]=[];
  const presence=new XboxTitlePresence(()=>true,()=>{},async(_url,init)=>{calls.push(init);if(init.method==='POST')return new Promise(resolve=>{pendingResolve=resolve;});return new Response(null,{status:204});});objects.push(presence);
  presence.accept('42',auth,post,remove);const stopping=presence.stop();expect(calls).toHaveLength(1);expect(calls[0].signal?.aborted).toBe(true);
  pendingResolve!(new Response(null,{status:201}));await stopping;expect(calls.map(value=>value.method)).toEqual(['POST','DELETE']);
});
it('keeps invitations independent and rejects another title/account at the loopback protocol boundary',async()=>{
  const {presence,request}=fixture();let current=true;
  const bridge=new GameInviteBridge('launch','Synthetic','123',()=>current,()=>{},()=>{},Date.now,()=>{},presence);
  expect(bridge.exchange(['presence-ready'])).toEqual([0,[]]);expect(request).not.toHaveBeenCalled();
  const legacy=new GameInviteBridge('legacy','Synthetic','123',()=>true,()=>{},()=>{});expect(legacy.exchange(['presence-ready'])[0]).not.toBe(0);
  expect(bridge.exchange(['presence','42','124',auth,post,remove])[0]).not.toBe(0);expect(request).not.toHaveBeenCalled();
  expect(bridge.exchange(['presence','42','123',auth,post,remove])[0]).toBe(0);expect(bridge.state().active).toEqual([]);
  expect(bridge.exchange(['hello-events','42','123'])[0]).toBe(0);expect(bridge.state().active).toHaveLength(1);
  expect(bridge.exchange(['presence','43','123',auth,post,remove])[0]).not.toBe(0);current=false;
  expect(bridge.exchange(['presence','42','123',auth,post,remove])[0]).not.toBe(0);await bridge.stop();
});
it('honors a service throttle while renewing credentials locally and can resume afterward',async()=>{
  let time=1000;const request=vi.fn(async()=>new Response(null,{status:429,headers:{'retry-after':'900'}}));
  const presence=new XboxTitlePresence(()=>true,()=>{},request,()=>time);objects.push(presence);
  presence.accept('42',auth,post,remove);await new Promise(resolve=>setImmediate(resolve));time+=300000;
  presence.accept('42',auth,post,remove);expect(request).toHaveBeenCalledTimes(1);time+=600000;
  presence.accept('42',auth,post,remove);await new Promise(resolve=>setImmediate(resolve));expect(request).toHaveBeenCalledTimes(2);
});
it('contains network and redirect failures without claiming success or leaking sensitive errors',async()=>{
  const request=vi.fn(async()=>{throw Error('synthetic-token secret-account redirect');}),report=vi.fn();
  const presence=new XboxTitlePresence(()=>true,report,request);objects.push(presence);
  expect(presence.accept('42',auth,post,remove)).toBe(true);await presence.stop();
  expect(request).toHaveBeenCalledTimes(2);expect(JSON.stringify(report.mock.calls)).not.toMatch(/secret|token|account|redirect/);
  expect(report.mock.calls.every(value=>value[0].includes('not confirmed'))).toBe(true);
});
it('does not publish, clear or authenticate anything for an idle or failed launch',async()=>{
  const {presence,request}=fixture();await presence.stop();expect(request).not.toHaveBeenCalled();
});
it('never lets logging failures reject the game cleanup promise',async()=>{
  const presence=new XboxTitlePresence(()=>true,()=>{throw Error('log unavailable');},async()=>new Response(null,{status:200}));objects.push(presence);
  expect(presence.accept('42',auth,post,remove)).toBe(true);await expect(presence.stop()).resolves.toBeUndefined();
});
it('publishes through actual capability-protected TCP and HTTP, and drains DELETE before shutdown completes',async()=>{
  const received:{method:string;route:string;body:string;headers:Record<string,string|string[]|undefined>}[]=[];
  const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=String(chunk);received.push({method:req.method!,route:req.url!,body,headers:req.headers});res.writeHead(req.method==='DELETE'?204:201);res.end();});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('Fixture address');
  const presence=new XboxTitlePresence(()=>true,()=>{},async(url,init)=>{
    expect(url).toBe(titlePresenceUrl('42'));
    return fetch(`http://127.0.0.1:${address.port}${new URL(url).pathname}`,init);
  });objects.push(presence);
  const bridge=new GameInviteBridge('own','Synthetic','123',()=>true,()=>{},()=>{},Date.now,()=>{},presence);await bridge.start();
  try{
    const reply=await new Promise<Buffer>((resolve,reject)=>{
      const socket=createConnection(bridge.port,'127.0.0.1'),chunks:Buffer[]=[];socket.on('error',reject);socket.on('data',data=>chunks.push(data));socket.on('end',()=>resolve(Buffer.concat(chunks)));
      socket.on('connect',()=>{const payload=encodeInviteFields(['presence','42','123',auth,post,remove]),header=Buffer.alloc(8);header.write('NXSI');header.writeUInt32LE(payload.length,4);socket.end(Buffer.concat([Buffer.from(bridge.key),header,payload]));});
    });
    expect(reply.readUInt32LE(4)).toBe(0);await vi.waitFor(()=>expect(received).toHaveLength(1));
    const first=bridge.stop(),second=bridge.stop();expect(first).toBe(second);await first;
    expect(received.map(value=>value.method)).toEqual(['POST','DELETE']);
    expect(received.every(value=>value.route==='/users/xuid(42)/devices/current/titles/current')).toBe(true);
    expect(received.map(value=>value.body)).toEqual([titlePresenceBody,'']);
    expect(received[0].headers.signature).toBe(post);expect(received[1].headers.signature).toBe(remove);
    expect(received[0].headers.authorization).toBe(auth);expect(received[0].headers['x-xbl-contract-version']).toBe('3');
  }finally{await bridge.stop();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
