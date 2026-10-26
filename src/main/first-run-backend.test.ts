import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {transpileModule,ScriptTarget} from 'typescript';
const source=readFileSync('src/main/index.ts','utf8');
const start=source.indexOf('async function prepareFirstRunBackend()');
const code=transpileModule(source.slice(start,source.indexOf('\nasync function createWindow()',start)),{compilerOptions:{target:ScriptTarget.ES2022}}).outputText;
function fixture(){
 const context=createContext({shutdownStarted:false,store:{settings:{firstRunCompleted:false}},backend:{current:{available:false,updating:false,releaseAvailable:true,updateAvailable:true},checkUpdate:vi.fn(async()=>{}),update:vi.fn(async()=>{})},mainWindow:{isVisible:()=>true},refreshInitialAccount:vi.fn(async()=>{}),emitSnapshot:vi.fn()});
 return{context,run:()=>runInContext(code+'\nprepareFirstRunBackend()',context) as Promise<void>};
}
it('automatically uses the verified installer on first run and only then checks the account',async()=>{
 const {context,run}=fixture(),events:string[]=[];
 context.backend.checkUpdate.mockImplementation(async()=>{events.push('discover');});
 context.backend.update.mockImplementation(async()=>{events.push('verified-install');context.backend.current.available=true;});
 context.refreshInitialAccount.mockImplementation(async()=>{events.push('account');});
 await run();expect(events).toEqual(['discover','verified-install','account']);
 expect(context.backend.update).toHaveBeenCalledWith(context.emitSnapshot);
});
it.each(['completed','available','updating','no-release','no-update','shutdown'])('does not auto-install for %s',async reason=>{
 const {context,run}=fixture();
 if(reason==='completed')context.store.settings.firstRunCompleted=true;
 if(reason==='available')context.backend.current.available=true;
 if(reason==='updating')context.backend.current.updating=true;
 if(reason==='no-release')context.backend.current.releaseAvailable=false;
 if(reason==='no-update')context.backend.current.updateAvailable=false;
 if(reason==='shutdown')context.shutdownStarted=true;
 await run();expect(context.backend.update).not.toHaveBeenCalled();expect(context.refreshInitialAccount).not.toHaveBeenCalled();
});
it('rechecks first-run state after slow discovery rather than installing after the wizard closes',async()=>{
 const {context,run}=fixture();context.backend.checkUpdate.mockImplementation(async()=>{context.store.settings.firstRunCompleted=true;});
 await run();expect(context.backend.update).not.toHaveBeenCalled();
});
it('keeps installation errors visible without starting sign-in or retry loops',async()=>{
 const {context,run}=fixture();context.backend.update.mockRejectedValue(Error('synthetic checksum failure'));
 await run();expect(context.backend.update).toHaveBeenCalledOnce();expect(context.refreshInitialAccount).not.toHaveBeenCalled();expect(context.emitSnapshot).toHaveBeenCalledTimes(2);
});
it('does not open an account flow in a hidden launcher after installation',async()=>{
 const {context,run}=fixture();context.mainWindow.isVisible=()=>false;await run();expect(context.backend.update).toHaveBeenCalledOnce();expect(context.refreshInitialAccount).not.toHaveBeenCalled();
});
