import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { OfflinePermissions } from '../shared/types.js';
import { accountCacheKey, removeOfflineIdentityCaches } from './offline-identity.js';

/**
 * Offline play on this device is bounded by what Microsoft last said: the
 * stored licenses (backend `run --license-cache`) and the runtime's offline
 * identities exist only while this device is the account's designated offline
 * PC and only for the account that stored them. Every known change of either
 * removes all of them; Microsoft's own lease restrictions are validated again
 * by the backend each time a stored license is loaded.
 */

/** Where `xodus-cli run --license-cache` keeps device-bound offline licenses. */
export function licenseCacheDirectory(dataRoot: string): string {
  return path.join(dataRoot, 'license-cache');
}

/** The opaque key of the account the stored offline data belongs to. */
function ownerFile(dataRoot: string): string {
  return path.join(dataRoot, 'offline-owner');
}

export type OfflineRevocation = 'sign-out' | 'account-changed' | 'designation-off' | 'designation-changed';

const revokedFile = (dataRoot: string) => path.join(dataRoot, 'offline-revoked');

/** A failed cleanup must remain fail-closed across launcher restarts. */
export async function offlineAccessRevoked(dataRoot: string): Promise<boolean> {
  try { await fs.lstat(revokedFile(dataRoot)); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export async function assertOfflineAccessReady(dataRoot: string): Promise<void> {
  if (await offlineAccessRevoked(dataRoot)) throw new Error('Offline access was revoked. Reconnect and try again after the stored licenses can be removed.');
}

/** Removes every stored offline license and offline identity under `dataRoot`. */
export async function revokeOfflineAccess(dataRoot: string): Promise<void> {
  await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
  // A fixed non-secret marker is durable before touching any stored license.
  const marker = await fs.open(revokedFile(dataRoot), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await marker.writeFile('revoked\n'); await marker.sync(); } finally { await marker.close(); }
  await fs.rm(licenseCacheDirectory(dataRoot), { recursive: true, force: true });
  await removeOfflineIdentityCaches(dataRoot);
  await fs.rm(ownerFile(dataRoot), { force: true });
  await fs.rm(revokedFile(dataRoot), { force: true });
}

/**
 * Binds stored offline data to the signed-in account before a launch. Data
 * another account left behind (a sign-in outside the launcher, or a sign-out
 * whose cleanup failed) is removed first. Returns whether anything was revoked.
 */
export async function bindOfflineAccess(dataRoot: string, username: string): Promise<boolean> {
  if (!username.trim()) throw new Error('Sign in before enabling offline access.');
  const pendingRevocation = await offlineAccessRevoked(dataRoot);
  if (pendingRevocation) await revokeOfflineAccess(dataRoot);
  const key = accountCacheKey(username);
  let owner: string | undefined;
  try { owner = (await fs.readFile(ownerFile(dataRoot), 'utf8')).trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const changed = owner !== undefined && owner !== key;
  if (changed) await revokeOfflineAccess(dataRoot);
  if (owner !== key) {
    await fs.mkdir(dataRoot, { recursive: true });
    const temporary = ownerFile(dataRoot) + '.' + randomUUID();
    try {
      await fs.writeFile(temporary, `${key}\n`, { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, ownerFile(dataRoot));
    } finally { await fs.rm(temporary, { force: true }); }
  }
  return changed || pendingRevocation;
}

/** A designation status Microsoft reported: anything but "on" ends offline play here. */
export async function applyOfflinePermissions(dataRoot: string, status: Pick<OfflinePermissions, 'enabled'>): Promise<boolean> {
  if (status.enabled) return false;
  await revokeOfflineAccess(dataRoot);
  return true;
}
