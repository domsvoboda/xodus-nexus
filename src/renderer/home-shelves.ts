import type { DownloadTask, Game } from '../shared/types';

const ACTIVE_DOWNLOAD = new Set<DownloadTask['status']>(['running', 'queued', 'paused']);

function recordedTime(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Complete local games for the Home "Recently installed" shelf.
 *
 * New installations may carry an explicit completion time. Older games have
 * no installation timestamp: their saved `addedAt` (the library entry time) is
 * only an ordering approximation and is never shown as a date. Imports remain
 * visible, incomplete installations and games with an active download are not.
 */
export function recentlyInstalledGames(games: readonly Game[], downloads: readonly DownloadTask[] = []): Game[] {
  const active = new Set<string>();
  for (const task of downloads) {
    if (!ACTIVE_DOWNLOAD.has(task.status) || task.kind === 'content') continue;
    if (task.gameId) active.add(task.gameId);
    if (task.productId) active.add(task.productId.toUpperCase());
  }
  return games
    .map((game, index) => ({ game, index }))
    .filter(({ game }) => game.installState !== 'incomplete'
      && !active.has(game.id)
      && !(game.storeId && active.has(game.storeId.toUpperCase())))
    .map((entry) => ({
      ...entry,
      time: recordedTime(entry.game.installedAt) ?? recordedTime(entry.game.addedAt),
    }))
    .sort((a, b) => {
      if (a.time !== undefined && b.time !== undefined && a.time !== b.time) return b.time - a.time;
      if (a.time !== undefined && b.time === undefined) return -1;
      if (a.time === undefined && b.time !== undefined) return 1;
      return a.index - b.index;
    })
    .map(entry => entry.game);
}
