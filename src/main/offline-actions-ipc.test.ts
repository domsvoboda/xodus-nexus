import {readFileSync} from 'node:fs';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {expect,it,vi} from 'vitest';

const source=readFileSync(new URL('./index.ts',import.meta.url),'utf8');
const parsed=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true);
const names=new Set(['requireBackend','ensureIdle','offlineDataRoot','assertOfflineScope']);
const functions=parsed.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name&&names.has(node.name.text)).map(node=>node.getText(parsed)).join('\n');
const start=source.indexOf("  ipcMain.handle('offline-permissions'",source.indexOf('function registerIpc():'));
const routes=source.slice(start,source.indexOf("  ipcMain.handle('catalog-search'",start));
const code=ts.transpileModule('let offlinePermissionChanging=false;\n'+functions+'\n'+routes+'\nglobalThis.checkIdle=ensureIdle;', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function deferred<T>() { let resolve!:(value:T)=>void; return {promise:new Promise<T>(done=>resolve=done),resolve:(value:T)=>resolve(value)}; }
function fixture(){
  const handlers=new Map<string,Function>();
  const authState={stored:true,running:false,username:'first'},backend={current:{available:true,binaryPath:'/fixture/cli',capabilities:{offlinePc:true},updating:false}};
  const store={settings:{runtimeRoot:'/fixture/data/runtimes'},downloads:[]};
  const status={enabled:true,requestSuccess:true};
  const read=vi.fn(async()=>status),change=vi.fn(async()=>status),settle=vi.fn(async(value:unknown)=>value),wallet=vi.fn(async()=>{});
  const context:any={path,ipcMain:{handle:(name:string,fn:Function)=>handlers.set(name,fn)},authState,backend,store,
    shutdownStarted:false,keyringSupport:{busy:false},downloadCancellations:new Set(),preparingInstall:false,preparingContent:false,preparingLaunch:false,finalizingGame:false,
    launcherUpdater:{state:{updating:false}},checkingGameUpdates:false,gameRemovalInProgress:false,assertActivityCompatible:vi.fn(),operations:new Map(),gameOperation:undefined,installQueue:{size:0},runtime:{current:{updating:false}},
    accountRefresh:{invalidate:vi.fn()},prepareSystemWallet:wallet,offlineLaunchSupported:async()=>true,offlineLicenseCache:async()=>'/fixture/cache',backendRunner:(binary:string)=>binary,readOfflinePermissions:read,changeOfflinePermissions:change,settleOfflinePermissions:settle};
  runInNewContext(code,context);
  return {authState,backend,store,read,change,settle,wallet,status,checkIdle:()=>context.checkIdle(),call:(name:string,...args:unknown[])=>handlers.get(name)!(undefined,...args)};
}
it('refuses signed-out and malformed requests before touching credentials or the service',async()=>{
  const f=fixture();f.authState.stored=false;
  await expect(f.call('offline-permissions')).rejects.toThrow('Sign in');
  await expect(f.call('set-offline-permissions',true)).rejects.toThrow('Sign in');
  f.authState.stored=true;
  await expect(f.call('set-offline-permissions','true')).rejects.toThrow('Invalid');
  expect(f.wallet).not.toHaveBeenCalled();expect(f.change).not.toHaveBeenCalled();expect(f.read).not.toHaveBeenCalled();
});
it.each(['account','backend','root'])('never applies a late read to a different %s',async kind=>{
  const f=fixture(),pending=deferred<typeof f.status>();f.read.mockReturnValueOnce(pending.promise);
  const result=f.call('offline-permissions');await vi.waitFor(()=>expect(f.read).toHaveBeenCalledOnce());
  if(kind==='account')f.authState.username='second';else if(kind==='backend')f.backend.current.binaryPath='/other/cli';else f.store.settings.runtimeRoot='/other/data/runtimes';
  pending.resolve(f.status);await expect(result).rejects.toThrow('Account changed');expect(f.settle).not.toHaveBeenCalled();
});
it('rechecks identity after the wallet before changing Microsoft designation',async()=>{
  const f=fixture(),wallet=deferred<void>();f.wallet.mockReturnValueOnce(wallet.promise);
  const result=f.call('set-offline-permissions',true);f.authState.username='second';wallet.resolve();
  await expect(result).rejects.toThrow('Account changed');expect(f.change).not.toHaveBeenCalled();expect(()=>f.checkIdle()).not.toThrow();
});
it('serializes changes against launches and sign-out until revocation cleanup is finished',async()=>{
  const f=fixture(),request=deferred<typeof f.status>(),cleanup=deferred<any>();f.change.mockReturnValueOnce(request.promise);f.settle.mockReturnValueOnce(cleanup.promise);
  const result=f.call('set-offline-permissions',false);await vi.waitFor(()=>expect(f.change).toHaveBeenCalledOnce());
  await expect(f.call('set-offline-permissions',true)).rejects.toThrow('offline-permission change');
  expect(()=>f.checkIdle()).toThrow('offline-permission change');
  request.resolve(f.status);await vi.waitFor(()=>expect(f.settle).toHaveBeenCalledWith(f.status,true));
  expect(()=>f.checkIdle()).toThrow('offline-permission change');
  cleanup.resolve(f.status);await result;expect(()=>f.checkIdle()).not.toThrow();
});
it('a refused server mutation releases the guard without pretending the designation changed',async()=>{
  const f=fixture();f.change.mockRejectedValueOnce(Error('refused'));
  await expect(f.call('set-offline-permissions',true)).rejects.toThrow('refused');
  expect(f.settle).not.toHaveBeenCalled();expect(()=>f.checkIdle()).not.toThrow();
});

it('cache recovery keeps its original data root across asynchronous filesystem checks',async()=>{
  const helper=parsed.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name&&['offlineDataRoot','offlineLicenseCache'].includes(node.name.text)).map(node=>node.getText(parsed)).join('\n');
  const check=deferred<boolean>(),store={settings:{runtimeRoot:'/original/runtimes'}};
  const revoke=vi.fn(async()=>{}),ready=vi.fn(async()=>{});
  const context:any={path,store,backend:{current:{capabilities:{licenseCache:true}}},offlineAccessRevoked:()=>check.promise,revokeOfflineAccess:revoke,assertOfflineAccessReady:ready,licenseCacheDirectory:(root:string)=>path.join(root,'license-cache')};
  runInNewContext(ts.transpileModule(helper+'\nglobalThis.recover=offlineLicenseCache;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  const pending=context.recover();store.settings.runtimeRoot='/different/runtimes';check.resolve(true);
  await expect(pending).resolves.toBe('/original/license-cache');
  expect(revoke).toHaveBeenCalledOnce();expect(revoke).toHaveBeenCalledWith('/original');
  expect(ready).toHaveBeenCalledOnce();expect(ready).toHaveBeenCalledWith('/original');
});
