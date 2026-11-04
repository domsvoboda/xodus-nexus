import {afterEach,it,expect,vi} from 'vitest';
import {promises as fs} from 'node:fs';
import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
import {RuntimeManager} from './runtime';
import * as processModule from './process';
import * as pointerModule from './runtime-pointer-commit';
import type {PointerCommitIO} from './runtime-pointer-commit';
const realCommit=pointerModule.commitRuntimePointer,realRun=processModule.run,roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
async function fixture(){
 const root=await fs.mkdtemp(path.join(process.env.TMPDIR??os.tmpdir(),'runtime-lease-'));roots.push(root);const runtimeRoot=path.join(root,'runtimes'),oldWine=path.join(runtimeRoot,'releases/previous/files/bin/wine'),save=path.join(root,'compatdata/game/pfx/drive_c/users/synthetic/save.dat'),link=path.join(path.dirname(save),'runtime-link');
 await fs.mkdir(path.dirname(oldWine),{recursive:true});await fs.writeFile(oldWine,'synthetic old loader',{mode:0o755});await fs.mkdir(path.dirname(save),{recursive:true});await fs.writeFile(save,'unchanged synthetic progress');await fs.symlink(oldWine,link);
 const oldPointer=JSON.stringify({name:'previous',winePath:oldWine,commit:'previous',installedAt:'before'});await fs.writeFile(path.join(runtimeRoot,'current.json'),oldPointer);
 const archive='nexus-runtime-fixture-x86_64.tar.xz',checksum=archive.replace('.tar.xz','.sha512sum'),payload=path.join(root,'payload/nexus-runtime-fixture'),wine=path.join(payload,'files/bin/wine');await fs.mkdir(path.dirname(wine),{recursive:true});await fs.writeFile(wine,'inert synthetic loader; never executed',{mode:0o755});
 const archiveFile=path.join(root,archive);expect((await realRun('tar',['-cJf',archiveFile,'-C',path.dirname(payload),path.basename(payload)])).code).toBe(0);const bytes=await fs.readFile(archiveFile),sum=Buffer.from(createHash('sha512').update(bytes).digest('hex')+'  '+archive+'\n');
 const fetcher=vi.fn(async(input:URL|RequestInfo)=>{const url=String(input);if(url.includes('/releases?'))return new Response(JSON.stringify([{tag_name:'runtime-fixture',published_at:'2026-11-03T00:00:00Z',assets:[archive,checksum].map(name=>({name,browser_download_url:'https://example.invalid/'+name}))}]));if(url.endsWith('/'+archive))return new Response(bytes);if(url.endsWith('/'+checksum))return new Response(sum);throw Error('Unexpected closed fixture request: '+url);}) as unknown as typeof fetch;
 vi.spyOn(processModule,'run').mockImplementation(async(command,args,options)=>{
  if(path.basename(command)==='wine')return{code:0,output:'wine synthetic'};
  if(command==='gh'){
   if(args[0]==='run'){const name=args[args.indexOf('--name')+1],dir=args[args.indexOf('--dir')+1];await fs.writeFile(path.join(dir,name),name===archive?bytes:sum);}
   return{code:0,output:'synthetic gh'};
  }
  if(command==='tar'||command==='sha512sum')return realRun(command,args,options);
  throw Error('External command forbidden in closed fixture: '+command);
 });
 const manager=new RuntimeManager(runtimeRoot,()=>{},()=>false,fetcher,'x64');await manager.refresh();
 const preserved=async()=>{expect(await fs.readFile(oldWine,'utf8')).toBe('synthetic old loader');expect(await fs.readFile(save,'utf8')).toBe('unchanged synthetic progress');expect(await fs.readlink(link)).toBe(oldWine);};
 const noStaging=async()=>expect((await fs.readdir(runtimeRoot)).filter(x=>x.startsWith('.staging-'))).toEqual([]);
 return{root,runtimeRoot,oldWine,oldPointer,manager,fetcher,preserved,noStaging,archive,checksum};
}

