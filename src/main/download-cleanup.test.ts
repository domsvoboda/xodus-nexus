import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DownloadTask } from '../shared/types';
import { DownloadCleanup } from './download-cleanup';

let root: string, state: string, task: DownloadTask, cleanup: DownloadCleanup;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-cancel-fixture-')); state = path.join(root, 'profile');
  task = { id: randomUUID(), kind: 'install', productId: 'SAMPLE', title: 'Fixture', destination: path.join(root, 'new-install'), status: 'running', phase: '', log: [], progress: null, startedAt: '' };
  cleanup = new DownloadCleanup(state);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const available = () => cleanup.options(task, [], [state]);
async function partial() { await cleanup.prepare(task); await fs.writeFile(path.join(task.destination, 'partial.bin'), 'disposable download'); }

it('deletes only its proven new folder, preserving existing games and saves alongside it', async () => {
  const game = path.join(root, 'existing-game'); await fs.mkdir(game); await fs.writeFile(path.join(game, 'save'), 'keep');
  await partial(); expect((await available()).deleteFilesAllowed).toBe(true);
  await cleanup.remove(task, [game], [state]);
  await expect(fs.access(task.destination)).rejects.toThrow(); expect(await fs.readFile(path.join(game, 'save'), 'utf8')).toBe('keep');
});
it.each([false, true])('never claims a pre-existing folder (with files: %s)', async populated => {
  await fs.mkdir(task.destination); if (populated) await fs.writeFile(path.join(task.destination, 'original'), 'keep');
  await cleanup.prepare(task); expect((await available()).deleteFilesAllowed).toBe(false);
  await expect(cleanup.remove(task, [], [])).rejects.toThrow('Existing or untracked');
  expect(await fs.readdir(task.destination)).toEqual(populated ? ['original'] : []);
});
it.each(['update', 'content', undefined] as const)('refuses %s even with a valid ownership record', async kind => {
  await partial(); task.kind = kind;
  expect((await available()).deleteFilesAllowed).toBe(false); await expect(cleanup.remove(task, [], [])).rejects.toThrow('Updates and DLC');
  expect(await fs.readFile(path.join(task.destination, 'partial.bin'), 'utf8')).toBe('disposable download');
});
it('rejects parent game IDs, completed tasks and identity or product mismatches', async () => {
  await partial();
  for (const patch of [{ gameId: 'existing' }, { status: 'complete' }, { id: randomUUID() }, { productId: 'OTHER' }, { destination: root }]) {
    expect((await cleanup.options({ ...task, ...patch } as DownloadTask, [], [])).deleteFilesAllowed).toBe(false);
  }
});
it('retains proof across launcher restarts but never trusts task flags', async () => {
  await partial(); cleanup = new DownloadCleanup(state); expect((await available()).deleteFilesAllowed).toBe(true);
  await cleanup.complete(task); expect((await available()).deleteFilesAllowed).toBe(false);
  expect(await fs.readdir(task.destination)).toEqual(['partial.bin']);
});
it('retains proven folder ownership for the exact resumed package under a new queue ID', async () => {
  await partial();task.status='paused';task.selectedContentId=randomUUID();task.selectionMarket='US';
  const resumed={...task,id:randomUUID(),status:'queued' as const};
  cleanup=new DownloadCleanup(state);
  expect((await cleanup.options(task,[],[state])).deleteFilesAllowed).toBe(true);
  await cleanup.inheritResume(task,resumed);
  await cleanup.prepare(resumed);
  expect((await cleanup.options(resumed,[],[state])).deleteFilesAllowed).toBe(true);
  await cleanup.remove(resumed,[],[state]);
  await expect(fs.access(task.destination)).rejects.toThrow();
});
it('does not transfer ownership to a different package, destination, market or update/content task',async()=>{
  await partial();task.status='paused';task.selectedContentId=randomUUID();task.selectionMarket='US';
  for(const change of [{productId:'DIFFERENT'},{selectedContentId:randomUUID()},{selectionMarket:'DE'},
    {destination:path.join(root,'other')},{kind:'update' as const},{kind:'content' as const},{gameId:'existing'}]){
    const resumed={...task,id:randomUUID(),status:'queued' as const,...change};
    await cleanup.inheritResume(task,resumed);
    expect((await cleanup.options(resumed,[],[state])).deleteFilesAllowed).toBe(false);
  }
  expect((await available()).deleteFilesAllowed).toBe(true);
  expect(await fs.readFile(path.join(task.destination,'partial.bin'),'utf8')).toBe('disposable download');
});
it('never grants resume ownership to pre-existing/untracked, completed or replaced directories',async()=>{
  await partial();task.status='paused';
  const resumed=()=>({...task,id:randomUUID(),status:'queued' as const});
  const original=path.join(root,'old-owned');await fs.rename(task.destination,original);await fs.mkdir(task.destination);
  const replaced=resumed();await cleanup.inheritResume(task,replaced);
  expect((await cleanup.options(replaced,[],[state])).deleteFilesAllowed).toBe(false);
  await fs.rmdir(task.destination);await fs.rename(original,task.destination);
  const completed={...task,status:'complete' as const},next=resumed();await cleanup.inheritResume(completed,next);
  expect((await cleanup.options(next,[],[state])).deleteFilesAllowed).toBe(false);
  await cleanup.complete(task);
  const untracked=resumed();await cleanup.inheritResume(task,untracked);
  expect((await cleanup.options(untracked,[],[state])).deleteFilesAllowed).toBe(false);
});
it.each(['directory', 'symlink', 'file', 'missing'])('rejects a %s replacement without touching the old folder or a linked game', async replacement => {
  await partial(); const original = path.join(root, 'original'); await fs.rename(task.destination, original);
  if (replacement === 'directory') await fs.mkdir(task.destination);
  if (replacement === 'symlink') await fs.symlink(original, task.destination);
  if (replacement === 'file') await fs.writeFile(task.destination, 'keep');
  await expect(cleanup.remove(task, [], [])).rejects.toThrow(); expect(await fs.readFile(path.join(original, 'partial.bin'), 'utf8')).toBe('disposable download');
});
it('rejects a symlinked ancestor, overlaps, aliases and protected roots', async () => {
  await partial(); const alias = path.join(root, 'alias'); await fs.symlink(task.destination, alias);
  for (const locked of [root, task.destination, alias, path.join(task.destination, 'nested')]) expect((await cleanup.options(task, [locked], [])).deleteFilesAllowed).toBe(false);
  expect((await cleanup.options(task, [], [task.destination])).deleteFilesAllowed).toBe(false);
  const moved = root + '-moved'; await fs.rename(root, moved); await fs.symlink(moved, root);
  try { await expect(cleanup.remove(task, [], [])).rejects.toThrow(); } finally { await fs.unlink(root); await fs.rename(moved, root); }
});
it.each(['changed', 'missing', 'symlink'])('does not trust a %s ownership marker', async mode => {
  await partial(); const name = (await fs.readdir(task.destination)).find(name => name.startsWith('.nexus-download-'))!, marker = path.join(task.destination, name);
  await fs.unlink(marker);
  if (mode === 'changed') await fs.writeFile(marker, 'wrong');
  if (mode === 'symlink') await fs.symlink(path.join(task.destination, 'partial.bin'), marker);
  await expect(cleanup.remove(task, [], [])).rejects.toThrow(); expect(await fs.readFile(path.join(task.destination, 'partial.bin'), 'utf8')).toBe('disposable download');
});
it('refuses symlinked private proof and ownership directories', async () => {
  await partial(); const record = path.join(state, 'download-ownership', task.id + '.json');
  const outside = path.join(root, 'proof-copy'); await fs.rename(record, outside); await fs.symlink(outside, record);
  expect((await available()).deleteFilesAllowed).toBe(false);
  await fs.unlink(record); await fs.rename(outside, record);
  const directory = path.join(state, 'download-ownership'); await fs.rename(directory, directory + '-moved'); await fs.symlink(directory + '-moved', directory);
  expect((await available()).deleteFilesAllowed).toBe(false);
});
it('preserves a new folder containing an unsafe link, including the linked save target', async () => {
  await partial(); const outside = path.join(root, 'outside-save'); await fs.writeFile(outside, 'keep'); await fs.symlink(outside, path.join(task.destination, 'link'));
  await expect(cleanup.remove(task, [], [])).rejects.toThrow('Files were not deleted');
  expect(await fs.readFile(outside, 'utf8')).toBe('keep'); expect(await fs.readFile(path.join(task.destination, 'partial.bin'), 'utf8')).toBe('disposable download');
});
it('rejects same-device bind mounts before deleting any files', async () => {
  await partial(); const remove = vi.fn(async () => {});
  cleanup = new DownloadCleanup(state, remove, async () => {
    const temporary = (await fs.readdir(root)).find(name => name.startsWith('.nexus-cancel-'))!;
    return `1 2 0:1 / ${path.join(root, temporary, 'files', 'bind')} rw - tmpfs tmpfs rw`;
  });
  await expect(cleanup.remove(task, [], [])).rejects.toThrow('mounted filesystem'); expect(remove).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(task.destination, 'partial.bin'), 'utf8')).toBe('disposable download');
});
it('reports partial cleanup and restores remaining files without deleting another folder', async () => {
  await partial(); await fs.writeFile(path.join(task.destination, 'remaining'), 'keep');
  cleanup = new DownloadCleanup(state, async directory => { await fs.unlink(path.join(directory, 'partial.bin')); throw Error('Synthetic disk failure'); });
  await expect(cleanup.remove(task, [], [])).rejects.toThrow('some downloaded files may already have been deleted');
  expect(await fs.readFile(path.join(task.destination, 'remaining'), 'utf8')).toBe('keep');
});
it('revalidates the atomically moved directory before deletion if the source was replaced during cancellation', async () => {
  await partial(); const rename = fs.rename.bind(fs), original = path.join(root, 'original-owned'), remove = vi.fn(async () => {}); let replaced = false;
  const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (!replaced && String(from).endsWith('/new-install') && String(to).endsWith('/files')) {
      replaced = true; await rename(task.destination, original); await fs.mkdir(task.destination); await fs.writeFile(path.join(task.destination, 'existing-game'), 'keep');
    }
    await rename(from, to);
  });
  try {
    cleanup = new DownloadCleanup(state, remove); await expect(cleanup.remove(task, [], [])).rejects.toThrow('Files were not deleted');
    expect(remove).not.toHaveBeenCalled(); expect(await fs.readFile(path.join(task.destination, 'existing-game'), 'utf8')).toBe('keep');
    expect(await fs.readFile(path.join(original, 'partial.bin'), 'utf8')).toBe('disposable download');
  } finally { spy.mockRestore(); }
});
it('never overwrites a replacement at the original path when cleanup fails', async () => {
  await partial(); cleanup = new DownloadCleanup(state, async () => {
    await fs.mkdir(task.destination); await fs.writeFile(path.join(task.destination, 'existing-game'), 'keep'); throw Error('Synthetic failure');
  });
  await expect(cleanup.remove(task, [], [])).rejects.toThrow('Remaining files are preserved at');
  expect(await fs.readFile(path.join(task.destination, 'existing-game'), 'utf8')).toBe('keep');
  const quarantine = (await fs.readdir(root)).find(name => name.startsWith('.nexus-cancel-'))!;
  expect(await fs.readFile(path.join(root, quarantine, 'files', 'partial.bin'), 'utf8')).toBe('disposable download');
});
