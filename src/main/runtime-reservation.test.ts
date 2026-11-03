import {afterEach,describe,it,expect,vi} from 'vitest';
import {promises as fs,readFileSync} from 'node:fs';
import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
import {createContext,runInContext} from 'node:vm';import ts from 'typescript';
import {RuntimeManager,type RuntimeSettingsReservation} from './runtime.js';
import * as processModule from './process.js';
import {selectedWinePath} from './xodus-service.js';
function deferred<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return{promise,resolve};}
const roots:string[]=[],releases:(()=>void)[]=[],jobs:Promise<unknown>[]=[];const realRun=processModule.run;
afterEach(async()=>{for(const release of releases.splice(0))release();await Promise.allSettled(jobs.splice(0));vi.restoreAllMocks();await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
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
describe('runtime mutation reservations',()=>{
 it.each(['install','installNexus','rollbackCloudSavePreview'] as const)('reserves %s before discovery and releases rejection without changing old data',async method=>{
  const f=await fixture(),gate=deferred();releases.push(()=>gate.resolve());
  if(method==='install')vi.spyOn(f.manager,'check').mockImplementation(async()=>{await gate.promise;throw Error('held discovery failed');});
  else if(method==='installNexus')vi.spyOn(f.manager,'checkNexus').mockImplementation(async()=>{await gate.promise;throw Error('held discovery failed');});
  else vi.spyOn(f.manager as any,'readPointer').mockImplementation(async()=>{await gate.promise;return null;});
  const job=f.manager[method](()=>{});jobs.push(job);expect(f.manager.busy).toBe(true);expect(f.manager.current.updating).toBe(true);
  await expect(f.manager.installNexus(()=>{})).rejects.toThrow('active');expect(()=>f.manager.setRoot(path.join(f.root,'other'))).toThrow('active');expect(()=>f.manager.reserveSettingsChange()).toThrow('active');
  expect(await fs.readFile(path.join(f.runtimeRoot,'current.json'),'utf8')).toBe(f.oldPointer);await f.preserved();await f.noStaging();gate.resolve();await expect(job).rejects.toThrow();expect(f.manager.busy).toBe(false);expect(f.manager.current.updating).toBe(false);await f.preserved();
 });
 it.each(['install','installNexus','rollbackCloudSavePreview'] as const)('holds %s through post-activation persistence and retains old prefix/runtime',async method=>{
  const f=await fixture(),gate=deferred(),entered=deferred();releases.push(()=>gate.resolve());
  if(method==='install')(f.manager as any).latestArtifact={runId:123,commit:'a'.repeat(40),name:f.archive,checksumName:f.checksum};
  if(method==='rollbackCloudSavePreview'){
   const name='proton-xodus-base',wine=path.join(f.runtimeRoot,'releases',name,'files/bin/wine');await fs.mkdir(path.dirname(wine),{recursive:true});await fs.writeFile(wine,'inert base',{mode:0o755});await fs.writeFile(path.join(f.runtimeRoot,'current.json'),JSON.stringify({name:name+'-xgamesave-pr28-3fd4ae1091',winePath:f.oldWine,commit:'preview',installedAt:'before'}));
  }
  const job=f.manager[method](()=>{},async()=>{entered.resolve();await gate.promise;});jobs.push(job);await entered.promise;expect(f.manager.busy).toBe(true);expect(f.manager.current.installed).toBe(true);
  expect(()=>context(f.manager,f.runtimeRoot).ctx.ensureIdle('launch')).toThrow('Runtime');
  await expect(f.manager.installNexus(()=>{})).rejects.toThrow('active');expect(()=>f.manager.reserveSettingsChange()).toThrow('active');expect(()=>f.manager.setRoot(path.join(f.root,'other'))).toThrow('active');await f.preserved();gate.resolve();await job;expect(f.manager.busy).toBe(false);await f.preserved();await f.noStaging();
 });
 it('releases after callback failure without claiming pointer rollback',async()=>{
  const f=await fixture();await expect(f.manager.installNexus(()=>{},async()=>{throw Error('settings callback failed');})).rejects.toThrow('settings callback failed');expect(f.manager.busy).toBe(false);expect(f.manager.current.installed).toBe(true);expect(f.manager.current.name).toBe('nexus-runtime-fixture');expect(JSON.parse(await fs.readFile(path.join(f.runtimeRoot,'current.json'),'utf8')).name).toBe('nexus-runtime-fixture');await f.preserved();await f.noStaging();
 });
 it('releases when status notification throws before staging',async()=>{
  const f=await fixture();await expect(f.manager.installNexus(()=>{throw Error('status fixture failed');})).rejects.toThrow('status fixture failed');expect(f.manager.busy).toBe(false);expect(f.manager.current.updating).toBe(false);expect(await fs.readFile(path.join(f.runtimeRoot,'current.json'),'utf8')).toBe(f.oldPointer);await f.preserved();await f.noStaging();
 });
 it('validates exact live settings ownership and stale release cannot clear another mutation',async()=>{
  const f=await fixture(),other=new RuntimeManager(path.join(f.root,'other'),()=>{},()=>false);const token=f.manager.reserveSettingsChange();expect(f.manager.current.updating).toBe(true);
  expect(()=>other.assertSettingsReservation(token)).toThrow('active');expect(()=>f.manager.assertSettingsReservation({setRoot(){},release(){}})).toThrow('active');token.setRoot(f.runtimeRoot);token.release();expect(()=>token.setRoot(f.runtimeRoot)).toThrow('active');
  const next=f.manager.reserveSettingsChange();token.release();expect(f.manager.busy).toBe(true);f.manager.assertSettingsReservation(next);next.release();expect(f.manager.busy).toBe(false);
 });
 it('holds refreshSelection through a settings save and clears busy on rejection',async()=>{
  const f=await fixture(),gate=deferred(),entered=deferred();releases.push(()=>gate.resolve());const job=f.manager.refreshSelection(()=>{},async()=>{entered.resolve();await gate.promise;throw Error('held selection save failed');});jobs.push(job);await entered.promise;
  await expect(f.manager.installNexus(()=>{})).rejects.toThrow('active');expect(()=>f.manager.setRoot(path.join(f.root,'other'))).toThrow('active');gate.resolve();await expect(job).rejects.toThrow('held selection save failed');expect(f.manager.busy).toBe(false);expect(f.manager.current.updating).toBe(false);await f.preserved();
 });
});

const source=readFileSync(new URL('./index.ts',import.meta.url),'utf8');
function context(manager:RuntimeManager,root:string){
 const store:any={settings:{market:'US',winePath:'custom-wine',externalXodusRoot:'',runtimeRoot:root,multiAccountEnabled:false},downloads:[],setSettings:vi.fn(async(patch:any)=>{store.settings={...store.settings,...patch};return store.settings;})};
 const handlers=new Map<string,Function>();const ctx:any={runtime:manager,store,ipcMain:{handle:(name:string,fn:Function)=>handlers.set(name,fn)},path,offlinePermissionChanging:false,keyringSupport:{busy:false},authState:{running:false},authJob:undefined,shutdownStarted:false,downloadCancellations:new Set(),preparingInstall:false,preparingContent:false,preparingLaunch:false,finalizingGame:false,launcherUpdater:{state:{updating:false}},checkingGameUpdates:false,gameRemovalInProgress:false,operations:new Map(),gameOperation:undefined,installQueue:{size:0},assertActivityCompatible:vi.fn(),backend:{current:{updating:false,capabilities:{}},setExternalRoot:vi.fn(),refresh:vi.fn(async()=>{})},emitSnapshot:vi.fn(),refreshAccount:vi.fn(async()=>{}),savedAccountsEnabled:false,requestSavedAccount:vi.fn(async()=>{}),xboxOverlayPatch:()=>({}),interfaceLanguagePreference:(s:string)=>s==='invalid'?'system':s,downloadLimitKiB:()=>{},downloadLimitArgs:()=>{},shaderCacheLimits:()=>{},isBandwidthOnlyPatch:()=>false,isShaderCacheOnlyPatch:()=>false,launcherTray:{configure:()=>true},mainWindow:undefined,downloadLimitControls:{apply:vi.fn(async()=>{})}};
 const begin=source.indexOf('function ensureIdle('),end=source.indexOf('\nasync function syncManagedWinePath()',begin),settings=source.lastIndexOf("  ipcMain.handle('update-settings'");
 const code=source.slice(begin,end)+'\n'+source.slice(settings,source.indexOf("  ipcMain.handle('choose-directory'",settings));runInContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,createContext(ctx));return{ctx,store,handlers,handler:handlers.get('update-settings')!};
}
it('actual Settings reserves a held save, prevents install, then binds the committed root',async()=>{
 const f=await fixture(),{ctx,store,handler}=context(f.manager,f.runtimeRoot),gate=deferred(),entered=deferred(),newRoot=path.join(f.root,'new-runtime');releases.push(()=>gate.resolve());
 store.setSettings.mockImplementation(async(patch:any)=>{store.settings={...store.settings,...patch};entered.resolve();await gate.promise;return store.settings;});vi.spyOn(f.manager,'refresh').mockImplementation(async()=>f.manager.current);
 ctx.requestSavedAccount=vi.fn(async(_action:string,_name:string,token:RuntimeSettingsReservation)=>{expect(token).toBeDefined();ctx.ensureIdle(undefined,token);});
 const job=handler({}, {runtimeRoot:newRoot,multiAccountEnabled:true});jobs.push(job);await entered.promise;expect(f.manager.busy).toBe(true);await expect(f.manager.installNexus(()=>{})).rejects.toThrow('active');gate.resolve();await job;expect(f.manager.current.runtimeRoot).toBe(newRoot);expect(store.settings.runtimeRoot).toBe(newRoot);expect(f.manager.busy).toBe(false);await f.preserved();expect(ctx.refreshAccount).toHaveBeenCalled();
});
it('blocked or invalid actual Settings changes leave settings and old paths untouched',async()=>{
 const f=await fixture(),{store,handler}=context(f.manager,f.runtimeRoot),old={...store.settings},token=f.manager.reserveSettingsChange();await expect(handler({}, {runtimeRoot:path.join(f.root,'blocked')})).rejects.toThrow();expect(store.setSettings).not.toHaveBeenCalled();expect(store.settings).toEqual(old);token.release();
 const reserve=vi.spyOn(f.manager,'reserveSettingsChange');
 await expect(handler({}, {runtimeRoot:path.join(f.root,'invalid'),interfaceLanguage:'invalid'})).rejects.toThrow('Invalid interface language');expect(reserve).not.toHaveBeenCalled();expect(f.manager.busy).toBe(false);expect(store.settings).toEqual(old);await f.preserved();
});
it('committed roots remain coherent when a later tray side effect fails',async()=>{
 const f=await fixture(),{ctx,store,handler}=context(f.manager,f.runtimeRoot),newRoot=path.join(f.root,'committed-runtime');ctx.launcherTray.configure=()=>false;
 await expect(handler({}, {runtimeRoot:newRoot,closeToTray:true})).rejects.toThrow('system tray');expect(store.settings.runtimeRoot).toBe(newRoot);expect(f.manager.current.runtimeRoot).toBe(newRoot);expect(f.manager.busy).toBe(false);await f.preserved();
});
it('own runtime exception never bypasses other activity guards or accepts foreign/expired tokens',async()=>{
 const f=await fixture(),{ctx}=context(f.manager,f.runtimeRoot),token=f.manager.reserveSettingsChange(),other=new RuntimeManager(path.join(f.root,'other'),()=>{},()=>false),foreign=other.reserveSettingsChange();
 expect(()=>ctx.ensureIdle(undefined,token)).not.toThrow();ctx.preparingLaunch=true;expect(()=>ctx.ensureIdle(undefined,token)).toThrow('launch');ctx.preparingLaunch=false;ctx.finalizingGame=true;expect(()=>ctx.ensureIdle(undefined,token)).toThrow('cleanup');ctx.finalizingGame=false;
 expect(()=>ctx.ensureIdle(undefined,foreign)).toThrow('active');token.release();expect(()=>ctx.ensureIdle(undefined,token)).toThrow('active');foreign.release();
});
it.each(['preparingLaunch','finalizingGame'])('actual runtime admission rejects %s before discovery',async flag=>{
 const f=await fixture(),ast=ts.createSourceFile('index.ts',source,ts.ScriptTarget.ES2022,true);let expression='';function visit(node:ts.Node){if(ts.isNewExpression(node)&&node.expression.getText(ast)==='RuntimeManager')expression=node.arguments![2].getText(ast);ts.forEachChild(node,visit);}visit(ast);expect(expression).toBeTruthy();
 const ctx:any={preparingLaunch:false,finalizingGame:false,downloadCancellations:new Set(),operations:new Map(),installQueue:{size:0},preparingInstall:false,backend:{current:{updating:false}}};ctx[flag]=true;const active=runInContext('('+expression+')',createContext(ctx));const manager=new RuntimeManager(f.runtimeRoot,()=>{},active,f.fetcher,'x64');await expect(manager.installNexus(()=>{})).rejects.toThrow('active');expect(f.fetcher).not.toHaveBeenCalled();await f.preserved();
});

it('actual runtime-refresh holds selection/save through account refresh and publishes idle status',async()=>{
 const f=await fixture(),{ctx,store,handlers,handler}=context(f.manager,f.runtimeRoot),gate=deferred(),entered=deferred();releases.push(()=>gate.resolve());
 const nextWine=path.join(f.runtimeRoot,'releases/next/files/bin/wine');await fs.mkdir(path.dirname(nextWine),{recursive:true});await fs.writeFile(nextWine,'inert next',{mode:0o755});await fs.writeFile(path.join(f.runtimeRoot,'current.json'),JSON.stringify({name:'next',winePath:nextWine,commit:'next',installedAt:'after'}));store.settings.winePath=f.oldWine;
 store.setSettings.mockImplementation(async(patch:any)=>{store.settings={...store.settings,...patch};entered.resolve();await gate.promise;return store.settings;});ctx.selectedWinePath=selectedWinePath;
 const begin=source.indexOf('async function syncManagedWinePath()'),end=source.indexOf('\nconst accountRefresh',begin),ipc=source.indexOf("  ipcMain.handle('runtime-refresh', async");
 runInContext(ts.transpileModule(source.slice(begin,end)+'\n'+source.slice(ipc,source.indexOf("  ipcMain.handle('runtime-check-update'",ipc)),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
 const job=handlers.get('runtime-refresh')!({});jobs.push(job);await entered.promise;expect(f.manager.busy).toBe(true);await expect(f.manager.installNexus(()=>{})).rejects.toThrow('active');await expect(handler({}, {runtimeRoot:path.join(f.root,'blocked')})).rejects.toThrow();expect(store.setSettings).toHaveBeenCalledTimes(1);
 gate.resolve();const status=await job;expect(status.updating).toBe(false);expect(f.manager.busy).toBe(false);expect(store.settings.winePath).toBe(nextWine);expect(store.settings.runtimeRoot).toBe(f.runtimeRoot);expect(ctx.refreshAccount).toHaveBeenCalled();await f.preserved();
});
it('unchanged full-form component values do not overwrite a newer selection after account enable',async()=>{
 const f=await fixture(),{ctx,store,handler}=context(f.manager,f.runtimeRoot),gate=deferred(),entered=deferred();releases.push(()=>gate.resolve());const form={...store.settings,multiAccountEnabled:true};ctx.requestSavedAccount=vi.fn(async()=>{entered.resolve();await gate.promise;});
 const job=handler({},form);jobs.push(job);await entered.promise;expect(f.manager.busy).toBe(false);
 const wine=await f.manager.installNexus(()=>{},async winePath=>{await store.setSettings({winePath});});gate.resolve();await job;expect(store.settings.winePath).toBe(wine);expect(store.settings.multiAccountEnabled).toBe(true);expect(f.manager.busy).toBe(false);await f.preserved();
});
it('captures an artifact before a later release check can replace mutable cached fields',async()=>{
 const f=await fixture(),gate=deferred(),entered=deferred();releases.push(()=>gate.resolve());const original=(f.fetcher as any).getMockImplementation();
 (f.fetcher as any).mockImplementation(async(input:URL|RequestInfo)=>{if(String(input).endsWith('/'+f.archive)){entered.resolve();await gate.promise;}return original(input);});
 const job=f.manager.installNexus(()=>{});jobs.push(job);await entered.promise;Object.assign((f.manager as any).nexusArtifact,{name:'changed.tar.xz',checksumName:'changed.sha512sum',version:'changed'});gate.resolve();await job;expect(f.manager.current.name).toBe('nexus-runtime-fixture');expect(f.manager.current.commit).toBe('runtime-fixture');await f.preserved();
});
