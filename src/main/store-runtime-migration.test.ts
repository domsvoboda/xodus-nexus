import { expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from './store';
import { resolveGameRuntime } from './runtime-prefix-binding';

async function legacyCachy(root: string) {
  const runtimeRoot = path.join(root, 'runtimes');
  const commit = 'a'.repeat(40), hint = commit.slice(0, 8);
  const name = `nexus-runtime-cachyos-11.0-experimental-g${hint}`;
  const tag = `runtime-cachyos-11.0-20261108-g${hint}`;
  const release = path.join(runtimeRoot, 'releases', name);
  const wine = path.join(release, 'files/bin/wine');
  await fs.mkdir(path.dirname(wine), { recursive: true });
  await fs.writeFile(wine, 'verified legacy cachy runner', { mode: 0o755 });
  await fs.writeFile(path.join(release, 'XODUS_NEXUS_PATCH.json'), JSON.stringify({
    schema: 1, sourceLockSha256: 'b'.repeat(64), sourceGraph: { proton: commit }, variant: { family: 'nexus-cachyos' },
  }));
  const pointer = { name, commit: tag, winePath: wine, sourceRepository: 'domsvoboda/nexus-runtime-cachyos', prerelease: false, candidateSha256: 'c'.repeat(64) };
  await fs.writeFile(path.join(runtimeRoot, 'current.json'), JSON.stringify(pointer));
  return { runtimeRoot, wine, pointerBytes: JSON.stringify(pointer) };
}

const game = (id: string, runtime?: 'default' | 'nexus' | 'nexus-cachyos') => ({ id, path: `/games/${id}`, title: id, installState: 'ready' as const, addedAt: '2026-01-01', ...(runtime === undefined ? {} : { runtime }) });

it('preserves the effective legacy CachyOS choice once, then leaves new unconfigured games on Standard', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-migration-'));
  const profile = path.join(root, 'profile'), cachy = await legacyCachy(root);
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(profile, 'launcher-state.json'), JSON.stringify({
    games: [game('default'), game('explicit-default', 'default'), game('explicit-nexus', 'nexus'), game('explicit-cachy', 'nexus-cachyos')],
    downloads: [],
    settings: { installRoot: '/games', winePath: cachy.wine, runtimeRoot: cachy.runtimeRoot },
  }));
  const store = new StateStore(profile); await store.load();
  expect(store.games.map(row => row.runtime)).toEqual(['nexus-cachyos', 'nexus-cachyos', 'nexus', 'nexus-cachyos']);
  const persisted = JSON.parse(await fs.readFile(path.join(profile, 'launcher-state.json'), 'utf8'));
  expect(persisted.runtimeFamilyMigration).toBe(1);
  expect(persisted.games.map((row: { runtime?: string }) => row.runtime)).toEqual(['nexus-cachyos', 'nexus-cachyos', 'nexus', 'nexus-cachyos']);
  expect(await fs.readFile(path.join(cachy.runtimeRoot, 'current.json'), 'utf8')).toBe(cachy.pointerBytes);

  const migrated = await resolveGameRuntime({
    runtimeRoot: cachy.runtimeRoot, dataRoot: root, defaultWine: cachy.wine, arch: 'x64', gameId: 'default', selection: 'nexus-cachyos',
  });
  expect(migrated.winePath).toBe(cachy.wine);
  expect(migrated.managed).toBeUndefined();

  await store.upsertGame(game('new-after-migration'));
  const reloaded = new StateStore(profile); await reloaded.load();
  expect(reloaded.games.find(row => row.id === 'new-after-migration')?.runtime).toBeUndefined();
  expect(reloaded.games.find(row => row.id === 'default')?.runtime).toBe('nexus-cachyos');
  expect(reloaded.games.find(row => row.id === 'explicit-nexus')?.runtime).toBe('nexus');
  await expect(resolveGameRuntime({
    runtimeRoot: cachy.runtimeRoot, dataRoot: root, defaultWine: cachy.wine, arch: 'x64', gameId: 'new-after-migration', selection: undefined,
  })).rejects.toThrow('Install the Standard runtime');
});

it('does not migrate when the legacy global pointer is not verified CachyOS', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-migration-none-'));
  const profile = path.join(root, 'profile'), runtimeRoot = path.join(root, 'runtimes');
  await fs.mkdir(profile, { recursive: true }); await fs.mkdir(runtimeRoot, { recursive: true });
  await fs.writeFile(path.join(profile, 'launcher-state.json'), JSON.stringify({
    games: [game('default')], downloads: [], settings: { installRoot: '/games', winePath: '', runtimeRoot },
  }));
  const store = new StateStore(profile); await store.load();
  expect(store.games[0].runtime).toBeUndefined();
});

it('does not migrate an existing verified global Standard runtime', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-migration-standard-'));
  const profile = path.join(root, 'profile'), runtimeRoot = path.join(root, 'runtimes');
  const commit = 'd'.repeat(40), hint = commit.slice(0, 8);
  const name = `nexus-runtime-11.0-experimental-g${hint}`, release = path.join(runtimeRoot, 'releases', name);
  const wine = path.join(release, 'files/bin/wine');
  await fs.mkdir(path.dirname(wine), { recursive: true }); await fs.writeFile(wine, 'verified legacy standard runner', { mode: 0o755 });
  await fs.writeFile(path.join(release, 'XODUS_NEXUS_PATCH.json'), JSON.stringify({
    schema: 1, sourceLockSha256: 'e'.repeat(64), sourceGraph: { proton: commit }, variant: { family: 'nexus' },
  }));
  await fs.writeFile(path.join(runtimeRoot, 'current.json'), JSON.stringify({
    name, commit: `runtime-11.0-20261108-g${hint}`, winePath: wine, sourceRepository: 'domsvoboda/nexus-runtime', prerelease: false,
  }));
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(profile, 'launcher-state.json'), JSON.stringify({
    games: [game('default')], downloads: [], settings: { installRoot: '/games', winePath: wine, runtimeRoot },
  }));
  const store = new StateStore(profile); await store.load();
  expect(store.games[0].runtime).toBeUndefined();
  const persisted = JSON.parse(await fs.readFile(path.join(profile, 'launcher-state.json'), 'utf8'));
  expect(persisted.games[0].runtime).toBeUndefined();
});
