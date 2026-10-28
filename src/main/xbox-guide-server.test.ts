import {afterEach,expect,it,vi} from 'vitest';
import {promises as fs} from 'node:fs';
import {request} from 'node:http';
import {createConnection} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {XboxGuideServer} from './xbox-guide-server.js';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function fixture(){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-guide-'));cleanup.push(()=>fs.rm(directory,{recursive:true,force:true}));
  await fs.mkdir(path.join(directory,'assets'));await fs.writeFile(path.join(directory,'overlay.html'),'<html>Local guide</html>');await fs.writeFile(path.join(directory,'assets','guide.js'),'void 0;');
  let account:string|undefined='fixture-account';const invoke=vi.fn(async(method:string,args:unknown[])=>({method,args}));
  const server=new XboxGuideServer({directory,account:()=>account,initial:()=>({auth:{username:'current'},party:{phase:'idle'},voice:{muted:true},invites:[],profile:undefined}),invoke});
  const url=await server.start(),origin=new URL(url).origin;cleanup.push(()=>server.stop());
  const rpc=(method:string,args:unknown[]=[],extra:Record<string,string>={})=>fetch(origin+'/rpc',{method:'POST',headers:{Authorization:'Bearer '+server.token,'Content-Type':'application/json',Origin:origin,...extra},body:JSON.stringify({method,args})});
  return {server,origin,url,rpc,invoke,setAccount:(next:string|undefined)=>account=next};
}
it('serves only the bundled local guide/assets with restrictive navigation and script policy',async()=>{
  const f=await fixture();const page=await fetch(f.url);expect(page.status).toBe(200);expect(await page.text()).toContain('Local guide');
  expect(page.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");expect(page.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
  expect((await fetch(f.origin+'/assets/guide.js')).status).toBe(200);
  for(const route of ['/index.html','/assets/../overlay.html?x=1','/assets/a/b.js','/assets/private.json','/overlay.html?token=secret'])expect((await fetch(f.origin+route)).status).toBe(404);
});
it('requires the private session token, exact host, and same-origin requests',async()=>{
  const f=await fixture();expect((await f.rpc('getXboxFriends',[],{Authorization:'Bearer wrong'})).status).toBe(403);
  expect((await f.rpc('getXboxFriends',[],{Origin:'https://external.example'})).status).toBe(403);
  const hostStatus=await new Promise<number>(resolve=>{const req=request(f.origin+'/rpc',{method:'POST',headers:{Host:'external.example',Authorization:'Bearer '+f.server.token,'Content-Type':'application/json'}},response=>{response.resume();resolve(response.statusCode!);});req.end('{"method":"getXboxFriends","args":[]}');});expect(hostStatus).toBe(403);
  expect(f.invoke).not.toHaveBeenCalled();expect((await f.rpc('getXboxFriends')).status).toBe(200);
});
it('exposes only social controls, with no raw media credentials, launcher operations, or arbitrary proxies',async()=>{
  const f=await fixture();for(const method of ['startXboxParty','allowXboxMicrophone','xboxVoiceHostReady','xboxPartyStart','xboxPartyMicrophone','xboxPartyVoiceAllowed','getSnapshot','run','fetch','updateBackend','openXboxPlayerProfile','popOutXboxChat'])expect((await f.rpc(method)).status).toBe(400);
  expect((await f.rpc('sendXboxMessage',['current','2','Explicit fixture message'])).status).toBe(200);
  expect(f.invoke).toHaveBeenCalledOnce();expect(f.invoke).toHaveBeenCalledWith('sendXboxMessage',['current','2','Explicit fixture message']);
});
it('revokes both reads and writes immediately after an account switch',async()=>{
  const f=await fixture();f.setAccount('other-account');expect((await f.rpc('getXboxFriends')).status).toBe(401);expect(f.invoke).not.toHaveBeenCalled();
  const events=await fetch(f.origin+'/events',{headers:{Authorization:'Bearer '+f.server.token}});expect(events.status).toBe(401);
});
it('never replays a failed mutation and does not publish a late result for another account',async()=>{
  const f=await fixture();f.invoke.mockImplementationOnce(async()=>{f.setAccount('other-account');return {private:'discard'};});
  const result=await f.rpc('sendXboxGameInvite',['2']);expect(result.status).toBe(401);expect(await result.text()).not.toContain('discard');expect(f.invoke).toHaveBeenCalledOnce();
});
it('streams projected shared state and game-only profile events without putting a token in the URL',async()=>{
  const f=await fixture(),controller=new AbortController();cleanup.push(async()=>controller.abort());
  const response=await fetch(f.origin+'/events',{headers:{Authorization:'Bearer '+f.server.token},signal:controller.signal});expect(response.status).toBe(200);
  const reader=response.body!.getReader(),decoder=new TextDecoder();const initial=decoder.decode((await reader.read()).value);
  expect(initial).toContain('event: auth');expect(initial).toContain('"username":"current"');expect(initial).not.toContain(f.server.token);expect(initial).not.toContain('fixture-account');
  f.server.publish('profile',{id:'fixture-ticket',xuid:'2'});expect(decoder.decode((await reader.read()).value)).toContain('fixture-ticket');controller.abort();
});
it('enforces the RPC concurrency bound even when many requests arrive pipelined on one connection',async()=>{
  const f=await fixture();const release:(()=>void)[]=[];let started=0,active=0,maximum=0;
  f.invoke.mockImplementation(async(method,args)=>{
    started++;active++;maximum=Math.max(maximum,active);
    try{await new Promise<void>(resolve=>release.push(resolve));return {method,args};}finally{active--;}
  });
  const url=new URL(f.origin),client=createConnection({host:'127.0.0.1',port:Number(url.port)});client.on('error',()=>{});client.on('data',()=>{});
  cleanup.push(async()=>{for(const done of release)done();client.destroy();});
  await new Promise<void>(resolve=>client.once('connect',resolve));
  const body=JSON.stringify({method:'getXboxFriends',args:[]});
  const packet=`POST /rpc HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${f.server.token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  client.write(packet.repeat(32));await vi.waitFor(()=>expect(started).toBeGreaterThanOrEqual(16));
  expect(started).toBe(16);expect(maximum).toBe(16);
});
