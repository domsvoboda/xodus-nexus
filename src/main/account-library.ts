import { randomUUID } from 'node:crypto';
import { spawnTracked } from './process.js';
import { backendDiagnostic } from './backend-diagnostics.js';
import { sessionFailureMessage } from './session-errors.js';
import type { AccountLibraryPage, CatalogProduct } from '../shared/types.js';

interface Entitlement {
  productId: string; status: string; isTrial: boolean; sharingSource: string;
  endDate: string; satisfiedByProductId?: string | null; special: boolean; isPositron?: boolean;
}
type Kind = AccountLibraryPage['kind'];
type Reader = (binary: string, market: string, signal: AbortSignal) => Promise<string>;
type Catalog = (ids: string[], market: string) => Promise<CatalogProduct[]>;
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Z0-9]{12}$/.test(value);
const plans = new Set(['CFQ7TTC0KGQ8', 'CFQ7TTC0KHS0', 'CFQ7TTC0P85B', 'CFQ7TTC0K5DJ', 'CFQ7TTC0K6L8', 'CFQ7TTC10QFD']);
const TTL = 5 * 60_000;

export function parseEntitlements(output: string, account: string, market: string, now = Date.now()): { checkedAt: string; entries: Map<string, Entitlement>; skipped: number } {
  if (output.length > 8_000_000) throw Error('Account library response is too large.');
  const line = output.split('\n').reverse().find(line => line.trimStart().startsWith('{'));
  const result = JSON.parse(line ?? '');
  if (!result || result.schema !== 1 || result.account !== account || result.market !== market
    || typeof result.checkedAt !== 'string' || !Array.isArray(result.entitlements) || result.entitlements.length > 10_000) throw Error('Invalid account library response.');
  const age = now - Date.parse(result.checkedAt);
  if (!Number.isFinite(age) || age < -60_000 || age >= TTL) throw Error('Stale account library response.');
  const entries = new Map<string, Entitlement>();
  const seen = new Set<string>(), blocked = new Set<string>();
  if (result.skippedEntitlements !== undefined && (!Number.isInteger(result.skippedEntitlements) || result.skippedEntitlements < 0 || result.skippedEntitlements > 200_000)) throw Error('Invalid skipped entitlement count.');
  for (const row of result.entitlements) {
    if (!row || !id(row.productId)) continue;
    const duplicate = seen.has(row.productId); seen.add(row.productId);
    if (duplicate || typeof row.status !== 'string' || row.status.length >= 40
      || typeof row.isTrial !== 'boolean' || typeof row.special !== 'boolean' || typeof row.sharingSource !== 'string'
      || (row.isPositron !== undefined && (typeof row.isPositron !== 'boolean' || (row.isPositron && !row.special)))
      || row.sharingSource.length >= 40 || typeof row.endDate !== 'string' || row.endDate.length >= 50 || !Number.isFinite(Date.parse(row.endDate))
      || (row.satisfiedByProductId != null && !id(row.satisfiedByProductId))) { blocked.add(row.productId); entries.delete(row.productId); continue; }
    entries.set(row.productId, row);
  }
  // Quarantine descendants as well, including known subscription IDs. An invalid
  // parent must never turn its child's bundle/subscription reference into access.
  const children = new Map<string, string[]>();
  for (const [product, row] of entries) if (row.satisfiedByProductId) {
    const list = children.get(row.satisfiedByProductId) ?? []; list.push(product); children.set(row.satisfiedByProductId, list);
  }
  const queue = [...blocked];
  for (let i = 0; i < queue.length; i++) for (const child of children.get(queue[i]) ?? []) {
    if (!blocked.has(child)) { blocked.add(child); queue.push(child); entries.delete(child); }
  }
  const skipped = Math.min(200_000, (result.skippedEntitlements ?? 0) + result.entitlements.length - entries.size);
  if (skipped) backendDiagnostic({ operation: 'library', event: 'validation', stage: 'partial', skipped });
  return { checkedAt: result.checkedAt, entries, skipped };
}

