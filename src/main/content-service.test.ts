import { describe, expect, it, vi } from 'vitest';
import type { Game } from '../shared/types.js';
import { ContentService, type ContentLibrary } from './content-service.js';

const game = { id: 'g', storeId: '9NBLGGH4R315', title: 'Sample', path: '/games/sample' } as Game;
const other = { id: 'h', storeId: '9NFKN8RD4HZ3', title: 'Other', path: '/games/other' } as Game;

function fixture(owned: () => Promise<{ accessByProductId: Record<string, 'owned'> }> = async () => ({ accessByProductId: { '9P1J8S7CCWWT': 'owned' } })) {
  let now = 1_000;
  const library = { select: vi.fn(), access: vi.fn(owned), peekAccess: vi.fn(() => ({})) } satisfies ContentLibrary;
  const discover = vi.fn(async (_game: Game, access: Record<string, string>) => Object.keys(access).length ? ['9P1J8S7CCWWT', '9WZDNCRFJ3TJ'] : ['9WZDNCRFJ3TJ']);
  const service = new ContentService(library, () => ({ relatedProducts: discover }), () => now);
  service.select('player@example.com', '/opt/xodus-cli', 'us');
  return { service, library, discover, advance: (ms: number) => { now += ms; } };
}

describe('ContentService', () => {
  it('discovers once per game and market, then answers from cache until the library TTL', async () => {
    const { service, discover, library, advance } = fixture();
    expect(library.select).toHaveBeenCalledWith('player@example.com', '/opt/xodus-cli', 'us');
    expect(service.cached(game, 'US')).toEqual([]);
    const [a, b] = await Promise.all([service.related(game, 'US'), service.related(game, 'us')]);
    expect(a).toEqual(['9P1J8S7CCWWT', '9WZDNCRFJ3TJ']);
    expect(b).toBe(a);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(discover).toHaveBeenCalledWith(game, { '9P1J8S7CCWWT': 'owned' }, 'US', expect.any(AbortSignal));
    expect(service.cached(game, 'US')).toEqual(a);
    expect(service.cached(other, 'US')).toEqual([]);
    expect(service.cached(game, 'GB')).toEqual([]);
    advance(5 * 60_000 - 1); await service.related(game, 'US'); expect(discover).toHaveBeenCalledTimes(1);
    advance(1); await service.related(game, 'US'); expect(discover).toHaveBeenCalledTimes(2);
  });

  it('reports pending while discovering, then the list, and failed once after an error', async () => {
    const { service, discover } = fixture();
    let release!: (ids: string[]) => void;
    discover.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    expect(service.poll(game, 'US')).toEqual({ state: 'pending' });
    expect(service.poll(game, 'US')).toEqual({ state: 'pending' });
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(1));
    release(['9WZDNCRFJ3TJ']);
    await vi.waitFor(() => expect(service.poll(game, 'US')).toEqual({ state: 'done', ids: ['9WZDNCRFJ3TJ'] }));

    discover.mockRejectedValueOnce(new Error('catalog unreachable'));
    expect(service.poll(other, 'US')).toEqual({ state: 'pending' });
    await vi.waitFor(() => expect(service.poll(other, 'US')).toEqual({ state: 'failed' }));
    expect(service.poll(other, 'US')).toEqual({ state: 'pending' });
  });

  it('works offline from public metadata and drops everything when the account changes', async () => {
    const { service, discover } = fixture(async () => { throw Error('Microsoft account licenses could not be loaded.'); });
    expect(await service.related(game, 'US')).toEqual(['9WZDNCRFJ3TJ']);
    expect(service.cached(game, 'US')).toEqual(['9WZDNCRFJ3TJ']);
    service.select('player@example.com', '/opt/xodus-cli', 'US');
    expect(service.cached(game, 'US')).toEqual(['9WZDNCRFJ3TJ']);

    let release!: (ids: string[]) => void;
    discover.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    service.warm(other, 'US');
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(2));
    service.select('second@example.com', '/opt/xodus-cli', 'US');
    expect(service.cached(game, 'US')).toEqual([]);
    release(['9P1J8S7CCWWT']);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(service.cached(other, 'US')).toEqual([]);
    service.select(undefined, undefined, 'US');
    expect(service.cached(game, 'US')).toEqual([]);
  });
});
