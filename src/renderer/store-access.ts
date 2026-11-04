import {useEffect,useRef,useState} from 'react';
import type {AppSnapshot,CatalogProduct,LibraryAccess} from '../shared/types';

/** Account evidence is separate from public Store metadata and marketing labels. */
export interface StoreAccessEvidence {
 account:string;backend:string;market:string;configuredMarket:string;checkedAt:string;expiresAt:string;
 accessByProductId:Record<string,LibraryAccess>;
}
export function storeAccessScope(data:AppSnapshot):string {
 return JSON.stringify([data.auth.stored,data.auth.username,data.auth.running,data.backend.available,data.backend.binaryPath,data.settings.market]);
}
export function freshStoreAccess(evidence:StoreAccessEvidence|undefined,data:AppSnapshot,now=Date.now()):boolean {
 if(!evidence||data.auth.stored!==true||data.auth.running||!data.auth.username||!data.backend.available)return false;
 const checked=Date.parse(evidence.checkedAt),expires=Date.parse(evidence.expiresAt);
 return evidence.account===data.auth.username&&evidence.backend===data.backend.binaryPath&&evidence.configuredMarket===data.settings.market
  &&Number.isFinite(checked)&&Number.isFinite(expires)&&expires>checked&&checked<=now+60_000&&now<expires&&expires<=checked+5*60_000;
}
export function storeProductLicensed(evidence:StoreAccessEvidence|undefined,data:AppSnapshot,product:Pick<CatalogProduct,'productId'|'installability'>,now=Date.now()):boolean {
 if(product.installability!=='supported'||!freshStoreAccess(evidence,data,now))return false;
 const access=evidence!.accessByProductId?.[product.productId.toUpperCase()];
 return access==='owned'||access==='gamepass';
}
export function useStoreAccess(data:AppSnapshot, enabled=true) {
 const [evidence,setEvidence]=useState<StoreAccessEvidence>();
 const alive=useRef(true);
 const [revision,refresh]=useState(0);
 const scope=storeAccessScope(data),current=useRef({data,scope,evidence,epoch:0});
 const epoch=current.current.epoch+(current.current.scope===scope?0:1);current.current={data,scope,evidence,epoch};
 useEffect(()=>{
  let active=true,timer:ReturnType<typeof setTimeout>|undefined;
  setEvidence(undefined);
  if(enabled&&data.auth.stored===true&&!data.auth.running&&data.auth.username&&data.backend.available){
   const api=window.launcher as Window['launcher']&{getStoreAccess?:()=>Promise<StoreAccessEvidence>};
   void api.getStoreAccess?.().then(value=>{
    if(!active||current.current.scope!==scope||!freshStoreAccess(value,current.current.data))return;
    setEvidence(value);
    timer=setTimeout(()=>{if(active){setEvidence(undefined);refresh(value=>value+1);}},Math.max(1,Date.parse(value.expiresAt)-Date.now()));
   }).catch(()=>{/* Unknown account access has no installation action. */});
  }
  return()=>{active=false;if(timer)clearTimeout(timer);};
 },[scope,revision,enabled]);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;current.current.evidence=undefined;current.current.epoch++;};},[]);
 const canInstall=(product:Pick<CatalogProduct,'productId'|'installability'>)=>alive.current&&current.current.epoch===epoch&&current.current.scope===scope&&storeProductLicensed(current.current.evidence,current.current.data,product);
 return {canInstall};
}
