import {afterEach,expect,it,vi} from 'vitest';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {checkGuideHost,gameGuideMonitor,XboxGameGuide} from './xbox-game-guide.js';
const guides:XboxGameGuide[]=[],directories:string[]=[];
afterEach(async()=>{await Promise.all(guides.splice(0).map(guide=>guide.shutdown()));await Promise.all(directories.splice(0).map(directory=>fs.rm(directory,{recursive:true,force:true})));});
it('uses portable logical display bounds and rejects invalid geometry',()=>{
 expect(gameGuideMonitor({x:-1920,y:0,width:1920,height:1080})).toEqual({x:-1920,y:0,width:1920,height:1080});
 for(const width of [0,-1,NaN,1.5,32769])expect(()=>gameGuideMonitor({x:0,y:0,width,height:1080})).toThrow('monitor');
});

it('reaps an unresponsive host and revokes its token when the backend or game changes',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-guide-cleanup-'));directories.push(directory);
 const helper=path.join(directory,'stuck.py'),config=path.join(directory,'config');
 await fs.writeFile(helper,`import json,sys,pathlib,os,signal,time\nc=json.loads(sys.stdin.readline())\nc['pid']=os.getpid()\npathlib.Path(__file__).with_name('config').write_text(json.dumps(c))\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nprint(json.dumps({'event':'ready'}),flush=True)\nwhile True:time.sleep(1)\n`);
 let identity='account/backend-A';const invoke=vi.fn(async()=>{}),problem=vi.fn();
 const guide=new XboxGameGuide({directory,helper,account:()=>identity,initial:()=>({auth:{},profile:null}),invoke,problem,monitor:()=>({x:0,y:0,width:800,height:600}),enabled:()=>true});guides.push(guide);
 guide.bind('game-A','A');await guide.toggle();
 let value:{url:string;token:string;pid:number};
 await vi.waitFor(async()=>{value=JSON.parse(await fs.readFile(config,'utf8'));expect(value.pid).toBeGreaterThan(0);});
 const rpc=()=>fetch(new URL('/rpc',value!.url),{method:'POST',headers:{Authorization:'Bearer '+value!.token,'Content-Type':'application/json'},body:JSON.stringify({method:'getXboxFriends',args:[]})});
 identity='account/backend-B';expect((await rpc()).status).toBe(401);expect(invoke).not.toHaveBeenCalled();
 guide.unbind('game-A');await guide.shutdown();
 expect(()=>process.kill(value!.pid,0)).toThrow();expect(problem).not.toHaveBeenCalled();
 await expect(rpc()).rejects.toThrow();
});

it('checks dependencies without importing a display, starting a UI or accepting raw helper output',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-guide-check-'));directories.push(directory);
 const helper=path.join(directory,'check.py');
 await fs.writeFile(helper,"import sys,json\nassert sys.argv[1:]==['--check']\nprint(json.dumps({'ready':True}))\n");
 await expect(checkGuideHost(helper)).resolves.toBeUndefined();
 await fs.writeFile(helper,"print('private-output')\n");
 await expect(checkGuideHost(helper)).rejects.toThrow('requires Python');
});
it('opens and toggles only a bound game session without requiring compositor window metadata',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-portable-guide-'));directories.push(directory);
 const helper=path.join(directory,'host.py'),events=path.join(directory,'events');
 await fs.writeFile(helper,`import json,sys,pathlib\nc=json.loads(sys.stdin.readline())\np=pathlib.Path(__file__).with_name('events')\np.write_text(json.dumps({'monitor':c['monitor'],'gamePid':c.get('gamePid')}))\nprint(json.dumps({'event':'ready'}),flush=True)\nfor line in sys.stdin:\n command=line.strip()\n with p.open('a') as f:f.write('\\n'+command)\n if command=='quit':break\n print(json.dumps({'event':'shown' if command=='show' else 'hidden'}),flush=True)\n`);
 let enabled=true;
 const guide=new XboxGameGuide({directory,helper,account:()=> 'synthetic',initial:()=>({auth:{},party:{},voice:{},invites:[],profile:null}),invoke:async()=>{},problem:vi.fn(),monitor:()=>({x:0,y:0,width:1920,height:1080}),enabled:()=>enabled});guides.push(guide);
 expect(guide.interactive).toBe(false);expect(await guide.toggle()).toBe(false);guide.bind('fixture','Synthetic game',43210);expect(await guide.toggle()).toBe(true);
 await vi.waitFor(async()=>expect(await fs.readFile(events,'utf8')).toContain('\nshow'));
 await vi.waitFor(()=>expect(guide.interactive).toBe(true));
 expect(JSON.parse((await fs.readFile(events,'utf8')).split('\n')[0]).monitor).toEqual({x:0,y:0,width:1920,height:1080});
 expect(JSON.parse((await fs.readFile(events,'utf8')).split('\n')[0]).gamePid).toBe(43210);
 expect(await guide.toggle()).toBe(true);expect(guide.interactive).toBe(false);await vi.waitFor(async()=>expect(await fs.readFile(events,'utf8')).toContain('\nhide'));
 enabled=false;expect(await guide.toggle()).toBe(false);guide.unbind();expect(await guide.toggle()).toBe(false);
});

it('reports an unresolved game display honestly instead of choosing the cursor monitor',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-guide-monitor-error-'));directories.push(directory);
 const helper=path.join(directory,'host.py');
 await fs.writeFile(helper,"import sys,json\njson.loads(sys.stdin.readline())\nprint(json.dumps({'event':'error','code':'game-monitor-unavailable'}),flush=True)\n");
 const problem=vi.fn(),guide=new XboxGameGuide({directory,helper,account:()=> 'synthetic',initial:()=>({auth:{},profile:null}),invoke:async()=>{},problem,monitor:()=>({x:0,y:0,width:1920,height:1080}),enabled:()=>true});guides.push(guide);
 for(const pid of [-1,0,NaN,1.5,2**31])expect(()=>guide.bind('fixture','Synthetic',pid)).toThrow('process');
 guide.bind('fixture','Synthetic',43210);await guide.toggle();
 await vi.waitFor(()=>expect(problem).toHaveBeenCalledWith('Nexus Guide could not locate the game window on a supported display. Keep the game open and try again.'));
 expect(guide.interactive).toBe(false);
});
