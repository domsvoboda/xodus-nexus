import type {GameDetailsScope} from '../shared/types.js';

/** Public Store browsing uses one stable technical market.
 *
 * The Microsoft Store search and recommendation endpoints have no global
 * offer: they require a concrete market code. Public browsing therefore uses
 * the US market with the Store's English metadata for every installation, so
 * an international page does not silently inherit a country from the OS locale
 * or from a `neutral` market setting. It is also one stable cache key and one
 * English description for the same product everywhere.
 *
 * This is a browsing policy only. It does not promise a local or global price,
 * it never selects the region for an account, and it never proves ownership:
 * account, Library, entitlement, install, license and cloud operations keep
 * using the configured/effective account market.
 */
export const PUBLIC_STORE_MARKET = 'US';

/** Market for public Store search, featured collections and public details.
 * Deliberately independent of the OS locale and of a `neutral` setting. */
export function publicStoreMarket(): string {
  return PUBLIC_STORE_MARKET;
}

/** Read-only descriptive metadata for an explicit public Store presentation
 * scope uses the public browse market. Every other target, including an
 * unscoped Library product and a saved game ID, keeps the account market. */
export function catalogDetailMarket(scope: GameDetailsScope | undefined, accountMarket: string): string {
  return scope === 'public-store' ? publicStoreMarket() : accountMarket;
}
