import { mkdir, mkdtemp, rm, writeFile, access, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { accountCacheKey, offlineIdentityCacheDirectory, removeOfflineIdentityCaches } from './offline-identity.js';

describe('offline identity caches', () => {
  const created: string[] = [];
  afterEach(async () => { for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true }); });

  it('derives an opaque, case-insensitive account key', () => {
    expect(accountCacheKey('Player@example.com')).toBe(accountCacheKey(' player@example.com '));
    expect(accountCacheKey('a@example.com')).not.toBe(accountCacheKey('b@example.com'));
    expect(accountCacheKey('a@example.com')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('removes every prefix cache on sign-out and leaves the rest of the prefix alone', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xodus-nexus-identity-'));
    created.push(root);
    const game = path.join(root, 'compatdata', 'game-a');
    const cache = offlineIdentityCacheDirectory(game);
    await mkdir(path.join(cache, accountCacheKey('a@example.com')), { recursive: true });
    await writeFile(path.join(cache, accountCacheKey('a@example.com'), 'identity.txt'), 'schema=1\n');
    const saves = path.join(game, 'pfx', 'drive_c', 'users', 'steamuser', 'AppData', 'Local', 'XodusGameSave', 'blob');
    await mkdir(path.dirname(saves), { recursive: true });
    await writeFile(saves, 'save data');
    await mkdir(path.join(root, 'compatdata', 'game-b', 'pfx'), { recursive: true });
    expect(await removeOfflineIdentityCaches(root)).toBe(1);
    await expect(access(cache)).rejects.toThrow();
    await expect(access(saves)).resolves.toBeUndefined();
    expect(await removeOfflineIdentityCaches(root)).toBe(0);
    expect(await removeOfflineIdentityCaches(path.join(root, 'missing'))).toBe(0);
  });

  it('never traverses a prefix or intermediate symlink into another installation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nexus-identity-links-')); created.push(root);
    const outside = await mkdtemp(path.join(tmpdir(), 'nexus-identity-outside-')); created.push(outside);
    const cache = offlineIdentityCacheDirectory(outside);
    await mkdir(cache, { recursive: true }); await writeFile(path.join(cache, 'identity.txt'), 'keep');
    await mkdir(path.join(root, 'compatdata'));
    await symlink(outside, path.join(root, 'compatdata', 'game-a'));
    const other = path.join(root, 'compatdata', 'game-b'); await mkdir(other);
    await symlink(path.join(outside, 'pfx'), path.join(other, 'pfx'));
    expect(await removeOfflineIdentityCaches(root)).toBe(0);
    expect(await readFile(path.join(cache, 'identity.txt'), 'utf8')).toBe('keep');
  });
});
