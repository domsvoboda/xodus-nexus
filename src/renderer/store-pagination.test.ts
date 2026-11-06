import {expect,it} from 'vitest';
import {appendStoreProducts,storePageState,storeRequested} from './store-pagination';
import type {CatalogProduct,CatalogSearchResult} from '../shared/types';

const product=(id:string):CatalogProduct=>({productId:id,title:id,description:'',categories:[],installability:'supported',supportNote:'Supported'});
const result=(products:CatalogProduct[],cursor?:string,hasMore=false):CatalogSearchResult=>({query:'Top paid games',market:'US',products,cursor,hasMore,fetchedAt:new Date().toISOString(),source:'Microsoft Store'});

it('appends only unseen product IDs so repeated Store pages never duplicate a card',()=>{
 const current=[product('9A'),product('9B')];
 expect(appendStoreProducts(current,[product('9B'),product('9C')]).map(item=>item.productId)).toEqual(['9A','9B','9C']);
 expect(appendStoreProducts(current,[product('9A')])).toBe(current);
 expect(appendStoreProducts(current,[])).toBe(current);
});

it('records the requested cursor with the feed cursors that were already used',()=>{
 const page={requested:[] as readonly string[]};
 expect(storeRequested(page,undefined)).toEqual([]);
 expect(storeRequested({requested:['paid-4']},'paid-5')).toEqual(['paid-4','paid-5']);
});

it('continues on a genuinely new cursor',()=>{
 const state=storePageState([product('9A')],result([product('9B')],'paid-5',true),['paid-4']);
 expect(state.products.map(item=>item.productId)).toEqual(['9A','9B']);
 expect(state.cursor).toBe('paid-5');expect(state.hasMore).toBe(true);expect(state.stalled).toBe(false);
 expect(state.requested).toEqual(['paid-4']);
});

it('ends the list once when any earlier cursor repeats instead of loading the same page again',()=>{
 const repeated=storePageState([product('9A')],result([product('9B')],'paid-4',true),['paid-4','paid-5']);
 expect(repeated.cursor).toBeUndefined();expect(repeated.hasMore).toBe(false);expect(repeated.stalled).toBe(true);
 // Loaded cards are preserved when the cycle is detected.
 expect(repeated.products.map(item=>item.productId)).toEqual(['9A','9B']);
});

it('stops an A to B to A cursor cycle while keeping every loaded card',()=>{
 let feed=storePageState([],result([product('9P1')],'paid-4',true),[]);
 expect(feed.cursor).toBe('paid-4');
 const first=storePageState(feed.products,result([product('9P2')],'paid-5',true),storeRequested(feed,feed.cursor));
 expect(first.cursor).toBe('paid-5');expect(first.hasMore).toBe(true);expect(first.products).toHaveLength(2);
 const used=storeRequested(first,first.cursor);
 expect(used).toEqual(['paid-4','paid-5']);
 const cycle=storePageState(first.products,result([product('9P3')],'paid-4',true),used);
 expect(cycle.hasMore).toBe(false);expect(cycle.cursor).toBeUndefined();expect(cycle.stalled).toBe(true);
 expect(cycle.products.map(item=>item.productId)).toEqual(['9P1','9P2','9P3']);
});

it('ends the list when the Store claims more pages without a usable cursor',()=>{
 const missing=storePageState([],result([product('9A')],undefined,true),[]);
 expect(missing.hasMore).toBe(false);expect(missing.stalled).toBe(true);
 const ended=storePageState([],result([product('9A')],undefined,false),[]);
 expect(ended.hasMore).toBe(false);expect(ended.stalled).toBe(false);expect(ended.cursor).toBeUndefined();
});
