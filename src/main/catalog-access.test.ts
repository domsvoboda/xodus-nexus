import {expect,it} from 'vitest';
import {assertStoreOfferAccess} from './catalog-access.js';
const now=Date.parse('2026-11-03T09:00:00Z'),id='9AAAAAAAAAAA';
const context={account:'store',backend:'/backend',market:'US'};
const access={...context,configuredMarket:'US',checkedAt:new Date(now).toISOString(),expiresAt:new Date(now+60_000).toISOString(),accessByProductId:{[id]:'owned' as const}};
it('requires current Store/backend/market and exact owned or Game Pass offer evidence',()=>{
 expect(()=>assertStoreOfferAccess(access,id,context,now)).not.toThrow();
 expect(()=>assertStoreOfferAccess({...access,accessByProductId:{[id]:'gamepass'}},id,context,now)).not.toThrow();
 for(const change of [{account:'player'},{backend:'/other'},{market:'CZ'}])expect(()=>assertStoreOfferAccess(access,id,{...context,...change},now)).toThrow();
 for(const map of [{},{[id]:'other' as const}])expect(()=>assertStoreOfferAccess({...access,accessByProductId:map},id,context,now)).toThrow();
 expect(()=>assertStoreOfferAccess(access,'9BBBBBBBBBBB',context,now)).toThrow();
});
it('rejects expired, malformed and overlong leases independently of branding',()=>{
 for(const expiresAt of ['invalid',new Date(now).toISOString(),new Date(now+6*60_000).toISOString()])expect(()=>assertStoreOfferAccess({...access,expiresAt},id,context,now)).toThrow();
});
it('persists Store provenance across paused download restoration',async()=>{
 const fs=await import('node:fs/promises'),path=await import('node:path'),{StateStore}=await import('./store.js');
 const {tmpdir}=await import('node:os');
 const root=await fs.mkdtemp(path.join(tmpdir(),'store-access-state-'));
 try{
  const store=new StateStore(root);await store.load();await store.addDownload({source:'store',id:'synthetic',title:'Synthetic',productId:id,destination:'/synthetic',status:'queued',progress:null,phase:'queued',log:[],startedAt:new Date().toISOString()});
  const reopened=new StateStore(root);await reopened.load();expect(reopened.downloads[0]).toMatchObject({source:'store',status:'paused'});
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
