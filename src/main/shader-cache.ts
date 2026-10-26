import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

async function privateDirectory(directory: string, create = false): Promise<FileHandle> {
  if (create) {
    try { await fs.mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isDirectory() || before.uid !== process.geteuid?.()) {
      throw Error('The managed shader cache must be a directory owned by the current user.');
    }
    if ((before.mode & 0o777) !== 0o700) await handle.chmod(0o700);
    const current = await fs.lstat(directory);
    if (current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino || (current.mode & 0o777) !== 0o700) {
      throw Error('The managed shader cache changed while checking its permissions.');
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

/** Only owned cache directories are managed. Never clear cache files or follow links. */
export async function prepareShaderCache(compatibilityDataPath: string): Promise<{ vkd3d: string; nvidia: string; mesa: string }> {
  if (!path.isAbsolute(compatibilityDataPath)) throw Error('The shader cache prefix path must be absolute.');
  const root = await privateDirectory(compatibilityDataPath);
  try {
    const before = await root.stat();
    // Anchor creation to checked directory handles, not a replaceable parent path.
    const cache = await privateDirectory(`/proc/self/fd/${root.fd}/shadercache`, true);
    try {
      for (const name of ['vkd3d-proton', 'nvidia', 'mesa']) {
        const child = await privateDirectory(`/proc/self/fd/${cache.fd}/${name}`, true);
        await child.close();
      }
      const current = await fs.lstat(compatibilityDataPath);
      if (current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino) {
        throw Error('The shader cache prefix changed during preparation.');
      }
      const directory = path.join(await fs.realpath(compatibilityDataPath), 'shadercache');
      const top = await fs.lstat(directory), checked = await cache.stat();
      if (top.isSymbolicLink() || top.dev !== checked.dev || top.ino !== checked.ino) throw Error('The shader cache directory changed during preparation.');
      return { vkd3d: path.join(directory, 'vkd3d-proton'), nvidia: path.join(directory, 'nvidia'), mesa: path.join(directory, 'mesa') };
    } finally { await cache.close(); }
  } finally { await root.close(); }
}
