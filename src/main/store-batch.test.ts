import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { StateStore } from './store.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function library(count = 2) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'nexus-batch-'));
  directories.push(directory);
  const file = path.join(directory, 'launcher-state.json');
  await fs.writeFile(file, JSON.stringify({ games: Array.from({ length: count }, (_, i) => ({
    id: String(i), title: `Game ${i}`, path: `/synthetic/${i}`, installState: 'ready',
    addedAt: '2026-01-01T00:00:00Z', coverDataUrl: 'x'.repeat(32768),
  })) }));
  const store = new StateStore(directory);
  await store.load();
  return { store, file, directory };
}

it('persists a hundred metadata changes with one full-state write', async () => {
  const { store, directory } = await library(100);
  const writes = vi.spyOn(fs, 'writeFile');
  const renames = vi.spyOn(fs, 'rename');
  await store.patchGames(store.games.map(game => ({ id: game.id, patch: { publisher: `Publisher ${game.id}` } })));
  expect(writes).toHaveBeenCalledTimes(1);
  expect(renames).toHaveBeenCalledTimes(1);
  expect(Buffer.byteLength(String(writes.mock.calls[0][1]))).toBeLessThan(3_400_000);
  const reopened = new StateStore(directory);
  await reopened.load();
  expect(reopened.games).toHaveLength(100);
  for (const game of reopened.games) expect(game.publisher).toBe(`Publisher ${game.id}`);
});

it('rejects an invalid batch before changing any entry or the saved state', async () => {
  const { store, file } = await library();
  const before = await fs.readFile(file, 'utf8');
  const writes = vi.spyOn(fs, 'writeFile');
  await expect(store.patchGames([
    { id: '0', patch: { publisher: 'changed' } }, { id: 'removed', patch: { publisher: 'missing' } },
  ])).rejects.toThrow('Game not found');
  expect(store.games[0].publisher).toBeUndefined();
  expect(writes).not.toHaveBeenCalled();
  expect(await fs.readFile(file, 'utf8')).toBe(before);
});

it.each(['writeFile', 'rename'] as const)('propagates %s failure and retries identical metadata without discarding the old file', async operation => {
  const { store, file, directory } = await library();
  const before = await fs.readFile(file, 'utf8');
  const fault = vi.spyOn(fs, operation).mockRejectedValueOnce(Object.assign(new Error('disk fault'), { code: 'EIO' }));
  const batch = [{ id: '0', patch: { publisher: 'updated' } }];
  await expect(store.patchGames(batch)).rejects.toThrow('disk fault');
  expect(await fs.readFile(file, 'utf8')).toBe(before);
  await store.patchGames(batch);
  expect(fault).toHaveBeenCalledTimes(2);
  const reopened = new StateStore(directory);
  await reopened.load();
  expect(reopened.games[0].publisher).toBe('updated');
});

it('keeps ordered writes with settings and makes an empty batch a no-op', async () => {
  const { store, directory } = await library();
  const writes = vi.spyOn(fs, 'writeFile');
  await store.patchGames([]);
  expect(writes).not.toHaveBeenCalled();
  await Promise.all([
    store.patchGames([{ id: '0', patch: { publisher: 'updated' } }]),
    store.setSettings({ closeToTray: true }),
    store.patchGame('1', { publisher: 'individual' }),
  ]);
  expect(writes).toHaveBeenCalledTimes(3);
  const reopened = new StateStore(directory);
  await reopened.load();
  expect(reopened.settings.closeToTray).toBe(true);
  expect(reopened.games.map(game => game.publisher)).toEqual(['updated', 'individual']);
});
