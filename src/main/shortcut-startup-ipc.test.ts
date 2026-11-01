import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {ScriptTarget,transpileModule} from 'typescript';
import {expect,it,vi} from 'vitest';

const source=readFileSync('src/main/index.ts','utf8');
const start=source.indexOf('  // No external toggle socket');
const block=source.slice(start,source.indexOf("  app.on('activate'",start));
const script=transpileModule('(async()=>{'+block+'})()',{compilerOptions:{target:ScriptTarget.ES2022}}).outputText;
it('keeps startup alive through wallet and party-reset callbacks, then flushes queued shortcuts',async()=>{
  const launches:string[]=[],quit=vi.fn();
  const context:any={launchReady:false,startupRequest:{gameId:'first'},pendingRequests:[{gameId:'second'}],pendingShortcutErrors:[],
    prepareSystemWallet:async()=>{if(context.launchReady)quit();},
    refreshAccount:async()=>{if(context.launchReady)quit();},
    receiveLaunchRequest:(request:{gameId:string})=>{expect(context.launchReady).toBe(true);launches.push(request.gameId);},shortcutError:vi.fn()};
  await runInNewContext(script,context);
  expect(quit).not.toHaveBeenCalled();expect(launches).toEqual(['first','second']);
});
it('makes a normal window ready before scheduling its visible account check',async()=>{
  const showLauncher=vi.fn(),context:any={launchReady:false,startupRequest:{},pendingRequests:[],pendingShortcutErrors:[],showLauncher,
    showBeforeAccountCheck:async(show:()=>void)=>{expect(context.launchReady).toBe(true);show();},refreshInitialAccount:vi.fn()};
  await runInNewContext(script,context);expect(showLauncher).toHaveBeenCalledOnce();
});

it('a Steam secondary exits without touching primary-only services or game cleanup',()=>{
  const quitSource=source.slice(source.indexOf("app.on('before-quit', (event) => {"));
  const quitScript=transpileModule(quitSource,{compilerOptions:{target:ScriptTarget.ES2022}}).outputText;
  const event={preventDefault:vi.fn()};
  runInNewContext(quitScript,{primaryInstance:false,app:{on:(_name:string,callback:(event:unknown)=>void)=>callback(event)}});
  expect(event.preventDefault).not.toHaveBeenCalled();
});
