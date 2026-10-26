import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Read the target filesystem, including an existing symlinked ancestor. No mkdir or writes. */
export async function availableInstallBytes(destination: string): Promise<number | undefined> {
  if (typeof destination !== 'string' || destination.length > 4096 || !path.isAbsolute(destination) || destination.includes('\0')) {
    throw Error('The destination must be an absolute path.');
  }
  let current = path.resolve(destination);
  for (let depth = 0; depth < 128; depth++) {
    try {
      const stats = await fs.statfs(current, { bigint: true });
      if (stats.bsize <= 0n || stats.bavail < 0n) return;
      const bytes = stats.bsize * stats.bavail;
      return bytes <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bytes) : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
      // A dangling symlink may eventually target a different disk. Never report
      // its own parent filesystem as if it were the intended target.
      try { if ((await fs.lstat(current)).isSymbolicLink()) return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return; }
      const parent = path.dirname(current);
      if (parent === current) return;
      current = parent;
    }
  }
}
