import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { InstallQueue, assertActivityCompatible, assertInstallDestination, canonicalInstallPath, installPathsOverlap } from './install-queue.js';
import type { DownloadTask, GameOperation } from '../shared/types.js';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });

describe('FIFO installations', () => {
  it('holds the next job until cancellation cleanup releases its hold, after full settlement', async () => {
    const queue = new InstallQueue(), process = deferred(), cleanup = deferred(), next = vi.fn(), failed = vi.fn();
    queue.enqueue({ id: 'active', run: async () => { await process.promise; await cleanup.promise; }, failed });
    queue.enqueue({ id: 'next', run: next, failed });
    const release = queue.hold(), settled = vi.fn(); void queue.settled('active').then(settled);
    process.resolve(); await Promise.resolve(); expect(settled).not.toHaveBeenCalled();
    cleanup.resolve(); await vi.waitFor(() => expect(settled).toHaveBeenCalled()); expect(next).not.toHaveBeenCalled();
    release(); release(); await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
  });
  it('settles queued cancellation without starting it and times out without releasing an active job', async () => {
    const queue = new InstallQueue(), process = deferred(), never = vi.fn(), failed = vi.fn();
    queue.enqueue({ id: 'active', run: () => process.promise, failed }); queue.enqueue({ id: 'queued', run: never, failed });
    const queued = queue.settled('queued'); queue.cancel('queued'); await queued; expect(never).not.toHaveBeenCalled();
    await expect(queue.settled('active', 5)).rejects.toThrow('Files were not deleted'); expect(queue.has('active')).toBe(true);
    process.resolve(); await queue.settled('active');
  });
  it('accepts more jobs during a download, starts one process, and waits for cleanup', async () => {
    const queue = new InstallQueue(), first = deferred(), cleanup = deferred(), calls: string[] = [];
    const failed = vi.fn();
    queue.enqueue({ id: 'first', run: async () => { calls.push('first'); await first.promise; await cleanup.promise; }, failed });
    queue.enqueue({ id: 'second', run: async () => { calls.push('second'); }, failed });
    queue.enqueue({ id: 'third', run: async () => { calls.push('third'); }, failed });
    expect(queue.size).toBe(3); expect(calls).toEqual(['first']);
    first.resolve(); await Promise.resolve(); expect(calls).toEqual(['first']);
    cleanup.resolve(); await vi.waitFor(() => expect(queue.size).toBe(0));
    expect(calls).toEqual(['first', 'second', 'third']); expect(failed).not.toHaveBeenCalled();
  });
  it('cancels a waiting job without running it and rejects duplicate IDs', async () => {
    const queue = new InstallQueue(), hold = deferred(), never = vi.fn(), failed = vi.fn();
    queue.enqueue({ id: 'active', run: () => hold.promise, failed });
    queue.enqueue({ id: 'cancelled', run: never, failed });
    expect(() => queue.enqueue({ id: 'active', run: never, failed })).toThrow('already queued');
    expect(queue.cancel('cancelled')).toBe(true); expect(queue.cancel('active')).toBe(false);
    hold.resolve(); await vi.waitFor(() => expect(queue.size).toBe(0)); expect(never).not.toHaveBeenCalled();
  });
  it('persists a failure before advancing to the next installation', async () => {
    const queue = new InstallQueue(), saved = deferred(), calls: string[] = [];
    queue.enqueue({ id: 'bad', run: async () => { throw Error('offline'); }, failed: async () => { calls.push('failure'); await saved.promise; } });
    queue.enqueue({ id: 'good', run: async () => { calls.push('good'); }, failed: vi.fn() });
    await vi.waitFor(() => expect(calls).toEqual(['failure']));
    saved.resolve(); await vi.waitFor(() => expect(calls).toEqual(['failure', 'good']));
  });
  it('never starts queued work after shutdown, even when the active process ends', async () => {
    const queue = new InstallQueue(), hold = deferred(), never = vi.fn(), failed = vi.fn();
    queue.enqueue({ id: 'active', run: () => hold.promise, failed });
    queue.enqueue({ id: 'queued', run: never, failed }); queue.stop(); hold.resolve();
    await vi.waitFor(() => expect(queue.size).toBe(1)); expect(never).not.toHaveBeenCalled();
    expect(() => queue.enqueue({ id: 'new', run: never, failed })).toThrow('closing');
  });
  it('stops rather than starting more downloads if persisting a failure fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const queue = new InstallQueue(), never = vi.fn();
    queue.enqueue({ id: 'bad', run: async () => { throw Error('bad'); }, failed: async () => { throw Error('disk full'); } });
    queue.enqueue({ id: 'next', run: never, failed: vi.fn() });
    await vi.waitFor(() => expect(log).toHaveBeenCalled()); expect(never).not.toHaveBeenCalled(); log.mockRestore();
  });
});

