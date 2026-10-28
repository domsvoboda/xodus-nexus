import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyOfflinePermissions, assertOfflineAccessReady, bindOfflineAccess, licenseCacheDirectory, offlineAccessRevoked, revokeOfflineAccess } from './offline-access.js';
import { accountCacheKey, offlineIdentityCacheDirectory } from './offline-identity.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

/** A data root holding one stored license and one runtime identity for `username`. */
async function populated(username = 'one@example.test'): Promise<{ root: string; license: string; identity: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-offline-'));
  roots.push(root);
  const license = path.join(licenseCacheDirectory(root), 'content-a.json');
  await fs.mkdir(path.dirname(license), { recursive: true });
  await fs.writeFile(license, '{}');
  const identity = path.join(offlineIdentityCacheDirectory(path.join(root, 'compatdata', 'game')), accountCacheKey(username), 'identity.txt');
  await fs.mkdir(path.dirname(identity), { recursive: true });
  await fs.writeFile(identity, 'schema=1\n');
  return { root, license, identity };
}
const exists = (file: string) => fs.access(file).then(() => true, () => false);

describe('offline access revocation', () => {
  it('removes every stored license and offline identity when offline play is turned off on this device', async () => {
    const { root, license, identity } = await populated();
    await revokeOfflineAccess(root);
    expect(await exists(license)).toBe(false);
    expect(await exists(identity)).toBe(false);
    // Nothing left to remove is not an error.
    await expect(revokeOfflineAccess(root)).resolves.toBeUndefined();
  });

  it('ends offline play when Microsoft reports this device is not the designated one (A switched to B)', async () => {
    const { root, license, identity } = await populated();
    expect(await applyOfflinePermissions(root, { enabled: true })).toBe(false);
    expect(await exists(license)).toBe(true);
    // Device A reconnects after the designation moved to B: its status now reads enabled: false.
    expect(await applyOfflinePermissions(root, { enabled: false })).toBe(true);
    expect(await exists(license)).toBe(false);
    expect(await exists(identity)).toBe(false);
  });

  it('binds stored offline data to one account and removes it when another account launches', async () => {
    const { root, license, identity } = await populated('one@example.test');
    expect(await bindOfflineAccess(root, 'One@Example.test ')).toBe(false);
    expect(await exists(license)).toBe(true);
    expect(await bindOfflineAccess(root, 'one@example.test')).toBe(false);
    expect(await bindOfflineAccess(root, 'two@example.test')).toBe(true);
    expect(await exists(license)).toBe(false);
    expect(await exists(identity)).toBe(false);
    expect((await fs.readFile(path.join(root, 'offline-owner'), 'utf8')).trim()).toBe(accountCacheKey('two@example.test'));
    // The owner file never holds the username itself.
    expect(await fs.readFile(path.join(root, 'offline-owner'), 'utf8')).not.toContain('example');
  });

  it('records the first owner without removing anything', async () => {
    const { root, license } = await populated();
    await fs.rm(path.join(root, 'offline-owner'), { force: true });
    expect(await bindOfflineAccess(root, 'one@example.test')).toBe(false);
    expect(await exists(license)).toBe(true);
  });

  it('retains a fail-closed marker after cleanup fails and retries before another launch', async () => {
    const { root, license } = await populated();
    const original = fs.rm.bind(fs);
    const failure = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (String(target) === licenseCacheDirectory(root)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return original(target, options);
    });
    try {
      await expect(revokeOfflineAccess(root)).rejects.toThrow('denied');
      expect(await exists(license)).toBe(true);
      expect(await offlineAccessRevoked(root)).toBe(true);
      await expect(assertOfflineAccessReady(root)).rejects.toThrow('revoked');
    } finally { failure.mockRestore(); }
    expect(await bindOfflineAccess(root, 'one@example.test')).toBe(true);
    expect(await exists(license)).toBe(false);
    expect(await offlineAccessRevoked(root)).toBe(false);
    await expect(assertOfflineAccessReady(root)).resolves.toBeUndefined();
  });

  it('does not follow a revocation marker symlink or replace the account after owner-read errors', async () => {
    const { root } = await populated();
    const outside = path.join(root, 'must-stay'); await fs.writeFile(outside, 'unchanged');
    await fs.symlink(outside, path.join(root, 'offline-revoked'));
    await expect(revokeOfflineAccess(root)).rejects.toThrow();
    expect(await fs.readFile(outside, 'utf8')).toBe('unchanged');
    await fs.unlink(path.join(root, 'offline-revoked'));
    await fs.mkdir(path.join(root, 'offline-owner'));
    await expect(bindOfflineAccess(root, 'two@example.test')).rejects.toThrow();
  });
});
