import {afterEach,expect,it,vi} from 'vitest';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {commitRuntimePointer,type PointerCommitIO} from './runtime-pointer-commit';
const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'pointer-commit-'));roots.push(root);await fs.writeFile(path.join(root,'current.json'),'old pointer');const save=path.join(root,'old-prefix/save');await fs.mkdir(path.dirname(save),{recursive:true});await fs.writeFile(save,'old progress');return{root,save,ino:(await fs.stat(save)).ino};}
function ioFault(root:string,fault:string,events:string[]):PointerCommitIO {
 return {open:async(file,flags,mode)=>{const directory=file===root;const tag=directory?'dir':'file';events.push(tag+' open');if(fault===tag+' open')throw Error(fault);const handle=await fs.open(file,flags,mode);return {
 writeFile:async data=>{events.push('write');if(fault==='write')throw Error(fault);await handle.writeFile(data);},
 sync:async()=>{events.push(tag+' sync');if(fault===tag+' sync')throw Error(fault);await handle.sync();},
 close:async()=>{events.push(tag+' close');await handle.close();if(fault===tag+' close')throw Error(fault);}};},
 rename:async(from,to)=>{events.push('rename');if(fault==='rename')throw Error(fault);await fs.rename(from,to);},unlink:async file=>{events.push('unlink');await fs.unlink(file);}};
}
it.each(['file open','write','file sync','file close','dir open','rename'])('preserves old pointer and nonempty save when %s fails before visibility',async fault=>{
 const f=await fixture(),events:string[]=[];await expect(commitRuntimePointer(f.root,{name:'new'},ioFault(f.root,fault,events))).rejects.toThrow('not activated');
 expect(await fs.readFile(path.join(f.root,'current.json'),'utf8')).toBe('old pointer');expect(await fs.readFile(f.save,'utf8')).toBe('old progress');expect((await fs.stat(f.save)).ino).toBe(f.ino);expect((await fs.readdir(f.root)).filter(n=>n.startsWith('.current-'))).toEqual([]);
});
it.each(['dir sync','dir close'])('reports committed with unknown durability after %s failure',async fault=>{
 const f=await fixture(),events:string[]=[];const result=await commitRuntimePointer(f.root,{name:'new'},ioFault(f.root,fault,events));expect(result.committed).toBe(true);expect(result.durability).toBe('unknown');expect(result.errors.map(e=>e.message).join()).toContain(fault==='dir sync'?'directory sync':'directory close');expect(JSON.parse(await fs.readFile(path.join(f.root,'current.json'),'utf8'))).toEqual({name:'new'});expect(await fs.readFile(f.save,'utf8')).toBe('old progress');
});
it('publishes only after full write, file sync and close, then syncs directory',async()=>{
 const f=await fixture(),events:string[]=[];expect(await commitRuntimePointer(f.root,{name:'new'},ioFault(f.root,'',events))).toEqual({committed:true,durability:'confirmed',errors:[]});expect(events).toEqual(['file open','write','file sync','file close','dir open','rename','dir sync','dir close']);
});
it('uses exclusive private temps and never deletes an existing collision or unrelated stale link',async()=>{
 const f=await fixture(),stale=path.join(f.root,'.current-stale.tmp');await fs.symlink('old-prefix/save',stale);let collision='';
 const io:PointerCommitIO={...fs,open:async(file,flags,mode)=>{collision=file;await fs.writeFile(file,'preexisting bytes');return fs.open(file,flags,mode);}};
 await expect(commitRuntimePointer(f.root,{name:'new'},io)).rejects.toThrow('not activated');expect(await fs.readFile(collision,'utf8')).toBe('preexisting bytes');expect(await fs.readlink(stale)).toBe('old-prefix/save');expect(await fs.readFile(f.save,'utf8')).toBe('old progress');expect(await fs.readFile(path.join(f.root,'current.json'),'utf8')).toBe('old pointer');
});

it('does not unlink a replacement at the former temporary path after rename',async()=>{
 const f=await fixture();let former='';const io:PointerCommitIO={...fs,rename:async(from,to)=>{await fs.rename(from,to);former=from;await fs.writeFile(from,'unrelated replacement');}};
 expect((await commitRuntimePointer(f.root,{name:'new'},io)).durability).toBe('confirmed');expect(await fs.readFile(former,'utf8')).toBe('unrelated replacement');
});
