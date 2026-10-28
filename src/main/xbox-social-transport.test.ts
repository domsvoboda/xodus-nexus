import {afterEach,beforeEach,expect,it} from 'vitest';
import {promises as fs} from 'node:fs';import path from 'node:path';import os from 'node:os';
import {readSocialBroker,resetSocialTransport,supportsSocialBroker} from './xbox-social-transport.js';
let root:string,binary:string,events:string;
beforeEach(async()=>{
 root=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-social-transport-'));binary=path.join(root,'social-fixture.mjs');events=path.join(root,'events.jsonl');
 await fs.writeFile(binary,`#!/usr/bin/env node
import fs from 'node:fs';import readline from 'node:readline';
const log=value=>fs.appendFileSync(${JSON.stringify(events)},JSON.stringify(value)+'\\n');
if(process.argv.includes('--help')){console.log('  listen   private social transport');process.exit(0);}
log({event:'start',pid:process.pid});let ordinal=0;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);log({event:'request',operation:request.args[0]});ordinal++;
 const respond=()=>{
  if(request.args[0]==='malformed'){console.log('private-secret-bad-frame');return;}
  if(request.args[0]==='send-message'){console.log(JSON.stringify({id:request.id,ok:false,stage:'social-http-status'}));return;}
  console.log(JSON.stringify({id:request.id,ok:true,result:{pid:process.pid,ordinal,input:request.input}}));
 };
 if(request.args[0]==='delayed')setTimeout(respond,80);else respond();
});
`,{mode:0o755});
});
afterEach(async()=>{resetSocialTransport();await fs.rm(root,{recursive:true,force:true});});
const read=(args:string[],input?:string,signal=new AbortController().signal)=>readSocialBroker(binary,args,input,signal,()=>Error('Safe service failure'));
const history=async()=> (await fs.readFile(events,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
it('prioritizes interactive chat over queued optional profiles without repeating a write',async()=>{
 const first=read(['delayed']),profile=read(['profile','2']),conversation=read(['conversation','2']);
 await Promise.all([first,profile,conversation]);
 expect((await history()).filter(event=>event.event==='request').map(event=>event.operation)).toEqual(['delayed','conversation','profile']);
});
it('reuses one helper and preserves framed Unicode/newline input without putting the body in argv',async()=>{
 expect(await supportsSocialBroker(binary)).toBe(true);
 const input='A private test "+line\\n☃';const first=JSON.parse(await read(['party'],input));const second=JSON.parse(await read(['invites']));
 expect(first.input).toBe(input);expect(first.pid).toBe(second.pid);expect(second.ordinal).toBe(2);
 expect((await history()).filter(e=>e.event==='start')).toHaveLength(1);expect(JSON.stringify(await history())).not.toContain('private test');
});
it('cancels a read while preserving the helper and ordering the next response correctly',async()=>{
 const controller=new AbortController();const first=read(['delayed'],undefined,controller.signal);const rejected=expect(first).rejects.toThrow('cancelled');
 await new Promise(resolve=>setTimeout(resolve,20));controller.abort();const second=JSON.parse(await read(['friends']));await rejected;
 expect(second.ordinal).toBe(2);expect((await history()).filter(e=>e.event==='start')).toHaveLength(1);
});
it('does not retry a failed mutation or include a malformed private frame in errors',async()=>{
 await expect(read(['send-message'],'private text')).rejects.toThrow('Safe service failure');
 expect((await history()).filter(e=>e.operation==='send-message')).toHaveLength(1);
 await expect(read(['malformed'])).rejects.toThrow('not retried');
});
