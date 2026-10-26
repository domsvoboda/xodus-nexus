import { expect, it } from 'vitest';
import { defaultLibraryFilters, loadLibraryFilters, saveLibraryFilters, libraryProductMatchesPlayState, rankLibraryRows } from './library-preferences';

it.each(['supported', 'unsupported', 'unknown'] as const)('Ready to install only includes supported packages (%s)', installability => {
  expect(libraryProductMatchesPlayState({ installability }, 'all')).toBe(true);
  expect(libraryProductMatchesPlayState({ installability }, 'installed')).toBe(false);
  expect(libraryProductMatchesPlayState({ installability }, 'installable')).toBe(installability === 'supported');
});

it('restores access and play state but clears search after recreating the UI', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  expect(loadLibraryFilters(storage)).toEqual(defaultLibraryFilters);
  const filters = { kind: 'gamepass' as const, playState: 'installed' as const, query: 'Fallout' };
  expect(saveLibraryFilters(filters, storage)).toBe(true);
  expect(loadLibraryFilters({ ...storage })).toEqual({ ...filters, query: '' });
  expect([...values.values()].map((value) => JSON.parse(value))).toEqual([{ kind: 'gamepass', playState: 'installed' }]);
  expect(filters.query).toBe('Fallout');
});

it('ignores search saved by older versions without losing the other filters', () => {
  const storage = {
    getItem: () => JSON.stringify({ kind: 'owned', playState: 'installable', query: 'Fallout' }),
    setItem: () => {},
  };
  expect(loadLibraryFilters(storage)).toEqual({ kind: 'owned', playState: 'installable', query: '' });
});

it('recovers from corrupt or unavailable storage without preventing startup', () => {
  for (const raw of ['{broken', '[]', 'null', '{"kind":"wrong","playState":"wrong","query":42}']) {
    expect(loadLibraryFilters({ getItem: () => raw, setItem: () => {} })).toEqual(defaultLibraryFilters);
  }
  const unavailable = { getItem: (): string => { throw Error('Unavailable'); }, setItem: () => { throw Error('Unavailable'); } };
  expect(loadLibraryFilters(unavailable)).toEqual(defaultLibraryFilters);
  expect(saveLibraryFilters(defaultLibraryFilters, unavailable)).toBe(false);
  expect(loadLibraryFilters({ getItem: () => JSON.stringify({ query: 'x'.repeat(1000) }), setItem: () => {} }).query).toBe('');
});

it('persists the explicit Game Pass order but never a query, foreign order or order on another access filter',()=>{
 let raw='';const storage={getItem:()=>raw,setItem:(_key:string,value:string)=>{raw=value;}};
 const filters={...defaultLibraryFilters,kind:'gamepass' as const,sort:'recent-gamepass' as const,query:'PRIVATE_SEARCH'};
 saveLibraryFilters(filters,storage);expect(raw).not.toContain('PRIVATE_SEARCH');
 expect(loadLibraryFilters(storage)).toEqual({...filters,query:''});
 for(const kind of ['owned','all','other']){raw=JSON.stringify({...filters,kind});expect(loadLibraryFilters(storage).sort).toBeUndefined();}
 raw=JSON.stringify({...filters,sort:'foreign'});expect(loadLibraryFilters(storage).sort).toBeUndefined();
});
it('puts ranked installed and available games together without mutating cards or reordering unranked games',()=>{
 const rows=[{id:'old-installed'},{id:'new-available'},{id:'old-available'},{id:'new-installed'}];
 const ranked=rankLibraryRows(rows,['new-installed','new-available'],row=>row.id);
 expect(ranked.map(row=>row.id)).toEqual(['new-installed','new-available','old-installed','old-available']);
 expect(rows.map(row=>row.id)).toEqual(['old-installed','new-available','old-available','new-installed']);
 expect(rankLibraryRows(rows,undefined,row=>row.id)).toEqual(rows);
});
