import type { AccountLibraryPage, CatalogProduct, Game } from '../shared/types';

export interface LibraryFilters {
  kind: AccountLibraryPage['kind'];
  playState: 'all' | 'installed' | 'installable';
  query: string;
  location?: string;
  sort?: 'recent-gamepass';
}
export const defaultLibraryFilters: LibraryFilters = { kind: 'all', playState: 'all', query: '' };

export function libraryProductMatchesPlayState(product: Pick<CatalogProduct, 'installability'>, playState: LibraryFilters['playState']): boolean {
  return playState !== 'installed' && (playState !== 'installable' || product.installability === 'supported');
}
const key = 'xodus-nexus.library-filters.v1';
type Preferences = Pick<Storage, 'getItem' | 'setItem'>;

function normalize(value: unknown): LibraryFilters {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    kind: record.kind === 'owned' || record.kind === 'gamepass' || record.kind === 'other' ? record.kind : 'all',
    playState: record.playState === 'installed' || record.playState === 'installable' ? record.playState : 'all',
    ...(record.playState !== 'installable' && validLocation(record.location) ? {location: validLocation(record.location)} : {}),
    // Search is session-only, including when loading older saved preferences.
    query: '',
    ...(record.kind === 'gamepass' && record.sort === 'recent-gamepass' ? {sort:'recent-gamepass' as const} : {}),
  };
}

/** Electron's local storage is scoped to the launcher profile, not an account. */
export function loadLibraryFilters(storage?: Preferences): LibraryFilters {
  try { return normalize(JSON.parse((storage ?? window.localStorage).getItem(key) ?? 'null')); }
  catch { return { ...defaultLibraryFilters }; }
}

export function saveLibraryFilters(filters: LibraryFilters, storage?: Preferences): boolean {
  try {
    const { kind, playState, sort, location } = normalize(filters);
    (storage ?? window.localStorage).setItem(key, JSON.stringify({ kind, playState, ...(sort ? {sort} : {}), ...(location ? {location} : {}) }));
    return true;
  }
  catch { return false; }
}

/** Merge installed and not-yet-installed cards without overriding the public rank. */
export function rankLibraryRows<T>(rows: readonly T[], ids: readonly string[] | undefined, productId: (row: T) => string | undefined): T[] {
  if (!ids) return [...rows];
  const rank = new Map(ids.map((id,index) => [id,index]));
  return [...rows].sort((a,b) => (rank.get(productId(a) ?? '') ?? ids.length) - (rank.get(productId(b) ?? '') ?? ids.length));
}

function validLocation(value:unknown):string|undefined {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return;
  return value.replace(/\/+$/, '') || '/';
}

/** Group only by recorded installation folders, never infer a drive or volume type. */
export function libraryGameLocation(game:Pick<Game, 'path'>):string|undefined {
  const path = validLocation(game.path);
  if (!path || path === '/') return;
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

export function libraryLocations(games:readonly Pick<Game, 'path'>[], selected?:string):string[] {
  const locations = games.flatMap(game => libraryGameLocation(game) ?? []);
  // A saved folder with no current games stays selectable and honestly empty.
  const saved = validLocation(selected);
  if (saved) locations.push(saved);
  return [...new Set(locations)].sort((a,b) => a.localeCompare(b));
}
