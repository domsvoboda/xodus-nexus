import {readFileSync} from 'node:fs';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {expect,it,vi} from 'vitest';
import {assertStoreOfferAccess} from './catalog-access.js';

// Execute the actual main-process preparation, queue closure and resume IPC.
// All side effects are synthetic; no Electron, account, backend or game starts.
const source=readFileSync(new URL('./index.ts',import.meta.url),'utf8');
const parsed=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true);
const names=new Set(['storeAccess','verifyStoreInstall','startInstall','prepareInstall']);
const functions=parsed.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name&&names.has(node.name.text)).map(node=>node.getText(parsed)).join('\n');
const start=source.indexOf("  ipcMain.handle('resume-download'",source.indexOf('function registerIpc():'));
const resume=source.slice(start,source.indexOf("  ipcMain.handle('remove-download'",start));
const code=ts.transpileModule(functions+'\n'+resume+'\nglobalThis.install=startInstall;', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const id='9AAAAAAAAAAA';
function fixture(){
 const handlers=new Map<string,Function>(),jobs:any[]=[],downloads:any[]=[];
 let granted=true;
 const plan=vi.fn(async()=>({choices:[{supported:true,contentId:'content',kind:'Game',productId:id}]}));
 const run=vi.fn(async()=>{}),prepare=vi.fn(async()=>{});
 const context:any={path,assertStoreOfferAccess,authState:{stored:true,running:false,username:'store'},backend:{current:{binaryPath:'/backend',capabilities:{library:true,packageSelection:true,streamingControls:true}},externalDownloadRunning:async()=>false},
  store:{settings:{market:'US',runtimeRoot:'/synthetic/runtime'},games:[],downloads,addDownload:async(task:any)=>{downloads.push(task);},updateDownload:async()=>{},removeDownload:async()=>{}},
  currentMarket:()=> 'US',accountLibrary:{select:vi.fn(),storeAccess:async()=>({account:'store',backend:'/backend',market:'US',configuredMarket:'US',checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString(),accessByProductId:granted?{[id]:'owned'}:{}})},
  stopGameUpdateCheck:async()=>{},ensureIdle:()=>{},prepareSystemWallet:async()=>{},preparingInstall:false,gameOperation:undefined,requireBackend:()=>'/backend',safeProductId:(value:string)=>value,
  installPlans:{get:plan},installSelection:()=> 'content',contentParentForChoice:()=>undefined,prepareContentInstall:vi.fn(async()=> 'content-id'),assertInstallDestination:async(value:string)=>value,app:{getPath:()=>'/synthetic/user'},randomUUID:()=> 'queued-id',
  downloadCleanup:{prepare,inheritResume:async()=>{}},enrichDownloadCovers:async()=>{},installQueue:{enqueue:(job:any)=>jobs.push(job)},emitSnapshot:()=>{},shutdownStarted:false,runDownload:run,
  downloadCancellations:new Set(),downloadControls:new Map(),operations:new Map(),structuredClone,
  ipcMain:{handle:(name:string,fn:Function)=>handlers.set(name,fn)}};
 runInNewContext(code,context);
 return {context,handlers,jobs,downloads,plan,run,prepare,revoke:()=>{granted=false;},request:{source:'store',productId:id,title:'Synthetic',destination:'/synthetic/game'}};
}
it('denied Store offer never reaches package preparation or queue/backend',async()=>{
 const f=fixture();f.revoke();await expect(f.context.install(f.request)).rejects.toThrow('No current verified access');
 expect(f.plan).not.toHaveBeenCalled();expect(f.jobs).toHaveLength(0);expect(f.run).not.toHaveBeenCalled();expect(f.prepare).not.toHaveBeenCalled();
});
it('rechecks revoked access in the actual queued closure before backend or download cleanup',async()=>{
 const f=fixture();await f.context.install(f.request);expect(f.jobs).toHaveLength(1);expect(f.downloads[0].source).toBe('store');
 f.revoke();await expect(f.jobs[0].run()).rejects.toThrow('No current verified access');expect(f.run).not.toHaveBeenCalled();expect(f.prepare).not.toHaveBeenCalled();
});
it('retains the Store guard through actual saved-download resume IPC',async()=>{
 const f=fixture();f.downloads.push({...f.request,id:'paused',status:'paused'});f.revoke();
 await expect(f.handlers.get('resume-download')!({},'paused')).rejects.toThrow('No current verified access');
 expect(f.downloads[0].status).toBe('paused');expect(f.plan).not.toHaveBeenCalled();expect(f.jobs).toHaveLength(0);expect(f.run).not.toHaveBeenCalled();
});
it('still queues and starts a currently verified Store offer',async()=>{
 const f=fixture();await f.context.install(f.request);await f.jobs[0].run();expect(f.prepare).toHaveBeenCalledOnce();expect(f.run).toHaveBeenCalledOnce();
});

it('does not lose Store offer provenance through the installed-content redirect',async()=>{
 const f=fixture();f.context.contentParentForChoice=()=> 'installed-parent';
 await expect(f.context.install(f.request)).rejects.toThrow('Manage content');
 expect(f.context.prepareContentInstall).not.toHaveBeenCalled();expect(f.jobs).toHaveLength(0);expect(f.run).not.toHaveBeenCalled();
 // Existing Library/manual related-content routing remains available.
 await expect(f.context.install({...f.request,source:undefined})).resolves.toBe('content-id');expect(f.context.prepareContentInstall).toHaveBeenCalledOnce();
});
