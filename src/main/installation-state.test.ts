import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { hasIncompleteUpdate, INCOMPLETE_UPDATE_MARKER } from './installation-state.js';
import { inspectGameDirectory, StateStore } from './store.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-update-state-')); roots.push(root);
  await fs.writeFile(path.join(root, 'MicrosoftGame.config'), '<Game><Identity Name="Fixture" Version="1.0.0.0"/><ExecutableList><Executable Name="Game.exe"/></ExecutableList><StoreId>9AAAAAAAAAAA</StoreId></Game>');
  await fs.writeFile(path.join(root, 'Game.exe'), 'MZ fixture');
  await fs.writeFile(path.join(root, '.xodus-streaming.msixvc'), 'old package metadata');
  return root;
}

it('uses the durable disk barrier rather than final-container presence or a saved ready flag', async () => {
  const root = await fixture();
  expect((await inspectGameDirectory(root)).installState).toBe('ready');
  await fs.writeFile(path.join(root, INCOMPLETE_UPDATE_MARKER), '');
  const blocked = await inspectGameDirectory(root);
  expect(blocked).toMatchObject({ installState: 'incomplete', updateIncomplete: true });
  expect(blocked.installMessage).toContain('Resume the update');
  const store = new StateStore(path.join(root, 'profile')); await store.upsertGame(blocked);
  await fs.unlink(path.join(root, INCOMPLETE_UPDATE_MARKER));
  await store.upsertGame(await inspectGameDirectory(root));
  expect(store.games[0].updateIncomplete).toBeUndefined();
  expect(store.games[0].installState).toBe('ready');
});

it('fails closed on an unreadable update state instead of pretending that the marker is absent', async () => {
  const read = vi.spyOn(fs, 'lstat').mockRejectedValueOnce(Object.assign(Error('private path'), { code: 'EACCES' }));
  try { await expect(hasIncompleteUpdate('/synthetic')).rejects.toThrow('update state could not be checked'); }
  finally { read.mockRestore(); }
});

it('treats malformed, directory and dangling symlink barriers as incomplete without following them', async () => {
  const root = await fixture(), marker = path.join(root, INCOMPLETE_UPDATE_MARKER);
  for (const kind of ['file', 'directory', 'symlink']) {
    if (kind === 'file') await fs.writeFile(marker, 'not JSON');
    else if (kind === 'directory') await fs.mkdir(marker);
    else await fs.symlink(path.join(root, 'missing-target'), marker);
    expect(await hasIncompleteUpdate(root)).toBe(true);
    expect((await inspectGameDirectory(root)).installState).toBe('incomplete');
    if (kind === 'directory') await fs.rmdir(marker); else await fs.unlink(marker);
  }
  expect(await hasIncompleteUpdate(root)).toBe(false);
});
