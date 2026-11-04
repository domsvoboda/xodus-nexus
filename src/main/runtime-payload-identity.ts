import { constants, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

type FileStamp = Awaited<ReturnType<typeof stamp>>;
const stamp = (name: string) => fs.lstat(name, { bigint: true });
const sameStamp = (a: FileStamp, b: FileStamp) => a.dev === b.dev && a.ino === b.ino
  && a.mode === b.mode && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** Compare payload bytes, permissions and literal links, never link targets.
 * The caller must hold the runtime mutation reservation. This detects ordinary
 * concurrent edits; it is not a lock against unrelated filesystem writers.
 * Trust comes from the independently verified staged archive, not this digest.
 */
export async function runtimePayloadMatches(stagedRoot: string, installedRoot: string): Promise<boolean> {
  return await payloadDigest(stagedRoot) === await payloadDigest(installedRoot);
}

async function payloadDigest(root: string): Promise<string> {
  const inventory = createHash('sha256');
  const changed = () => new Error('The runtime payload changed during verification. Try again when it is idle.');
  async function visit(relative: string): Promise<void> {
    const name = path.join(root, relative), before = await stamp(name);
    const permissions = Number(before.mode & 0o7777n);
    let record: unknown[];
    if (before.isSymbolicLink()) {
      if (!relative) throw new Error('The runtime payload root must be a directory, not a symbolic link.');
      record = [relative, 'link', await fs.readlink(name)];
    } else if (before.isDirectory()) {
      inventory.update(JSON.stringify([relative, 'directory', permissions]) + '\n');
      for (const child of (await fs.readdir(name)).sort()) await visit(path.join(relative, child));
      if (!sameStamp(before, await stamp(name))) throw changed();
      return;
    } else if (before.isFile() && relative) {
      const file = await fs.open(name, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!sameStamp(before, await file.stat({ bigint: true }))) throw changed();
        const content = createHash('sha256');
        const stream = file.createReadStream({ autoClose: false });
        for await (const chunk of stream) content.update(chunk);
        if (!sameStamp(before, await file.stat({ bigint: true }))) throw changed();
        record = [relative, 'file', permissions, before.size.toString(), content.digest('hex')];
      } finally { await file.close(); }
    } else {
      throw new Error('The runtime payload contains an unsupported file type.');
    }
    if (!sameStamp(before, await stamp(name))) throw changed();
    inventory.update(JSON.stringify(record) + '\n');
  }
  await visit('');
  return inventory.digest('hex');
}
