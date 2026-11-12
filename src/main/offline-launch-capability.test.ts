import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {expect,it,vi} from 'vitest';
import {selectedWinePath} from './xodus-service.js';

// Extract the real capability probe from index.ts so this exercises the actual
// source, not a stubbed offlineLaunchSupported.
const source=readFileSync(new URL('./index.ts',import.meta.url),'utf8');
const parsed=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true);
const declaration=parsed.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='offlineLaunchSupported');
if(!declaration)throw Error('Could not locate offlineLaunchSupported');
const code=ts.transpileModule(declaration.getText(parsed)+'\nglobalThis.probe=offlineLaunchSupported;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;

type Family={winePath:string};
function fixture(options:{
  configuredWine?:string;activeWine?:string;runtimeRoot?:string;
  capabilities?:Partial<{licenseCache:boolean;offlineLaunch:boolean}>;
  families?:Partial<Record<'nexus'|'nexus-cachyos',Family|Error>>;
  compatible?:string[];
}={}){
  const calls:string[]=[],compatible=new Set(options.compatible??[]);
  const store={settings:{winePath:options.configuredWine??'',runtimeRoot:options.runtimeRoot??'/managed'}};
  const runtime={current:{winePath:options.activeWine}};
  const backend={current:{capabilities:{licenseCache:true,offlineLaunch:true,...options.capabilities}}};
  const before=JSON.stringify({settings:store.settings,active:runtime.current});
  const resolveRuntimeFamily=vi.fn(async(root:string,id:'nexus'|'nexus-cachyos')=>{
    calls.push(`family:${id}:${root}`);
    const value=options.families?.[id];
    if(value instanceof Error)throw value;
    if(!value)throw Error('not installed');
    return {...value,id};
  });
  const offlineIdentityRuntime=vi.fn(async(wine:string)=>{calls.push(`identity:${wine}`);return compatible.has(wine);});
  const context:any={backend,store,runtime,selectedWinePath,resolveRuntimeFamily,offlineIdentityRuntime};
  runInNewContext(code,context);
  return {calls,store,runtime,resolveRuntimeFamily,offlineIdentityRuntime,before,probe:()=>context.probe() as Promise<boolean>};
}

it('reports a verified fresh Standard family as a device capability and prefers it over CachyOS',async()=>{
  const f=fixture({families:{nexus:{winePath:'/managed/nexus/files/bin/wine'},'nexus-cachyos':{winePath:'/managed/cachyos/files/bin/wine'}},compatible:['/managed/nexus/files/bin/wine','/managed/cachyos/files/bin/wine']});
  await expect(f.probe()).resolves.toBe(true);
  expect(f.calls).toEqual(['family:nexus:/managed','identity:/managed/nexus/files/bin/wine']);
  expect(JSON.stringify({settings:f.store.settings,active:f.runtime.current})).toBe(f.before);
});

it('accepts a verified CachyOS-only install as a device capability without changing the default selection',async()=>{
  const f=fixture({families:{nexus:Error('missing or corrupt'),'nexus-cachyos':{winePath:'/managed/cachyos/files/bin/wine'}},compatible:['/managed/cachyos/files/bin/wine']});
  await expect(f.probe()).resolves.toBe(true);
  expect(f.calls).toEqual(['family:nexus:/managed','family:nexus-cachyos:/managed','identity:/managed/cachyos/files/bin/wine']);
  expect(f.store.settings.winePath).toBe('');
  expect(f.runtime.current.winePath).toBeUndefined();
  expect(JSON.stringify({settings:f.store.settings,active:f.runtime.current})).toBe(f.before);
});

it('continues past a verified Standard family without the v2 feature so a verified CachyOS family can qualify',async()=>{
  const f=fixture({families:{nexus:{winePath:'/managed/nexus/files/bin/wine'},'nexus-cachyos':{winePath:'/managed/cachyos/files/bin/wine'}},compatible:['/managed/cachyos/files/bin/wine']});
  await expect(f.probe()).resolves.toBe(true);
  expect(f.calls).toEqual(['family:nexus:/managed','identity:/managed/nexus/files/bin/wine','family:nexus-cachyos:/managed','identity:/managed/cachyos/files/bin/wine']);
});

it('rejects two verified managed families whose metadata both lack the feature',async()=>{
  const f=fixture({families:{nexus:{winePath:'/managed/nexus/files/bin/wine'},'nexus-cachyos':{winePath:'/managed/cachyos/files/bin/wine'}},compatible:[]});
  await expect(f.probe()).resolves.toBe(false);
  expect(f.offlineIdentityRuntime).toHaveBeenCalledTimes(2);
  expect(f.calls).toEqual(['family:nexus:/managed','identity:/managed/nexus/files/bin/wine','family:nexus-cachyos:/managed','identity:/managed/cachyos/files/bin/wine']);
});

it('fails closed when both managed families are missing or corrupt',async()=>{
  const f=fixture({families:{nexus:Error('missing'),'nexus-cachyos':Error('corrupt')}});
  await expect(f.probe()).resolves.toBe(false);
  expect(f.offlineIdentityRuntime).not.toHaveBeenCalled();
  expect(f.calls).toEqual(['family:nexus:/managed','family:nexus-cachyos:/managed']);
});

it.each([
  {name:'configured',configuredWine:'/configured/wine',activeWine:'/active/wine'},
  {name:'legacy active',configuredWine:'',activeWine:'/active/wine'},
])('keeps the $name runner precedence and never falls back to a managed family when it lacks the feature',async({configuredWine,activeWine})=>{
  const f=fixture({configuredWine,activeWine,families:{nexus:{winePath:'/managed/nexus/files/bin/wine'}},compatible:['/managed/nexus/files/bin/wine']});
  const expected=selectedWinePath(configuredWine,'/managed',activeWine)!;
  await expect(f.probe()).resolves.toBe(false);
  expect(f.offlineIdentityRuntime).toHaveBeenCalledOnce();
  expect(f.offlineIdentityRuntime).toHaveBeenCalledWith(expected);
  expect(f.resolveRuntimeFamily).not.toHaveBeenCalled();
});

it.each([
  {name:'configured',configuredWine:'/configured/wine',activeWine:'/active/wine'},
  {name:'legacy active',configuredWine:'',activeWine:'/active/wine'},
])('accepts a compatible $name runner without probing any managed family',async({configuredWine,activeWine})=>{
  const expected=selectedWinePath(configuredWine,'/managed',activeWine)!;
  const f=fixture({configuredWine,activeWine,families:{nexus:{winePath:'/managed/nexus/files/bin/wine'}},compatible:[expected]});
  await expect(f.probe()).resolves.toBe(true);
  expect(f.offlineIdentityRuntime).toHaveBeenCalledOnce();
  expect(f.offlineIdentityRuntime).toHaveBeenCalledWith(expected);
  expect(f.resolveRuntimeFamily).not.toHaveBeenCalled();
});

it.each([{licenseCache:false},{offlineLaunch:false}])('fails without any family filesystem probe when a backend capability is absent: %j',async(capabilities)=>{
  const f=fixture({capabilities,families:{nexus:{winePath:'/managed/nexus/files/bin/wine'}},compatible:['/managed/nexus/files/bin/wine']});
  await expect(f.probe()).resolves.toBe(false);
  expect(f.resolveRuntimeFamily).not.toHaveBeenCalled();
  expect(f.offlineIdentityRuntime).not.toHaveBeenCalled();
  expect(f.calls).toEqual([]);
});
