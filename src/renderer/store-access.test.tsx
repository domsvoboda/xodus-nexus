// @vitest-environment jsdom
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
import {CatalogGameDetails} from './CatalogGameDetails';
import {PackageInstallProvider,confirmedPackageInstall} from './PackageInstall';
import {demoSnapshot} from '../shared/demo-data';
import {freshStoreAccess,storeProductLicensed,useStoreAccess,type StoreAccessEvidence} from './store-access';
vi.mock('./GameDetails',()=>({GameDetails:({play,notices}:{play:React.ReactNode;notices:React.ReactNode})=><main>{play}{notices}</main>}));
const product={productId:'9AAAAAAAAAAA',installProductId:'9BBBBBBBBBBB',title:'Retail edition',description:'',categories:[],installability:'supported' as const,supportNote:'Supported',includedWith:'Game Pass Ultimate'};
const planWith=(choice:Record<string,unknown>)=>({schema:1,rootProductId:product.productId,market:'US',status:'ready',choices:[{productId:product.productId,contentId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',title:product.title,platform:'Windows.Desktop',packageFormat:'MSIXVC',kind:'Game',supported:true,...choice}]});
const evidence=(data=demoSnapshot()):StoreAccessEvidence=>({account:data.auth.username!,backend:data.backend.binaryPath!,market:'US',configuredMarket:data.settings.market,checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString(),accessByProductId:{[product.productId]:'owned'}});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
it('accepts exact owned/Game Pass Store evidence and rejects marketing, other, stale, expired and wrong scope',()=>{
 const data=demoSnapshot(),value=evidence(data);expect(storeProductLicensed(value,data,product)).toBe(true);
 value.accessByProductId[product.productId]='gamepass';expect(storeProductLicensed(value,data,product)).toBe(true);
 value.accessByProductId[product.productId]='other';expect(storeProductLicensed(value,data,product)).toBe(false);
 delete value.accessByProductId[product.productId];value.accessByProductId[product.installProductId]='owned';expect(storeProductLicensed(value,data,product)).toBe(false);
 for(const patch of [{account:'another-store'},{backend:'/other'},{configuredMarket:'CZ'},{expiresAt:new Date(Date.now()-1).toISOString()},{checkedAt:'bad'}])expect(freshStoreAccess({...evidence(data),...patch},data)).toBe(false);
 data.auth.player='another-player';expect(storeProductLicensed(evidence(data),data,product)).toBe(true);
 data.auth.running=true;expect(storeProductLicensed(evidence(data),data,product)).toBe(false);data.auth.running=false;data.auth.stored=false;expect(storeProductLicensed(value,data,product)).toBe(false);
});
it('hides Install and location while access is pending/error, shows verified access and clears it on Store switch',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const data=demoSnapshot();data.games=[];data.downloads=[];
 let resolve!:(value:StoreAccessEvidence)=>void;
 const read=vi.fn(()=>new Promise<StoreAccessEvidence>(done=>resolve=done));
 window.launcher={getStoreAccess:read} as unknown as Window['launcher'];
 const node=document.createElement('div'),root=createRoot(node);
 const render=()=>act(async()=>root.render(<CatalogGameDetails storeMode product={product} data={data} back={()=>{}} toast={()=>{}}/>));
 try{
  await render();expect(node.textContent).toContain('Store page');expect(node.querySelector('input')).toBeNull();expect(node.querySelector('[data-gamepad-play]')).toBeNull();expect(node.textContent).not.toContain(product.supportNote);
  await act(async()=>resolve(evidence(data)));expect(node.querySelector('[data-gamepad-play]')?.textContent).toBe('Install');expect(node.querySelector('input')).not.toBeNull();expect(node.textContent).toContain(product.supportNote);
  data.auth={...data.auth,username:'different-store'};read.mockRejectedValueOnce(Error('unavailable'));await render();expect(node.querySelector('[data-gamepad-play]')).toBeNull();expect(node.querySelector('input')).toBeNull();
 }finally{await act(async()=>root.unmount());}
});
it('checks eligibility again after package resolution and after a held package choice',async()=>{
 const request={productId:product.productId,title:product.title,destination:'/synthetic/game',source:'store' as const};
 let eligible=true,resolve!:(value:any)=>void,choose!:(value:string)=>void;
 const api={getInstallPlan:vi.fn(()=>new Promise<any>(done=>resolve=done)),startInstall:vi.fn(async()=> 'queued')};
 const confirm=vi.fn(()=>new Promise<string>(done=>choose=done));
 const first=confirmedPackageInstall(request,api,confirm,()=>true,()=>eligible);eligible=false;resolve({status:'ready',market:'US'});await first;expect(confirm).not.toHaveBeenCalled();
 eligible=true;const second=confirmedPackageInstall(request,api,confirm,()=>true,()=>eligible);resolve({status:'ready',market:'US'});await vi.waitFor(()=>expect(confirm).toHaveBeenCalled());eligible=false;choose('synthetic');await second;expect(api.startInstall).not.toHaveBeenCalled();
});
it('keeps installed Play available without Store-license evidence',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const data=demoSnapshot();data.auth.stored=false;data.settings.winePath='/synthetic/wine';data.games=[{...data.games[0],storeId:product.productId,installState:'ready'}];data.downloads=[];
 window.launcher={launchGame:vi.fn(async()=>{})} as unknown as Window['launcher'];const node=document.createElement('div'),root=createRoot(node);
 try{await act(async()=>root.render(<PackageInstallProvider><CatalogGameDetails storeMode product={product} data={data} back={()=>{}} toast={()=>{}}/></PackageInstallProvider>));const play=node.querySelector<HTMLButtonElement>('[data-gamepad-play]')!;expect(play.textContent).toBe('Play');expect(play.disabled).toBe(false);await act(async()=>play.click());expect(window.launcher.launchGame).toHaveBeenCalledWith(data.games[0].id);expect(node.querySelector('input')).toBeNull();}finally{await act(async()=>root.unmount());}
});

it('expires an open installation form at the actual access boundary',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.useFakeTimers();
 const data=demoSnapshot();data.games=[];data.downloads=[];
 const value={...evidence(data),expiresAt:new Date(Date.now()+100).toISOString()};
 const read=vi.fn().mockResolvedValueOnce(value).mockRejectedValue(Error('expired'));
 window.launcher={getStoreAccess:read} as unknown as Window['launcher'];const node=document.createElement('div'),root=createRoot(node);
 try{await act(async()=>root.render(<CatalogGameDetails storeMode product={product} data={data} back={()=>{}} toast={()=>{}}/>));expect(node.querySelector('input')).not.toBeNull();await act(async()=>vi.advanceTimersByTimeAsync(101));expect(node.querySelector('input')).toBeNull();expect(node.querySelector('[data-gamepad-play]')).toBeNull();}finally{await act(async()=>root.unmount());vi.useRealTimers();}
});
it('keeps license scope independent of the player and rejects old callbacks after Store A to B to A',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const data=demoSnapshot();let access!:ReturnType<typeof useStoreAccess>;
 const read=vi.fn(async()=>evidence(data));window.launcher={getStoreAccess:read} as unknown as Window['launcher'];
 function Fixture(){access=useStoreAccess(data);return null;}
 const root=createRoot(document.createElement('div')),render=()=>act(async()=>root.render(<Fixture/>));
 try{await render();const old=access.canInstall;expect(old(product)).toBe(true);const store=data.auth.username;data.auth={...data.auth,player:'personal'};await render();expect(read).toHaveBeenCalledTimes(1);expect(access.canInstall(product)).toBe(true);
 data.auth={...data.auth,username:'store-B'};await render();data.auth={...data.auth,username:store};await render();expect(access.canInstall(product)).toBe(true);expect(old(product)).toBe(false);
 }finally{await act(async()=>root.unmount());}
});