describe('activity guards', () => {
  const downloads = [{ id: 'download', status: 'running' }] as DownloadTask[];
  const game = { id: 'game', kind: 'launch', status: 'running' } as GameOperation;
  it('allows a new install alongside downloads and a running game, but keeps exclusive mutations blocked', () => {
    expect(() => assertActivityCompatible(['download', 'game'], downloads, game, 3, 'install')).not.toThrow();
    expect(() => assertActivityCompatible(['download', 'game'], downloads, game, 3, 'remove')).not.toThrow();
    expect(() => assertActivityCompatible(['download'], downloads, undefined, 2, 'remove')).not.toThrow();
    expect(() => assertActivityCompatible(['download'], downloads, undefined, 2, 'launch')).not.toThrow();
    expect(() => assertActivityCompatible(['download', 'game'], downloads, game, 2)).toThrow();
    expect(() => assertActivityCompatible([], [], undefined, 1)).toThrow();
  });
  it('still blocks a second game, prerequisites, sign-in and unknown processes', () => {
    expect(() => assertActivityCompatible(['game'], [], game, 0, 'launch')).toThrow();
    for (const mode of ['launch', 'install', 'remove'] as const) expect(() => assertActivityCompatible(['auth'], [], undefined, 0, mode)).toThrow();
    for (const status of ['preparing', 'stopping'] as const) expect(() => assertActivityCompatible(['game'], [], { ...game, status }, 0, 'install')).toThrow();
    for (const status of ['preparing', 'stopping'] as const) expect(() => assertActivityCompatible(['game'], [], { ...game, status }, 0, 'remove')).toThrow();
    expect(() => assertActivityCompatible(['game'], [], { ...game, kind: 'prerequisite' }, 0, 'install')).toThrow();
    expect(() => assertActivityCompatible(['game'], [], { ...game, kind: 'prerequisite' }, 0, 'remove')).toThrow();
  });
  it('profile admission permits only known downloads and still rejects foreign operations', () => {
    expect(() => assertActivityCompatible(['download'], downloads, undefined, 3, 'launch')).not.toThrow();
    expect(() => assertActivityCompatible(['download', 'foreign'], downloads, undefined, 3, 'launch')).toThrow('Another Xodus operation is active');
  });
});

describe('installation destination locks', () => {
  it('rejects equal, ancestor and descendant targets without confusing sibling prefixes', () => {
    for (const other of ['/games/title', '/games/title/dlc', '/games', '/']) expect(installPathsOverlap('/games/title', other)).toBe(true);
    expect(installPathsOverlap('/games/title', '/games/title-two')).toBe(false);
  });
  it('resolves symlinked ancestors before protecting new paths', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-queue-')); directories.push(root);
    await fs.mkdir(path.join(root, 'game')); await fs.symlink(path.join(root, 'game'), path.join(root, 'alias'));
    expect(await canonicalInstallPath(path.join(root, 'alias', 'new'))).toBe(path.join(root, 'game', 'new'));
    await expect(assertInstallDestination(path.join(root, 'alias', 'new'), [path.join(root, 'game')])).rejects.toThrow('overlaps');
    expect(await assertInstallDestination(path.join(root, 'other'), [path.join(root, 'game')])).toBe(path.join(root, 'other'));
    await expect(canonicalInstallPath('relative')).rejects.toThrow('absolute');
  });

  it('reserves future paths behind dangling relative and chained symlinks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-queue-link-')); directories.push(root);
    await fs.mkdir(path.join(root, 'game'));
    await fs.symlink('game/future', path.join(root, 'alias'));
    await fs.symlink('alias', path.join(root, 'chained'));
    expect(await canonicalInstallPath(path.join(root, 'chained', 'content'))).toBe(path.join(root, 'game/future/content'));
    await expect(assertInstallDestination(path.join(root, 'alias', 'content'), [path.join(root, 'game')])).rejects.toThrow('overlaps');
    await fs.symlink('loop', path.join(root, 'loop'));
    await expect(canonicalInstallPath(path.join(root, 'loop', 'content'))).rejects.toThrow();
  });
});
