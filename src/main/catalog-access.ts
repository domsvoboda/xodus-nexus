import type {StoreAccess} from '../shared/types.js';

/** A Store offer must have current account evidence, never public branding. */
export function assertStoreOfferAccess(access:StoreAccess, productId:string, context:{account?:string;backend?:string;market:string}, now=Date.now()):void {
  const expiry=Date.parse(access.expiresAt), checked=Date.parse(access.checkedAt);
  if(access.account!==context.account||access.backend!==context.backend||access.market!==context.market
    ||!Number.isFinite(expiry)||!Number.isFinite(checked)||checked>now+60_000||expiry<=now||expiry>checked+5*60_000
    ||!['owned','gamepass'].includes(access.accessByProductId[productId]??'')){
    throw Error('No current verified access to this Store offer. Open its Store page or refresh account access.');
  }
}
