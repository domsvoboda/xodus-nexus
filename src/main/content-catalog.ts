import type { LibraryAccess } from '../shared/types.js';

type Product = Record<string, any>;
const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Z0-9]{12}$/.test(id);
const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
export const contentSkus = (product: Product): Product[] => list(product?.DisplaySkuAvailabilities)
  .map(row => row?.Sku?.Properties).filter(props => props && props.IsTrial === false && props.IsPreOrder !== true);
export const desktopContentPackages = (product: Product): Product[] => contentSkus(product)
  .flatMap(props => list(props.Packages)).filter(pkg => pkg && pkg.PackageFormat === 'MSIXVC'
    && list(pkg.Architectures).includes('x64') && list(pkg.PlatformDependencies).some(dep => dep?.PlatformName === 'Windows.Desktop'));
const relationships = (product: Product, kind: string): string[] => list(product?.MarketProperties)
  .flatMap(market => list(market?.RelatedProducts)).filter(row => row?.RelationshipType === kind && validId(row.RelatedProductId)).map(row => row.RelatedProductId);
const bundleChildren = (product: Product): string[] => contentSkus(product)
  .flatMap(props => list(props.BundledSkus)).filter(row => validId(row?.BigId)).map(row => row.BigId);

/** Public metadata is discovery, never a license. Keep large artwork/URLs out of the cache. */
function compact(product: Product): Product {
  return { ProductId: product.ProductId, ProductType: product.ProductType,
    LocalizedProperties: list(product.LocalizedProperties).slice(0, 1).map(row => ({ ProductTitle: typeof row?.ProductTitle === 'string' ? row.ProductTitle.slice(0, 300) : '' })),
    MarketProperties: list(product.MarketProperties).map(row => ({ RelatedProducts: list(row?.RelatedProducts).map(relation => ({ RelatedProductId: relation?.RelatedProductId, RelationshipType: relation?.RelationshipType })) })),
    DisplaySkuAvailabilities: list(product.DisplaySkuAvailabilities).map(row => ({ Sku: { Properties: {
      IsTrial: row?.Sku?.Properties?.IsTrial, IsPreOrder: row?.Sku?.Properties?.IsPreOrder,
      PackagesDeclared: Object.hasOwn(row?.Sku?.Properties ?? {}, 'Packages'),
      BundledSkus: list(row?.Sku?.Properties?.BundledSkus).map(child => ({ BigId: child?.BigId })),
      Packages: row?.Sku?.Properties?.Packages === null ? null : list(row?.Sku?.Properties?.Packages).map(pkg => ({
        ContentId: pkg?.ContentId, PackageFormat: pkg?.PackageFormat, Architectures: pkg?.Architectures,
        PlatformDependencies: pkg?.PlatformDependencies, PackageFamilyName: pkg?.PackageFamilyName,
        MainPackageFamilyNameForDlc: pkg?.MainPackageFamilyNameForDlc, MaxDownloadSizeInBytes: pkg?.MaxDownloadSizeInBytes,
      })),
    } } })),
  };
}

export class ContentCatalog {
  private cache = new Map<string, { product?: Product; until: number; bytes: number }>();
  private cacheBytes = 0;
  constructor(private fetcher: typeof fetch = fetch) {}

