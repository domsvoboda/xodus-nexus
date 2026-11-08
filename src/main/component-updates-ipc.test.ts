import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { ComponentUpdateAdmission } from './component-update-admission.js';
import { assertActivityCompatible } from './install-queue.js';
const source=readFileSync(new URL('./index.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('index.ts',source,ts.ScriptTarget.ES2022,true);
const names=new Set(['ensureIdle','ensureActivityIdle','componentActivityRunning','prepareFirstRunBackend']);
const functions=ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name&&names.has(node.name.text)).map(node=>node.getText(ast)).join('\n');
const register=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='registerIpc') as ts.FunctionDeclaration;
const routes=new Set(['backend-update','runtime-family-install','install-launcher-update','rollback-launcher-update','restart-launcher']);
const handlerSource=register.body!.statements.filter(node=>ts.isExpressionStatement(node)&&ts.isCallExpression(node.expression)&&node.expression.expression.getText(ast)==='ipcMain.handle'&&ts.isStringLiteral(node.expression.arguments[0])&&routes.has(node.expression.arguments[0].text)).map(node=>node.getText(ast)).join('\n');
const activityExpressions:string[]=[];let contextExpression='';
function collect(node:ts.Node):void{if(ts.isNewExpression(node)){const name=node.expression.getText(ast);if(name==='RuntimeManager')activityExpressions.push(node.arguments![2].getText(ast));if(name==='BackendManager')activityExpressions.push(node.arguments![3].getText(ast));if(name==='ComponentUpdates')contextExpression=node.arguments![4].getText(ast);}ts.forEachChild(node,collect);}collect(ast);
function fixture(){
 const handlers=new Map<string,Function>();
 const ctx:any={componentUpdates:undefined,authState:{running:false},authJob:undefined,offlinePermissionChanging:false,keyringSupport:{busy:false},shutdownStarted:false,downloadCancellations:new Set(),preparingInstall:false,preparingContent:false,preparingLaunch:false,finalizingGame:false,checkingGameUpdates:false,gameRemovalInProgress:false,gameOperation:undefined,operations:new Map(),installQueue:{size:0},store:{settings:{firstRunCompleted:false},downloads:[]},assertActivityCompatible,
 backend:{current:{available:false,updating:false,releaseAvailable:true,updateAvailable:true},update:vi.fn(async()=>{}),checkUpdate:vi.fn(async()=>{})},runtime:{busy:false,current:{updating:false},installManagedRuntime:vi.fn(async()=>{})},launcherUpdater:{busy:false,state:{restartRequired:true},targetPath:'/synthetic/AppImage',install:vi.fn(async()=>{}),rollback:vi.fn(async()=>{}),assertRestartReady:vi.fn(async()=>{})},
 emitSnapshot:vi.fn(),refreshAccount:vi.fn(async()=>{}),refreshInitialAccount:vi.fn(async()=>{}),backendDiagnostic:vi.fn(),mainWindow:{isVisible:()=>false},app:{relaunch:vi.fn(),quit:vi.fn()},externalLauncherEnvironment:()=>({}),process:{env:{}},ipcMain:{handle:(name:string,fn:Function)=>handlers.set(name,fn)}};
 runInNewContext(ts.transpileModule(functions+'\n'+handlerSource,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
 ctx.componentUpdateAdmission=new ComponentUpdateAdmission(()=>ctx.ensureActivityIdle());
 const activity=activityExpressions.map(expression=>runInNewContext('('+expression+')',ctx) as ()=>boolean);
 return {ctx,handlers,activity,gate:ctx.componentUpdateAdmission as ComponentUpdateAdmission};
}
describe('actual main component admission',()=>{
 it('does not register the removed public backend rebuild route',()=>{
  expect(source).not.toContain('backend-rebuild');
 });
 it.each(['backend-update','runtime-family-install','install-launcher-update','rollback-launcher-update','restart-launcher'])('blocks %s while a batch holds ownership',async name=>{
  const {ctx,handlers,gate}=fixture(),owner=gate.reserve();await expect(Promise.resolve().then(()=>handlers.get(name)!({},'nexus','sha',{}))).rejects.toThrow('Component updates');
  expect(ctx.backend.update).not.toHaveBeenCalled();expect(ctx.runtime.installManagedRuntime).not.toHaveBeenCalled();expect(ctx.launcherUpdater.install).not.toHaveBeenCalled();expect(ctx.app.relaunch).not.toHaveBeenCalled();gate.release(owner);
 });
 it.each(['preparingLaunch','finalizingGame','preparingInstall','preparingContent','offlinePermissionChanging','shutdownStarted'])('rejects batch and both manager activity callbacks for %s',flag=>{
  const {ctx,gate,activity}=fixture();ctx[flag]=true;expect(()=>gate.reserve()).toThrow();expect(ctx.componentActivityRunning()).toBe(true);expect(activity).toHaveLength(2);for(const callback of activity)expect(callback()).toBe(true);
 });
 it('rejects wallet/auth/launcher reservations but accepts completed or failed game operations',()=>{
  const {ctx,gate}=fixture();ctx.keyringSupport.busy=true;expect(()=>gate.reserve()).toThrow();ctx.keyringSupport.busy=false;ctx.authJob={};expect(()=>gate.reserve()).toThrow();ctx.authJob=undefined;ctx.launcherUpdater.busy=true;expect(()=>gate.reserve()).toThrow();ctx.launcherUpdater.busy=false;
  for(const status of ['complete','failed']){ctx.gameOperation={status};expect(ctx.componentActivityRunning()).toBe(false);const owner=gate.reserve();gate.release(owner);}
  for(const status of ['preparing','running','stopping']){ctx.gameOperation={status};expect(ctx.componentActivityRunning()).toBe(true);expect(()=>gate.reserve()).toThrow();}
 });
 it('binds actual status context to Store, player and stored state but not its own backend update',()=>{
  const {ctx}=fixture();ctx.store.settings.runtimeRoot='/root';ctx.store.settings.market='US';ctx.authState.username='store';ctx.authState.player='player';ctx.authState.stored=true;
  const context=runInNewContext('('+contextExpression+')',ctx) as ()=>string,before=context();ctx.backend.current.version='new';expect(context()).toBe(before);
  ctx.authState.player='other';expect(context()).not.toBe(before);ctx.authState.player='player';ctx.authState.stored=false;expect(context()).not.toBe(before);
 });
 it('allows a verified pending launcher restart despite an unrelated failed backend result',async()=>{
  const {ctx,handlers}=fixture();ctx.componentUpdates={current:{result:{items:[{id:'backend',outcome:'failed-before-commit'}]}}};await handlers.get('restart-launcher')!({});expect(ctx.launcherUpdater.assertRestartReady).toHaveBeenCalledOnce();expect(ctx.app.relaunch).toHaveBeenCalledOnce();
 });
 it('rechecks batch admission after first-run backend discovery finishes',async()=>{
  const {ctx,gate}=fixture();let release!:()=>void;ctx.backend.checkUpdate.mockImplementation(()=>new Promise<void>(r=>release=r));const pending=ctx.prepareFirstRunBackend();const owner=gate.reserve();release();await pending;expect(ctx.backend.update).not.toHaveBeenCalled();gate.release(owner);
 });
});