type Resolution = { kind?: Exclude<Kind, 'all'>; reason?: 'access-unresolved' | 'access-conditional' | 'access-special' | 'access-parent-unavailable' | 'access-cycle' | 'access-depth' };
/** An active effective entitlement can have an absent source row. That is not permanent ownership. */
function resolveEntitlement(productId: string, entries: Map<string, Entitlement>, now: number): Resolution {
  const visited = new Set<string>();
  let current = productId, subscription = false, conditional = false;
  for (let depth = 0; depth < 16; depth++) {
    if (visited.has(current)) return { reason: 'access-cycle' };
    visited.add(current);
    subscription ||= plans.has(current);
    const item = entries.get(current);
    if (!item) return depth ? conditional ? { kind: 'owned', reason: 'access-conditional' }
      : subscription ? { kind: 'gamepass' } : { kind: 'other', reason: 'access-unresolved' } : {};
    // Only the backend's explicit boolean provenance permits conditional access.
    // Legacy/unknown special flags remain excluded, never assumed to be owned.
    if (item.special && item.isPositron !== true) return { reason: 'access-special' };
    if (item.status !== 'Active' || item.isTrial || item.sharingSource !== 'None' || Date.parse(item.endDate) <= now)
      return depth ? { reason: 'access-parent-unavailable' } : {};
    conditional ||= item.isPositron === true;
    // Owned is a library category, not a promise that a license cannot expire
    // or be revoked. Explicit disc-derived access belongs with purchased games.
    if (!item.satisfiedByProductId) return current === productId && plans.has(current) ? {}
      : conditional ? { kind: 'owned', reason: 'access-conditional' } : { kind: subscription ? 'gamepass' : 'owned' };
    current = item.satisfiedByProductId;
  }
  return { reason: 'access-depth' };
}
export function entitlementKind(productId: string, entries: Map<string, Entitlement>, now = Date.now()): Exclude<Kind, 'all'> | undefined {
  return resolveEntitlement(productId, entries, now).kind;
}

