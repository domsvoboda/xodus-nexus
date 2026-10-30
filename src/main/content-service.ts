import type { AccountLibraryPage, Game } from '../shared/types.js';

type Access = AccountLibraryPage['accessByProductId'];
const TTL = 5 * 60_000;
// Nothing waits on this but the game's query, which gives up after 20 s.
const DISCOVERY_MS = 15_000;
const market = (value: string) => /^[A-Z]{2}$/.test(value.toUpperCase()) ? value.toUpperCase() : 'US';

/** The account library as discovery reads it (`AccountLibrary`). */
export interface ContentLibrary {
  select(account: string | undefined, binary: string | undefined, market: string): void;
  access(): Promise<{ accessByProductId: Access }>;
  peekAccess(): Access;
}

/** Catalog discovery for one game (`GameContent.relatedProducts`). */
export interface ContentDiscovery {
  relatedProducts(game: Game, access: Access, market: string, signal: AbortSignal): Promise<string[]>;
}

/** What the game bridge answers right now: still discovering, the IDs, or nothing new. */
export type RelatedPoll = { state: 'pending' } | { state: 'done'; ids: string[] } | { state: 'failed' };

/**
 * A game's add-on IDs, discovered when the game asks instead of before launch.
 * Owned access plus public catalog metadata, cached per account, game and
 * market. IDs are discovery hints only; the runtime still needs a signed
 * receipt for each. Memory only, and an account change drops everything.
 */
export class ContentService {
  private account?: string;
  private generation = 0;
  private results = new Map<string, { ids: string[]; until: number }>();
  private jobs = new Map<string, Promise<string[]>>();
  private failed = new Set<string>();

  constructor(private library: ContentLibrary, private discovery: () => ContentDiscovery, private now = Date.now) {}

  select(account: string | undefined, binary: string | undefined, selectedMarket: string): void {
    this.library.select(account, binary, selectedMarket);
    if (account === this.account) return;
    this.account = account;
    this.generation++;
    this.results.clear(); this.jobs.clear(); this.failed.clear();
  }

  private key(game: Game, selectedMarket: string): string {
    return `${this.account ?? ''}\0${game.id}\0${game.storeId ?? ''}\0${market(selectedMarket)}`;
  }

  /** The last list for this game, even if it is old: an instant launch hint that works offline. */
  cached(game: Game, selectedMarket: string): string[] {
    return this.results.get(this.key(game, selectedMarket))?.ids ?? [];
  }

  /** A fresh list, from cache within the library TTL; one discovery per key at a time. */
  related(game: Game, selectedMarket: string): Promise<string[]> {
    const key = this.key(game, selectedMarket), cached = this.results.get(key);
    if (cached && cached.until > this.now()) return Promise.resolve(cached.ids);
    const running = this.jobs.get(key);
    if (running) return running;
    const generation = this.generation;
    const job = (async () => {
      const owned = await this.library.access().then(value => value.accessByProductId, () => this.library.peekAccess());
      const ids = await this.discovery().relatedProducts(game, owned, market(selectedMarket), AbortSignal.timeout(DISCOVERY_MS));
      if (generation === this.generation) { this.results.set(key, { ids, until: this.now() + TTL }); this.failed.delete(key); }
      return ids;
    })();
    this.jobs.set(key, job);
    void job.catch(() => { if (generation === this.generation) this.failed.add(key); })
      .finally(() => { if (this.jobs.get(key) === job) this.jobs.delete(key); });
    return job;
  }

  /** For the bridge's synchronous reply: starts discovery if needed and reports where it is. */
  poll(game: Game, selectedMarket: string): RelatedPoll {
    const key = this.key(game, selectedMarket), cached = this.results.get(key);
    if (cached && cached.until > this.now()) return { state: 'done', ids: cached.ids };
    if (!this.jobs.has(key)) {
      if (this.failed.delete(key)) return { state: 'failed' };
      void this.related(game, selectedMarket).catch(() => undefined);
    }
    return { state: 'pending' };
  }

  /** Refreshes in the background so the game's next query is answered at once. */
  warm(game: Game, selectedMarket: string): void {
    void this.related(game, selectedMarket).catch(() => undefined);
  }
}
