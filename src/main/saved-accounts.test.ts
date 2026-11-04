import { expect, it, vi } from 'vitest';
const h=vi.hoisted(()=>({results:[] as (()=>Promise<{code:number;output:string}>)[],calls:[] as string[][]}));
vi.mock('./process.js',()=>({spawnTracked:(_binary:string,args:string[])=>{h.calls.push(args);return {child:{stdin:{end:vi.fn()},kill:vi.fn()},result:h.results.shift()!()};}}));
import {enableSavedAccounts} from './saved-accounts';
it.each(['before','after','unknown'])('reconciles retention enable failure %s commit without claiming an unchanged vault',async mode=>{
 h.calls=[];h.results=[async()=>{throw Error('synthetic timeout');},async()=>mode==='unknown'?{code:1,output:''}:{code:0,output:JSON.stringify({accounts:[],enabled:mode==='after'})}];
 if(mode==='after')await enableSavedAccounts('/synthetic/cli');
 else await expect(enableSavedAccounts('/synthetic/cli')).rejects.toThrow(mode==='before'?'was not enabled':'could not be verified');
 expect(h.calls).toEqual([['saved-accounts','--enable','--json'],['saved-accounts','--json']]);
});