function faultIO(root:string,fault:string):PointerCommitIO {
 return {open:async(file,flags,mode)=>{const handle=await fs.open(file,flags,mode),directory=file===root;return {
 writeFile:async data=>{if(fault==='write')throw Error('injected write failure');await handle.writeFile(data);},
 sync:async()=>{if(fault===(directory?'dir sync':'file sync'))throw Error('injected '+fault+' failure');await handle.sync();},
 close:async()=>{await handle.close();if(fault==='file close'&&!directory)throw Error('injected close failure');}};},
 rename:async(from,to)=>{if(fault==='rename')throw Error('injected rename failure');await fs.rename(from,to);},unlink:fs.unlink};
}
it.each(['write','file sync','file close','rename'])('actual activation preserves prior active pointer/status and all old data on %s failure',async fault=>{
 const f=await fixture();vi.spyOn(pointerModule,'commitRuntimePointer').mockImplementation((root,pointer)=>realCommit(root,pointer,faultIO(root,fault)));
 const callbacks={persistSelection:vi.fn(async()=>{}),refreshAccount:vi.fn(async()=>{})};
 await expect(f.manager.installNexus(()=>{},callbacks)).rejects.toThrow('not activated');
 expect(await fs.readFile(path.join(f.runtimeRoot,'current.json'),'utf8')).toBe(f.oldPointer);expect(f.manager.current.name).toBe('previous');expect(f.manager.current.winePath).toBe(f.oldWine);expect(f.manager.busy).toBe(false);expect(callbacks.persistSelection).not.toHaveBeenCalled();
 expect((await fs.stat(path.join(f.runtimeRoot,'releases/nexus-runtime-fixture'))).isDirectory()).toBe(true);await f.preserved();await f.noStaging();
});
it.each(['dir sync','settings-before','settings-after','account','dir sync+settings'])('actual committed activation reports %s truthfully without reverting pointer or deleting old data',async fault=>{
 const f=await fixture();const sync=fault.startsWith('dir sync');vi.spyOn(pointerModule,'commitRuntimePointer').mockImplementation((root,pointer)=>realCommit(root,pointer,faultIO(root,sync?'dir sync':'')));
 let selected=f.oldWine;const callbacks={persistSelection:vi.fn(async(wine:string)=>{
   expect(f.manager.busy).toBe(true);await expect(f.manager.installNexus(()=>{})).rejects.toThrow('active');
   if(fault==='settings-before')throw Error('settings unavailable');selected=wine;
   if(fault==='settings-after'||fault==='dir sync+settings')throw Error('settings may have committed');
 }),refreshAccount:vi.fn(async()=>{expect(f.manager.busy).toBe(true);if(fault==='account')throw Error('account unavailable');})};
 const job=f.manager.installNexus(()=>{},callbacks);await expect(job).rejects.toThrow('runtime was activated');
 const current=JSON.parse(await fs.readFile(path.join(f.runtimeRoot,'current.json'),'utf8'));expect(current.name).toBe('nexus-runtime-fixture');expect(f.manager.current.name).toBe(current.name);expect(f.manager.current.winePath).toBe(current.winePath);expect(f.manager.current.phase).toContain('needs attention');expect(f.manager.busy).toBe(false);
 expect(callbacks.persistSelection).toHaveBeenCalledOnce();
 if(fault.includes('settings')){expect(callbacks.refreshAccount).not.toHaveBeenCalled();expect(f.manager.current.error).toContain('failed or could not be confirmed');}else expect(callbacks.refreshAccount).toHaveBeenCalledOnce();
 if(sync)expect(f.manager.current.error).toContain('directory sync');
 if(fault==='account')expect(f.manager.current.error).toContain('selection was saved, but refreshing account');
 expect(selected).toBe(fault==='settings-before'?f.oldWine:current.winePath);await f.preserved();await f.noStaging();expect((await fs.stat(path.join(f.runtimeRoot,'releases/previous'))).isDirectory()).toBe(true);
});
it('does not mask a committed durability failure with a later status notification failure',async()=>{
 const f=await fixture();vi.spyOn(pointerModule,'commitRuntimePointer').mockImplementation((root,pointer)=>realCommit(root,pointer,faultIO(root,'dir sync')));
 await expect(f.manager.installNexus(()=>{if(!f.manager.busy)throw Error('status failure');})).rejects.toThrow(/directory sync.*Status notification failed: status failure/);expect(f.manager.busy).toBe(false);await f.preserved();
});

it('reports successful activation and selection truthfully if only the final status notification fails',async()=>{
 const f=await fixture(),callbacks={persistSelection:vi.fn(async()=>{}),refreshAccount:vi.fn(async()=>{})};
 await expect(f.manager.installNexus(()=>{if(!f.manager.busy)throw Error('final notification failed');},callbacks)).rejects.toThrow('runtime was activated, but updating its status failed');
 expect(callbacks.persistSelection).toHaveBeenCalledOnce();expect(callbacks.refreshAccount).toHaveBeenCalledOnce();expect(JSON.parse(await fs.readFile(path.join(f.runtimeRoot,'current.json'),'utf8')).name).toBe('nexus-runtime-fixture');expect(f.manager.current.phase).toContain('needs attention');expect(f.manager.busy).toBe(false);await f.preserved();
});