  async discover(base: { storeId: string; name?: string; related: string[] }, access: Record<string, LibraryAccess>, market: string, offerId?: string, externalSignal?: AbortSignal): Promise<{ Products: Product[]; related: string[]; verify: string[] }> {
    const ownedIds = Object.keys(access);
    if (!validId(base.storeId) || base.related.length > 256 || base.related.some(id => !validId(id))
      || ownedIds.length > 10_000 || ownedIds.some(id => !validId(id))) throw Error('Invalid content discovery scope.');
    market = /^[A-Z]{2}$/.test(market.toUpperCase()) ? market.toUpperCase() : 'US';
    const signal = AbortSignal.any([AbortSignal.timeout(90_000), ...(externalSignal ? [externalSignal] : [])]), products = new Map<string, Product>(), fetched = new Set<string>();
    signal.throwIfAborted();
    let transferred = 0;
    const load = async (ids: string[]) => {
      signal.throwIfAborted();
      const pending = [...new Set(ids)].filter(id => !fetched.has(id));
      const batches: string[][] = [];
      for (const id of pending) {
        const entry = this.cache.get(`${market}:${id}`);
        if (entry && entry.until > Date.now()) { fetched.add(id); if (entry.product) products.set(id, entry.product); }
      }
      const needed = pending.filter(id => !fetched.has(id));
      for (let i = 0; i < needed.length; i += 20) batches.push(needed.slice(i, i + 20));
      let next = 0, failed = false;
      const jobs = Array.from({ length: Math.min(4, batches.length) }, async () => {
        while (!failed && next < batches.length) {
          const batch = batches[next++];
          try {
            signal.throwIfAborted();
            const url = new URL('https://displaycatalog.mp.microsoft.com/v7.0/products');
            url.search = new URLSearchParams({ bigIds: batch.join(','), market, languages: 'en-us,neutral' }).toString();
            const response = await this.fetcher(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
            if (!response.ok || !response.body) throw Error('Microsoft content metadata could not be loaded.');
            const reader = response.body.getReader(), chunks: Uint8Array[] = [];
            let bytes = 0;
            try {
              for (;;) {
                signal.throwIfAborted();
                const result = await reader.read(); if (result.done) break;
                bytes += result.value.byteLength; transferred += result.value.byteLength;
                if (bytes > 8_000_000 || transferred > 64_000_000) throw Error('Content metadata response is too large.');
                chunks.push(result.value);
              }
            } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
            const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
            if (!Array.isArray(data.Products) || data.Products.length > batch.length) throw Error('Unexpected content metadata.');
            const seen = new Set<string>();
            for (const raw of data.Products) {
              if (!raw || !batch.includes(raw.ProductId) || seen.has(raw.ProductId)) throw Error('Unexpected content metadata.');
              seen.add(raw.ProductId); products.set(raw.ProductId, compact(raw));
            }
            for (const id of batch) {
              fetched.add(id);
              const product = products.get(id), key = `${market}:${id}`, bytes = Buffer.byteLength(JSON.stringify(product ?? null));
              if (bytes > 1_000_000) throw Error('Content metadata response is too large.');
              const old = this.cache.get(key); if (old) this.cacheBytes -= old.bytes;
              this.cache.delete(key); this.cache.set(key, { product, bytes, until: Date.now() + (product ? 300_000 : 30_000) }); this.cacheBytes += bytes;
              while (this.cacheBytes > 16_000_000 || this.cache.size > 10_256) {
                const oldest = this.cache.keys().next().value!;
                this.cacheBytes -= this.cache.get(oldest)!.bytes; this.cache.delete(oldest);
              }
            }
          } catch (error) { failed = true; throw error; }
        }
      });
      const settled = await Promise.allSettled(jobs);
      const rejected = settled.find(result => result.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
    };
    await load([base.storeId, ...base.related, ...(validId(offerId) ? [offerId] : []), ...ownedIds]);
    const families = new Set(desktopContentPackages(products.get(base.storeId) ?? {}).map(pkg => pkg.PackageFamilyName)
      .filter(family => typeof family === 'string' && (base.name ? family.startsWith(base.name + '_') : /^[A-Za-z0-9.-]+_[A-Za-z0-9]+$/.test(family))));
    const scoped = (product: Product) => ['Durable', 'GameAddOn'].includes(product.ProductType)
      && (base.related.includes(product.ProductId) || relationships(product, 'addOnParent').includes(base.storeId)
        || desktopContentPackages(product).some(pkg => families.has(pkg.MainPackageFamilyNameForDlc)));
    const related = new Set(base.related.filter(id => id !== base.storeId));
    let frontier = [...new Set([base.storeId, ...base.related, ...(validId(offerId) ? [offerId] : []),
      ...[...products.values()].filter(product => scoped(product) || access[product.ProductId] && bundleChildren(product).includes(base.storeId)).map(product => product.ProductId)])];
    const graph = new Set<string>();
    for (let depth = 0; frontier.length; depth++) {
      if (depth > 6) throw Error('Content relationship graph is too deep.');
      const next = new Set<string>();
      for (const id of frontier) {
        if (graph.has(id)) continue;
        graph.add(id); if (graph.size > 256) throw Error('Content relationship graph is too large.');
        const product = products.get(id); if (!product) continue;
        if (scoped(product)) related.add(id);
        for (const child of [...bundleChildren(product), ...(id === base.storeId ? relationships(product, 'Bundle') : [])])
          if (!graph.has(child)) next.add(child);
      }
      for (const id of graph) next.delete(id);
      if (graph.size + next.size > 256) throw Error('Content relationship graph is too large.');
      await load([...next]); frontier = [...next];
    }
    if (related.size > 128) throw Error('Too many related content products.');
    // Bundle membership only permits an actual license check, never an ownership grant.
    const verify = new Set<string>();
    for (const root of graph) if (access[root]) {
      const visited = new Set([root]); let pending = bundleChildren(products.get(root) ?? {});
      while (pending.length) {
        const id = pending.pop()!; if (visited.has(id)) continue;
        visited.add(id); if (visited.size > 256) throw Error('Content relationship graph is too large.');
        if (related.has(id)) verify.add(id);
        pending.push(...bundleChildren(products.get(id) ?? {}));
      }
    }
    return { Products: [products.get(base.storeId), ...[...related].map(id => products.get(id))].filter((p): p is Product => Boolean(p)), related: [...related], verify: [...verify] };
  }
}
