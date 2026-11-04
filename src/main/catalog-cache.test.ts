import { afterEach, expect, it, vi } from 'vitest';
import { CatalogService } from './catalog.js';

afterEach(() => vi.restoreAllMocks());
const response = () => new Response(JSON.stringify({ productsList: [], title: 'Featured' }), { status: 200 });
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

it.each(['search', 'featured'] as const)('coalesces twenty concurrent %s requests and isolates every caller result', async kind => {
  const gate = barrier();
  const fetcher = vi.fn(async () => { await gate.promise; return response(); });
  const catalog = new CatalogService(fetcher);
  const request = () => kind === 'search' ? catalog.search('Game', 'US') : catalog.featured('US');
  const pending = Array.from({ length: 20 }, request);
  await Promise.resolve();
  // One shared chain per key: one search request, or the two bounded Store
  // recommendation feeds for featured (trending and top paid).
  const chain = kind === 'search' ? 1 : 2;
  expect(fetcher).toHaveBeenCalledTimes(chain);
  gate.release();
  const results = await Promise.all(pending);
  results[0].query = 'changed';
  results[0].products.length = 1;
  for (const result of results.slice(1)) {
    expect(result.query).not.toBe('changed');
    expect(result.products).toEqual([]);
  }
  expect((await request()).products).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(chain);
});

it('shares a failure without caching it and permits a clean retry', async () => {
  const gate = barrier();
  const fetcher = vi.fn(async () => { await gate.promise; return new Response('', { status: 503 }); });
  const catalog = new CatalogService(fetcher);
  const results = Promise.allSettled(Array.from({ length: 20 }, () => catalog.search('Game', 'US')));
  gate.release();
  for (const result of await results) {
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.reason.message).toContain('503');
  }
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockImplementation(async () => response());
  expect((await catalog.search('Game', 'US')).products).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('separates markets, pages and featured results while retaining normalized search keys', async () => {
  const fetcher = vi.fn(async () => response());
  const catalog = new CatalogService(fetcher);
  await Promise.all([
    catalog.search('Game', 'US'), catalog.search(' game ', 'us'), catalog.search('Game', 'CZ'),
    catalog.search('Game', 'US', 'page2'), catalog.featured('US'), catalog.search('featured', 'US'),
  ]);
  // Four search keys plus the two bounded recommendation feeds of one featured key.
  expect(fetcher).toHaveBeenCalledTimes(6);
});

it('evicts least-recently-used results and expires entries without extending their lifetime on hits', async () => {
  let now = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const fetcher = vi.fn(async () => response());
  const catalog = new CatalogService(fetcher);
  for (let i = 0; i < 100; i++) await catalog.search(`game${i}`, 'US');
  now += 60_000;
  await catalog.search('game0', 'US');
  await catalog.search('extra', 'US');
  await catalog.search('game0', 'US');
  expect(fetcher).toHaveBeenCalledTimes(101);
  await catalog.search('game1', 'US');
  expect(fetcher).toHaveBeenCalledTimes(102);
  now += 540_000;
  await catalog.search('game0', 'US');
  expect(fetcher).toHaveBeenCalledTimes(103);
  await catalog.search('extra', 'US');
  expect(fetcher).toHaveBeenCalledTimes(103);
});

it('bounds outstanding distinct requests, allows joining a full queue and releases capacity after completion', async () => {
  const gate = barrier();
  const fetcher = vi.fn(async () => { await gate.promise; return response(); });
  const catalog = new CatalogService(fetcher);
  const requests = Array.from({ length: 32 }, (_, i) => catalog.search(`game${i}`, 'US'));
  const joined = catalog.search('game0', 'US');
  await expect(catalog.search('overflow', 'US')).rejects.toThrow('Too many Store requests');
  expect(fetcher).toHaveBeenCalledTimes(32);
  gate.release();
  await Promise.all([...requests, joined]);
  await catalog.search('overflow', 'US');
  expect(fetcher).toHaveBeenCalledTimes(33);
});