async function read(binary: string, market: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const tracked = spawnTracked(binary, ['library', '--json', '--market', market], { maxOutput: 8_000_000, stdoutOnly: true });
  let diagnostics = '';
  const stderr = (bytes: Buffer) => { diagnostics = (diagnostics + bytes.toString('utf8')).slice(-64_000); };
  tracked.child.stderr.on('data', stderr);
  const stop = () => { tracked.child.kill('SIGKILL'); };
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  const timer = setTimeout(stop, 50_000); timer.unref();
  try {
    const result = await tracked.result; signal.throwIfAborted();
    if (result.code !== 0) throw Error(sessionFailureMessage(diagnostics) ?? 'Microsoft account licenses could not be loaded. Try Refresh later.');
    return result.output;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', stop); tracked.child.stderr.removeListener('data', stderr); }
}

/** Credentials stay in the CLI. Account-bound memory only, no license dumps in UI/disk logs. */
export class AccountLibrary {
  private identity?: { account: string; binary: string; market: string };
  private generation = 0;
  private controller?: AbortController;
  private cached?: { checkedAt: string; entries: Map<string, Entitlement>; skipped: number; unclassified: number; excluded: number; until: number; key: string; recent?: Promise<string[]> };
  private job?: Promise<void>;
  private pages = new Map<string, AccountLibraryPage>();
  constructor(private catalog: Catalog, private reader: Reader = read, private recent?: (market: string) => Promise<string[]>) {}
  reset(): void {
    this.generation++; this.controller?.abort(); this.controller = undefined;
    this.cached = undefined; this.job = undefined; this.pages.clear();
  }
  select(account: string | undefined, binary: string | undefined, market: string): void {
    const normalized = /^[A-Z]{2}$/.test(market.toUpperCase()) ? market.toUpperCase() : 'US';
    const next = account && binary ? { account, binary, market: normalized } : undefined;
    if (JSON.stringify(this.identity) !== JSON.stringify(next)) { this.reset(); this.identity = next; }
  }
  private async load(cursor?: string, refresh = false): Promise<NonNullable<AccountLibrary['cached']>> {
    const identity = this.identity;
    if (!identity) throw Error('Sign in and update the Xodus backend to load account games.');
    if (refresh) { this.reset(); cursor = undefined; }
    const generation = this.generation;
    const current = () => { if (generation !== this.generation) throw Error('Account library changed. Refresh this page.'); };
    if (!this.cached || this.cached.until <= Date.now()) {
      if (cursor) throw Error('Library results expired. Refresh this page.');
      if (!this.job) {
        const controller = new AbortController(); this.controller = controller;
        this.job = (async () => {
          const output = await this.reader(identity.binary, identity.market, controller.signal);
          let data: ReturnType<typeof parseEntitlements>;
          try { data = parseEntitlements(output, identity.account, identity.market); }
          catch (error) {
            backendDiagnostic({ operation: 'library', event: 'validation', stage: 'invalid-response' });
            throw error;
          }
          current();
          const counts = new Map<NonNullable<Resolution['reason']>, number>();
          let unclassified = 0, excluded = 0;
          for (const product of data.entries.keys()) {
            const resolution = resolveEntitlement(product, data.entries, Date.parse(data.checkedAt));
            if (resolution.kind === 'other') unclassified++;
            if (resolution.reason && !resolution.kind) excluded++;
            if (resolution.reason) counts.set(resolution.reason, (counts.get(resolution.reason) ?? 0) + 1);
          }
          for (const [stage, skipped] of counts) backendDiagnostic({ operation: 'library', event: 'validation', stage, skipped });
          this.cached = { ...data, unclassified, excluded, until: Date.parse(data.checkedAt) + TTL, key: randomUUID() };
          this.pages.clear();
        })().finally(() => { if (generation === this.generation) { this.controller = undefined; this.job = undefined; } });
      }
      await this.job;
    }
    current();
    return this.cached!;
  }
  /** Scoped callers can read access without fetching unrelated library artwork. */
  peekAccess(): AccountLibraryPage['accessByProductId'] {
    const accessByProductId: AccountLibraryPage['accessByProductId'] = {};
    if (!this.identity || !this.cached || this.cached.until <= Date.now()) return accessByProductId;
    for (const product of this.cached.entries.keys()) {
      const access = entitlementKind(product, this.cached.entries);
      if (access) accessByProductId[product] = access;
    }
    return accessByProductId;
  }
  /**
   * Owned access for a launch's DLC hints. Starts loading the library now when
   * no fresh copy is cached (the launch prepares meanwhile); the returned read
   * waits at most `waitMs` for that load and otherwise answers from the cache,
   * leaving the load to finish for the next launch. Never throws.
   */
  startLaunchAccess(): (waitMs: number) => Promise<AccountLibraryPage['accessByProductId']> {
    if (!this.identity || (this.cached && this.cached.until > Date.now())) return async () => this.peekAccess();
    const loaded = this.access().then(result => result.accessByProductId, () => undefined);
    return async (waitMs) => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<undefined>(resolve => { timer = setTimeout(resolve, waitMs, undefined); });
      try { return await Promise.race([loaded, timeout]) ?? this.peekAccess(); }
      finally { clearTimeout(timer); }
    };
  }
  async access(refresh = false): Promise<{ checkedAt: string; accessByProductId: AccountLibraryPage['accessByProductId'] }> {
    const cached = await this.load(undefined, refresh);
    if (cached !== this.cached || !this.identity) throw Error('Account library changed. Refresh this page.');
    const accessByProductId: AccountLibraryPage['accessByProductId'] = {};
    for (const product of cached.entries.keys()) {
      const access = entitlementKind(product, cached.entries);
      if (access) accessByProductId[product] = access;
    }
    return { checkedAt: cached.checkedAt, accessByProductId };
  }
  async get(kind: Kind, cursor?: string, refresh = false, sort?: AccountLibraryPage['sort']): Promise<AccountLibraryPage> {
    if (kind !== 'all' && kind !== 'owned' && kind !== 'gamepass' && kind !== 'other') throw Error('Invalid library filter.');
    if (sort !== undefined && (sort !== 'recent-gamepass' || kind !== 'gamepass')) throw Error('Invalid library order.');
    if (typeof refresh !== 'boolean' || (cursor !== undefined && typeof cursor !== 'string')) throw Error('Invalid library request.');
    const cached = await this.load(cursor, refresh);
    if (cached !== this.cached || !this.identity) throw Error('Account library changed. Refresh this page.');
    if (refresh) cursor = undefined;
    const identity = this.identity!;
    const generation = this.generation;
    const current = () => { if (generation !== this.generation) throw Error('Account library changed. Refresh this page.'); };
    let recent: string[] | undefined;
    if (sort) {
      // Freeze the public order for this licensed snapshot so a live feed change
      // cannot duplicate or skip games between pages. It never grants access.
      if (!this.recent) throw Error('PC Game Pass ordering is unavailable. Choose Default order.');
      cached.recent ??= Promise.resolve().then(() => this.recent!(identity.market)).then(ids => {
        if (!Array.isArray(ids) || ids.length > 1000 || ids.some(value => !id(value)) || new Set(ids).size !== ids.length)
          throw Error('Invalid PC Game Pass order.');
        return [...ids];
      }).catch(() => { cached.recent = undefined; throw Error('The PC Game Pass recently added list could not be loaded. Try again or choose Default order.'); });
      recent = await cached.recent;
      current();
      if (this.cached !== cached) throw Error('Library results changed. Refresh this page.');
    }
    const accessByProductId: AccountLibraryPage['accessByProductId'] = {};
    for (const product of cached.entries.keys()) {
      const access = entitlementKind(product, cached.entries);
      if (access) accessByProductId[product] = access;
    }
    // Stable offsets within one snapshot even when a license expires mid-page.
    const checked = Date.parse(cached.checkedAt);
    const snapshotAccess = new Map([...cached.entries.keys()].map(product => [product, entitlementKind(product, cached.entries, checked)]));
    const recentProductIds = recent?.filter(product => snapshotAccess.get(product) === 'gamepass');
    const rank = new Map(recentProductIds?.map((product,index) => [product,index]));
    const ids = [...cached.entries.keys()].filter(product => snapshotAccess.get(product) && (kind === 'all' || snapshotAccess.get(product) === kind))
      .sort((a,b) => (rank.get(a) ?? 1000) - (rank.get(b) ?? 1000) || Number(snapshotAccess.get(b) === 'owned') - Number(snapshotAccess.get(a) === 'owned') || a.localeCompare(b));
    let offset = 0;
    if (cursor) {
      const match = cursor.match(/^([a-f0-9-]{36}):(all|owned|gamepass|other)(?::(recent-gamepass))?:(\d{1,5})$/);
      if (!match || match[1] !== cached.key || match[2] !== kind || match[3] !== sort) throw Error('Invalid or expired library page.');
      offset = Number(match[4]);
      if (offset % 60 || offset > ids.length) throw Error('Invalid library page offset.');
    }
    const key = `${kind}:${sort ?? 'default'}:${offset}`;
    const existing = this.pages.get(key);
    if (existing) return structuredClone({ ...existing, accessByProductId,
      ...(sort ? {recentProductIds:existing.recentProductIds?.filter(id => accessByProductId[id] === 'gamepass')} : {}),
      products: existing.products.filter(p => accessByProductId[p.productId]) });
    const products = await this.catalog(ids.slice(offset, offset + 60), identity.market);
    current();
    if (this.cached !== cached) throw Error('Library results changed. Refresh this page.');
    const allowed = new Set(ids.slice(offset, offset + 60));
    const page: AccountLibraryPage = { kind, ...(sort ? {sort,recentProductIds} : {}), checkedAt: cached.checkedAt, accessByProductId, skippedEntitlements: cached.skipped,
      unclassifiedEntitlements: cached.unclassified, excludedEntitlements: cached.excluded,
      products: products.filter(product => allowed.has(product.productId) && accessByProductId[product.productId])
        .map(product => ({ ...product, access: accessByProductId[product.productId] }))
        .sort((a, b) => (sort ? (rank.get(a.productId) ?? 1000) - (rank.get(b.productId) ?? 1000) : 0) || a.title.localeCompare(b.title)),
      cursor: offset + 60 < ids.length ? `${cached.key}:${kind}${sort ? ':' + sort : ''}:${offset + 60}` : undefined };
    this.pages.set(key, page);
    return structuredClone(page);
  }
}