it('invalidates a held package confirmation when its owning Store surface unmounts',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const data=demoSnapshot();let access!:ReturnType<typeof useStoreAccess>;
 window.launcher={getStoreAccess:vi.fn(async()=>evidence(data))} as unknown as Window['launcher'];
 function Fixture(){access=useStoreAccess(data);return null;}
 const root=createRoot(document.createElement('div'));await act(async()=>root.render(<Fixture/>));
 const guard=access.canInstall;expect(guard(product)).toBe(true);
 let choose!:(id:string)=>void;const confirm=vi.fn(()=>new Promise<string>(resolve=>choose=resolve));
 const api={getInstallPlan:vi.fn(async()=>({status:'ready',market:'US'} as any)),startInstall:vi.fn(async()=> 'queued')};
 const pending=confirmedPackageInstall({productId:product.productId,title:product.title,destination:'/synthetic'},api,confirm,()=>true,()=>guard(product));
 await vi.waitFor(()=>expect(confirm).toHaveBeenCalled());await act(async()=>root.unmount());expect(guard(product)).toBe(false);choose('synthetic');await pending;expect(api.startInstall).not.toHaveBeenCalled();
});

it('shows the package install size and never relabels download-only bytes as required space',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const data=demoSnapshot();data.games=[];data.downloads=[];data.backend.capabilities.packageSelection=true;
 const mount=async(value:ReturnType<typeof planWith>)=>{
  const getInstallPlan=vi.fn(async()=>value);
  window.launcher={getInstallPlan} as unknown as Window['launcher'];
  const node=document.createElement('div'),root=createRoot(node);
  await act(async()=>root.render(<CatalogGameDetails product={product} data={data} back={()=>{}} toast={()=>{}}/>));
  return {node,root,getInstallPlan};
 };
 let view=await mount(planWith({downloadBytes:2*1024**3,installBytes:4*1024**3}));
 try{
  await vi.waitFor(()=>expect(view.node.textContent).toContain('Estimated space: 4.0 GiB'));
  expect(view.getInstallPlan).toHaveBeenCalledWith(product.productId);
  expect(view.node.textContent).not.toContain('Estimated download: 2.0 GiB');
 }finally{await act(async()=>view.root.unmount());}
 view=await mount(planWith({downloadBytes:2*1024**3}));
 try{
  await vi.waitFor(()=>expect(view.node.textContent).toContain('Estimated download: 2.0 GiB'));
  expect(view.node.textContent).not.toContain('Estimated space: 2.0 GiB');
 }finally{await act(async()=>view.root.unmount());}
});

