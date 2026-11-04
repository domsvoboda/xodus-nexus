import {describe,it,expect,vi} from 'vitest';
import {promises as fs,readFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {transpileModule,ScriptTarget} from 'typescript';
import type {Game} from '../shared/types.js';
import {inspectStartupLibrary} from './startup-library.js';
import {StateStore,inspectGameDirectory} from './store.js';
import {hasIncompleteUpdate,INCOMPLETE_UPDATE_MARKER,INCOMPLETE_UPDATE_MESSAGE} from './installation-state.js';
function deferred<T=void>(){let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
const games=Array.from({length:6},(_,i)=>Object.freeze({id:String(i),path:'/synthetic/'+i,title:String(i)}) as Game);
describe('bounded startup inspection',()=>{
 it('limits outstanding reads and preserves input order through out-of-order failures',async()=>{
  const gates=games.map(()=>deferred<Game>()),started=games.map(()=>deferred()),finished=games.map(()=>deferred());let active=0,peak=0,settled=false;
  const inspect=vi.fn(async(directory:string)=>{const i=games.findIndex(g=>g.path===directory);active++;peak=Math.max(peak,active);started[i].resolve();try{return await gates[i].promise;}finally{active--;finished[i].resolve();}});
  const pending=inspectStartupLibrary(games,inspect).then(value=>{settled=true;return value;});
  expect(inspect).toHaveBeenCalledTimes(4);expect(active).toBe(4);
  gates[3].resolve(games[3]);await started[4].promise;expect(active).toBe(4);
  gates[1].reject(Error('Unavailable synthetic root'));await started[5].promise;expect(peak).toBe(4);
  for(const i of [0,2,4])gates[i].resolve(games[i]);
  await Promise.all(finished.slice(0,5).map(g=>g.promise));expect(settled).toBe(false);
  gates[5].resolve(games[5]);const outcomes=await pending;
  expect(outcomes.map(row=>row.game.id)).toEqual(games.map(g=>g.id));expect(outcomes[1].inspected).toBeUndefined();
  expect(outcomes.filter(row=>row.inspected).map(row=>row.inspected!.id)).toEqual(['0','2','3','4','5']);expect(active).toBe(0);
 });
 it('does not start a reader for an empty library',async()=>{const inspect=vi.fn();expect(await inspectStartupLibrary([],inspect)).toEqual([]);expect(inspect).not.toHaveBeenCalled();});
});
it('actual startup waits for reads then preserves unavailable entries and durable update barriers',async()=>{
 const root=await fs.mkdtemp(path.join(process.env.TMPDIR??os.tmpdir(),'startup-library-'));
 const held=deferred();let pending:Promise<void>|undefined;
 try{
  const store=new StateStore(path.join(root,'state'));
  for(let i=0;i<4;i++){
   const folder=path.join(root,'game-'+i);await fs.mkdir(folder);
   await fs.writeFile(path.join(folder,'MicrosoftGame.config'),`<Game><ExecutableList><Executable Name="Game.exe"/></ExecutableList><ShellVisuals DefaultDisplayName="Fixture ${i}"/></Game>`);
   await fs.writeFile(path.join(folder,'Game.exe'),'MZ synthetic inert file');await fs.writeFile(path.join(folder,'.xodus-streaming.msixvc'),'synthetic marker');await store.upsertGame(await inspectGameDirectory(folder));
  }
  const [a,b,c,d]=store.games;await fs.unlink(path.join(b.path,'MicrosoftGame.config'));await fs.writeFile(path.join(b.path,INCOMPLETE_UPDATE_MARKER),'interrupted');
  await store.patchGame(c.id,{installState:'incomplete',updateIncomplete:true});await fs.rm(c.path,{recursive:true});await fs.writeFile(path.join(d.path,INCOMPLETE_UPDATE_MARKER),'interrupted');
  const before=structuredClone(store.games),patch=vi.spyOn(store,'patchGames'),fallback=vi.spyOn(store,'patchGame'),others=deferred();let completed=0;
  const inspect=async(directory:string)=>{if(directory===a.path)await held.promise;try{return await inspectGameDirectory(directory);}finally{if(directory!==a.path&&++completed===3)others.resolve();}};
  const source=readFileSync(new URL('./index.ts',import.meta.url),'utf8');
  const refresh=source.slice(source.indexOf('async function refreshIncompleteUpdate('),source.indexOf('\nfunction emitSnapshot()'));
  const start=source.indexOf('  const inspectedGames:');const body=source.slice(start,source.indexOf('  runtime = new RuntimeManager(',start));
  const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  const run=new AsyncFunction('store','inspectGameDirectory','inspectStartupLibrary','hasIncompleteUpdate','INCOMPLETE_UPDATE_MESSAGE',transpileModule(refresh+'\n'+body,{compilerOptions:{target:ScriptTarget.ES2022}}).outputText);
  pending=run(store,inspect,inspectStartupLibrary,hasIncompleteUpdate,INCOMPLETE_UPDATE_MESSAGE);await others.promise;
  expect(patch).not.toHaveBeenCalled();expect(fallback).not.toHaveBeenCalled();expect(store.games).toEqual(before);
  held.resolve();await pending;
  expect(fallback).toHaveBeenCalledTimes(1);expect(fallback.mock.calls[0][0]).toBe(b.id);expect(patch).toHaveBeenCalledTimes(1);
  expect(patch.mock.calls[0][0].map(row=>row.id)).toEqual([a.id,d.id]);expect(fallback.mock.invocationCallOrder[0]).toBeLessThan(patch.mock.invocationCallOrder[0]);
  const reloaded=new StateStore(path.join(root,'state'));await reloaded.load();expect(reloaded.games.map(g=>g.id)).toEqual([a,b,c,d].map(g=>g.id));
  expect(reloaded.games.map(g=>Boolean(g.updateIncomplete))).toEqual([false,true,true,true]);expect(reloaded.games.map(g=>g.installState)).toEqual(['ready','incomplete','incomplete','incomplete']);
 }finally{held.resolve();await pending?.catch(()=>{});vi.restoreAllMocks();await fs.rm(root,{recursive:true,force:true});}
});
