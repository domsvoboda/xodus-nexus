import type {CatalogProduct,CatalogSearchResult} from '../shared/types';

/** One paged public Store list. It only ever grows by explicit continuation. */
export type StoreListPage = {products:CatalogProduct[];cursor?:string;hasMore:boolean;stalled:boolean;requested:readonly string[]};

/** Cards are unique by real product ID. The featured set and later collection
 * pages can repeat the same title, so every append is deduplicated. */
export function appendStoreProducts(current:CatalogProduct[],next:CatalogProduct[]):CatalogProduct[] {
  const seen=new Set(current.map(product=>product.productId));
  const appended=next.filter(product=>{if(seen.has(product.productId))return false;seen.add(product.productId);return true;});
  return appended.length?[...current,...appended]:current;
}

/** Cursors already used by this feed, including the page about to be requested.
 * Every cursor is recorded once, so an A to B to A cycle is visible. */
export function storeRequested(page:Pick<StoreListPage,'requested'>,cursor?:string):readonly string[] {
  return cursor?[...page.requested,cursor]:page.requested;
}

/** A cursor that repeats any earlier page of this feed would refetch an already
 * loaded page forever. It ends the list exactly once instead of starting a
 * duplicate request loop, and the loaded cards stay visible. */
export function storePageState(current:CatalogProduct[],next:CatalogSearchResult,requested:readonly string[]):StoreListPage {
  const products=appendStoreProducts(current,next.products);
  const cursor=next.cursor;
  const repeated=Boolean(cursor)&&requested.includes(cursor as string);
  const advanced=Boolean(cursor)&&!repeated;
  return {products,cursor:advanced?cursor:undefined,hasMore:next.hasMore&&advanced,stalled:next.hasMore&&!advanced,requested};
}
