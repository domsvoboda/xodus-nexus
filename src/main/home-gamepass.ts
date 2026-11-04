import type { RecentGamePassShelf } from '../shared/types.js';
import type { CatalogService } from './catalog.js';
import type { RecentPcGamePass } from './gamepass-recent.js';

/** One bounded metadata window for the Home row. The official collection can
 * be longer; a wider window leaves room for public-policy filtering while the
 * presentation stays a short, bounded shelf. */
export const HOME_GAMEPASS_FETCH = 24;
export const HOME_GAMEPASS_LIMIT = 12;
const TTL = 10 * 60_000;

type Recent = Pick<RecentPcGamePass, 'get'>;
type PublicCatalog = Pick<CatalogService, 'publicProducts'>;

/**
 * Public PC Game Pass shelf for Home.
 *
 * Membership and order come from the existing official anonymous PC
 * collection. Display metadata is resolved through the same public Store
 * policy as Store browsing, so demos, trials and free offers stay hidden.
 * This is not an owned account Library and never grants install access.
 */
export class HomeGamePassShelf {
  private readonly cache = new Map<string, { until: number; value: RecentGamePassShelf }>();
  private readonly requests = new Map<string, Promise<RecentGamePassShelf>>();
  constructor(private readonly recent: Recent, private readonly catalog: PublicCatalog, private readonly now = Date.now) {}

  async get(market: string): Promise<RecentGamePassShelf> {
    if (!/^[A-Z]{2}$/.test(market)) throw Error('Invalid public Store market.');
    const cached = this.cache.get(market);
    if (cached && cached.until > this.now()) return structuredClone(cached.value);
    const pending = this.requests.get(market);
    if (pending) return structuredClone(await pending);
    const job = this.read(market).catch(error => {
      // A previously loaded real list may be shown as explicitly stale, never
      // as a fresh answer and never with invented products or timestamps.
      if (cached) return { ...cached.value, stale: true } as RecentGamePassShelf;
      throw error;
    });
    this.requests.set(market, job);
    try {
      const value = await job;
      if (!value.stale) {
        this.cache.set(market, { until: this.now() + TTL, value });
        while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
      }
      return structuredClone(value);
    } finally {
      this.requests.delete(market);
    }
  }

  private async read(market: string): Promise<RecentGamePassShelf> {
    const ids = await this.recent.get(market);
    if (!ids.length) return { market, products: [], fetchedAt: new Date(this.now()).toISOString(), source: 'Microsoft Game Pass catalog' };
    const products = await this.catalog.publicProducts(ids.slice(0, HOME_GAMEPASS_FETCH), market);
    return { market, products: products.slice(0, HOME_GAMEPASS_LIMIT), fetchedAt: new Date(this.now()).toISOString(), source: 'Microsoft Game Pass catalog' };
  }
}