it('does not resolve package size for an unlicensed Store product',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const data=demoSnapshot();data.games=[];data.downloads=[];data.backend.capabilities.packageSelection=true;
 const getInstallPlan=vi.fn(async()=>planWith({downloadBytes:2*1024**3,installBytes:4*1024**3}));
 window.launcher={getStoreAccess:vi.fn(async()=>undefined),getInstallPlan} as unknown as Window['launcher'];
 const node=document.createElement('div'),root=createRoot(node);
 try{
  await act(async()=>root.render(<CatalogGameDetails storeMode product={product} data={data} back={()=>{}} toast={()=>{}}/>));
  await act(async()=>{await Promise.resolve();});
  expect(getInstallPlan).not.toHaveBeenCalled();
  expect(node.textContent).not.toContain('Estimated space');
 }finally{await act(async()=>root.unmount());}
});

it('ignores a package-size result after the account or backend scope changes',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const data=demoSnapshot();data.games=[];data.downloads=[];data.backend.capabilities.packageSelection=true;
 const pending:((value:ReturnType<typeof planWith>)=>void)[]=[];
 const getInstallPlan=vi.fn(()=>new Promise<ReturnType<typeof planWith>>(resolve=>pending.push(resolve)));
 window.launcher={getInstallPlan} as unknown as Window['launcher'];
 const node=document.createElement('div'),root=createRoot(node);
 const render=()=>act(async()=>root.render(<CatalogGameDetails product={product} data={data} back={()=>{}} toast={()=>{}}/>));
 try{
  await render();
  await vi.waitFor(()=>expect(getInstallPlan).toHaveBeenCalledTimes(1));
  data.auth={...data.auth,username:'other@example.test'};
  await render();
  await vi.waitFor(()=>expect(getInstallPlan).toHaveBeenCalledTimes(2));
  await act(async()=>pending[0](planWith({downloadBytes:2*1024**3,installBytes:4*1024**3})));
  expect(node.textContent).not.toContain('Estimated space: 4.0 GiB');
  await act(async()=>pending[1](planWith({downloadBytes:3*1024**3,installBytes:5*1024**3})));
  await vi.waitFor(()=>expect(node.textContent).toContain('Estimated space: 5.0 GiB'));
 }finally{await act(async()=>root.unmount());}
});
