import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * The runtime keeps the last signed-in Xbox identity per game prefix so titles
 * can sign in while Microsoft is unreachable. It files that cache under an
 * opaque account key the launcher passes as XODUS_ACCOUNT_HASH, so one
 * account never reuses another's identity, and the launcher removes every
 * cache on sign-out.
 */

/** Opaque, stable key for the signed-in account: a SHA-256 prefix of its username. */
export function accountCacheKey(username: string): string {
  return createHash('sha256').update(username.trim().toLowerCase()).digest('hex').slice(0, 32);
}

/** Where a game prefix keeps its offline identity caches (all accounts). */
export function offlineIdentityCacheDirectory(compatibilityDataPath: string): string {
  return path.join(compatibilityDataPath, 'pfx', 'drive_c', 'users', 'steamuser', 'AppData', 'Local', 'Xodus Nexus', 'offline-identity');
}

/** Removes the offline identity caches of every game prefix under `dataRoot`. */
export async function removeOfflineIdentityCaches(dataRoot: string): Promise<number> {
  const compatRoot = path.join(dataRoot, 'compatdata');
  let entries: string[] = [];
  try { entries = await fs.readdir(compatRoot); } catch { return 0; }
  let removed = 0;
  for (const entry of entries) {
    const directory = offlineIdentityCacheDirectory(path.join(compatRoot, entry));
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      await fs.rm(directory, { recursive: true, force: true });
      removed++;
    } catch { /* no cache in this prefix */ }
  }
  return removed;
}
