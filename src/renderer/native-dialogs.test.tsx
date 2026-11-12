// @vitest-environment jsdom
import {act,type ReactElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {CatalogGameDetails} from './CatalogGameDetails';
import {SettingsPage} from './App';
import {ui} from './i18n';
import {demoSnapshot} from '../shared/demo-data';
import type {CatalogProduct} from '../shared/types';

const product:CatalogProduct={productId:'9AAAAAAAAAAA',title:'Synthetic Game',description:'',categories:[],installability:'supported',supportNote:'Supported'};
let root:Root,toast:ReturnType<typeof vi.fn>;

function snapshot(){const data=demoSnapshot();data.games=[];data.downloads=[];return data;}
function launcher(chooseDirectory:unknown,chooseFile?:unknown){
  return {
    getGameDetails:vi.fn(async()=>{}),getGameActivity:vi.fn(async()=>({status:'unavailable'})),
    getGameAchievements:vi.fn(async()=>({status:'unavailable',items:[]})),getStoreAccess:vi.fn(async()=>undefined),
    gameRuntimeReadiness:vi.fn(async()=>true),launchGame:vi.fn(async()=>{}),chooseDirectory,chooseFile,
    updateSettings:vi.fn(async()=>{}),importBackend:vi.fn(async()=>{}),
  } as unknown as Window['launcher'];
}
async function mount(element:ReactElement){
  document.body.innerHTML='<div id="root"></div>';
  root=createRoot(document.getElementById('root')!);
  await act(async()=>{root.render(element);});
  await act(async()=>{await Promise.resolve();});
}
async function click(node:Element|null|undefined){
  expect(node).toBeDefined();
  await act(async()=>{(node as HTMLElement).click();});
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});
}
function watchUnhandled(){
  const calls:unknown[]=[],handler=(reason:unknown)=>calls.push(reason);
  process.on('unhandledRejection',handler);
  return {calls,stop:()=>process.off('unhandledRejection',handler)};
}
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);toast=vi.fn();});
afterEach(async()=>{await act(async()=>root.unmount());vi.restoreAllMocks();vi.unstubAllGlobals();document.body.innerHTML='';});

it('shows the Gaming Mode guidance and keeps the typed catalog destination on chooser rejection',async()=>{
  const choose=vi.fn(async():Promise<string|null>=>{throw Error('The file picker is unavailable in Gaming Mode.');});
  window.launcher=launcher(choose);
  const unhandled=watchUnhandled();
  try{
    await mount(<CatalogGameDetails product={product} data={snapshot()} back={()=>{}} toast={toast}/>);
    const input=document.querySelector<HTMLInputElement>('.gd-install-options input')!;
    const original=input.value;
    await click(document.querySelector<HTMLButtonElement>('.gd-install-options .input-action button'));
    expect(toast).toHaveBeenCalledWith({kind:'error',message:'The file picker is unavailable in Gaming Mode.'});
    expect(input.value).toBe(original);
    expect(document.querySelector<HTMLInputElement>('.gd-install-options input')!.disabled).toBe(false);
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!;
    await act(async()=>{setter.call(input,'/manual/path');input.dispatchEvent(new Event('input',{bubbles:true}));});
    expect(document.querySelector<HTMLInputElement>('.gd-install-options input')!.value).toBe('/manual/path');
    expect(unhandled.calls).toEqual([]);
  }finally{unhandled.stop();}
});

it('applies a desktop catalog destination and leaves it unchanged on cancel',async()=>{
  const choose=vi.fn(async():Promise<string|null>=>'/mnt/games/Chosen');
  window.launcher=launcher(choose);
  await mount(<CatalogGameDetails product={product} data={snapshot()} back={()=>{}} toast={toast}/>);
  const browse=()=>document.querySelector<HTMLButtonElement>('.gd-install-options .input-action button');
  await click(browse());
  expect(choose).toHaveBeenCalledWith(expect.stringContaining('Synthetic-Game'));
  expect(document.querySelector<HTMLInputElement>('.gd-install-options input')!.value).toBe('/mnt/games/Chosen');
  choose.mockResolvedValueOnce(null);
  const before=document.querySelector<HTMLInputElement>('.gd-install-options input')!.value;
  await click(browse());
  expect(document.querySelector<HTMLInputElement>('.gd-install-options input')!.value).toBe(before);
  expect(toast).not.toHaveBeenCalled();
});

it('ignores a late catalog chooser result after the account or page scope changed',async()=>{
  let resolve!: (value:string)=>void;
  const choose=vi.fn(()=>new Promise<string>(done=>{resolve=done;}));
  window.launcher=launcher(choose);
  const data=snapshot();
  await mount(<CatalogGameDetails product={product} data={data} back={()=>{}} toast={toast}/>);
  const before=document.querySelector<HTMLInputElement>('.gd-install-options input')!.value;
  const browse=document.querySelector<HTMLButtonElement>('.gd-install-options .input-action button');
  await act(async()=>{browse!.click();});
  const changed=snapshot();changed.settings.market='GB';changed.auth.username='other';
  await act(async()=>{root.render(<CatalogGameDetails product={product} data={changed} back={()=>{}} toast={toast}/>);});
  await act(async()=>{resolve('/mnt/games/Late');await Promise.resolve();});
  expect(document.querySelector<HTMLInputElement>('.gd-install-options input')!.value).toBe(before);
  expect(toast).not.toHaveBeenCalled();
});

it('surfaces Settings picker and backend import chooser failures without leaving an unhandled rejection',async()=>{
  const choose=vi.fn(async():Promise<string|null>=>{throw Error('The file picker is unavailable in Gaming Mode.');});
  window.launcher=launcher(choose);
  const unhandled=watchUnhandled();
  try{
    await mount(<SettingsPage data={snapshot()} toast={toast}/>);
    const browse=[...document.querySelectorAll<HTMLButtonElement>('button[aria-label]')].filter(node=>node.getAttribute('aria-label')===ui('ui.browse_3227aa9'));
    expect(browse).toHaveLength(3);
    const installInput=browse[0].closest('.input-action')!.querySelector<HTMLInputElement>('input')!;
    const installValue=installInput.value;
    await click(browse[0]);
    expect(toast).toHaveBeenLastCalledWith({kind:'error',message:'The file picker is unavailable in Gaming Mode.'});
    expect(installInput.value).toBe(installValue);
    const importer=[...document.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent===ui('backend.install_from_archive'))!;
    await click(importer);
    expect(toast).toHaveBeenLastCalledWith({kind:'error',message:'The file picker is unavailable in Gaming Mode.'});
    expect(window.launcher.importBackend).not.toHaveBeenCalled();
    expect(unhandled.calls).toEqual([]);
  }finally{unhandled.stop();}
});
