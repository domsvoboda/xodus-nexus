import {useEffect,useRef,useState} from 'react';
import {Download,FolderOpen,LoaderCircle,Play} from 'lucide-react';
import type {AppSnapshot,CatalogProduct} from '../shared/types';
import {GameDetails} from './GameDetails';
import {catalogInstallRequest,usePackageInstall} from './PackageInstall';
import {useStoreAccess} from './store-access';
import {useGameRuntimeReady} from './useGameRuntimeReady';
import {ui,uiText} from './i18n';

export function catalogGameInstalled(product:CatalogProduct,data:AppSnapshot){
 return data.games.find(game=>game.storeId&&[product.productId,product.installProductId].includes(game.storeId.toUpperCase()));
}
export function catalogGameQueued(product:CatalogProduct,data:AppSnapshot){
 return data.downloads.some(task=>['running','queued','paused'].includes(task.status)&&[product.productId,product.installProductId].includes(task.productId.toUpperCase()));
}

export function CatalogGameDetails({product,data,back,backLabel,toast,storeAccess,storeMode=false}:{product:CatalogProduct;storeMode?:boolean;storeAccess?:ReturnType<typeof useStoreAccess>;data:AppSnapshot;back:()=>void;backLabel?:string;toast:(value:{kind:'success'|'error';message:string})=>void}){
 const startInstall=usePackageInstall();
 const localAccess=useStoreAccess(data,storeMode&&!storeAccess),access=storeAccess??localAccess,licensed=!storeMode||access.canInstall(product);
 const [destination,setDestination]=useState(()=>{
  const folder=product.title.normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-+|-+$/g,'').slice(0,80)||product.productId;
  return `${data.settings.installRoot.replace(/\/+$/,'')}/${folder}`;
 });
 const [busy,setBusy]=useState(false),pending=useRef(false);
 const installed=catalogGameInstalled(product,data),queued=catalogGameQueued(product,data);
 const disabled=Boolean(installed)||!licensed||queued||busy||product.installability!=='supported'||!data.backend.capabilities.streaming;
 const scope=JSON.stringify([data.auth.username, data.auth.player,data.auth.stored,data.auth.running,data.backend.binaryPath,data.settings.market]);
 const identity=useRef(scope);identity.current=scope;
 useEffect(()=>{identity.current=scope;return()=>{identity.current='';};},[scope]);
 async function install(){
  if(disabled||pending.current||!destination.trim())return;
  pending.current=true;setBusy(true);
  try{
   const request=storeMode?{...catalogInstallRequest(product,destination),source:'store' as const}:catalogInstallRequest(product,destination);
   if(await startInstall(request,()=>identity.current===scope&&(!storeMode||access.canInstall(product)))&&identity.current===scope)toast({kind:'success',message:ui('ui.added_to_install_queue_c755bb7',{game:product.title})});
  }catch(error){if(identity.current===scope)toast({kind:'error',message:error instanceof Error?error.message:String(error)});}
  finally{pending.current=false;setBusy(false);}
 }
 const runtimeReady=useGameRuntimeReady(installed,data);
 const playDisabled=busy||installed?.installState!=='ready'||!data.backend.capabilities.run||!runtimeReady;
 async function play(){
  if(!installed||playDisabled)return;setBusy(true);
  try{await window.launcher.launchGame(installed.id);}
  catch(error){if(identity.current===scope)toast({kind:'error',message:error instanceof Error?error.message:String(error)});}
  finally{if(identity.current===scope)setBusy(false);}
 }
 const button=installed?<button className="primary" data-gamepad-play disabled={playDisabled} onClick={()=>void play()}>{busy?<LoaderCircle className="spin"/>:<Play fill="currentColor"/>}{ui('ui.play_436e610')}</button>:licensed?<button className="primary" data-gamepad-play disabled={disabled||!destination.trim()} onClick={()=>void install()}>{busy?<LoaderCircle className="spin"/>:<Download/>}{queued?ui('ui.in_install_queue_7c818f2'):busy?ui('ui.preparing_5d1fa38'):ui('ui.install_569ca49')}</button>:null;
 return <GameDetails key={installed?.id??product.productId} game={installed??{id:'catalog:'+product.productId,title:product.title,publisher:product.publisher,heroUrl:product.heroUrl,coverUrl:product.posterUrl}}
  detailId={product.productId} catalogProductId={installed?undefined:product.productId} data={data} back={back} backLabel={backLabel} play={<>{button}<button className="secondary" onClick={()=>window.open(product.storeUrl??`https://www.xbox.com/games/store/p/${product.productId}`,'_blank')}>{ui('ui.store_page_9c667df')}</button></>}
  notices={!installed?<section className="gd-install-options">{licensed?<p className={product.installability==='supported'?'supported':'unsupported'}>{uiText(product.supportNote)}</p>:null}
   {product.purchasePrice||product.includedWith?<div className="catalog-badges">{product.purchasePrice?<span>{product.purchasePrice}</span>:null}{product.includedWith?<span className="pass">{ui('store.available_with',{plan:product.includedWith})}</span>:null}</div>:null}
   {licensed?<label>{ui('ui.install_location_af47896')}<div className="input-action"><input value={destination} disabled={busy||queued} onChange={event=>setDestination(event.target.value)}/><button type="button" disabled={busy||queued} aria-label={ui('ui.choose_folder_3db7410')} onClick={async()=>{const value=await window.launcher.chooseDirectory(destination);if(value&&identity.current===scope)setDestination(value);}}><FolderOpen/></button></div></label>:null}
  </section>:undefined}/>
}
