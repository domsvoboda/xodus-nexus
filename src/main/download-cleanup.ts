import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DownloadCancelOptions, DownloadTask } from '../shared/types.js';
import { canonicalInstallPath, installPathsOverlap } from './install-queue.js';

type Proof = { schema: 1; id: string; product: string; directory: string; device: string; inode: string; marker: string; token: string };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const contains = (parent: string, child: string) => { const relative = path.relative(parent, child); return !relative || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };
const denied = (reason: string): DownloadCancelOptions => ({ deleteFilesAllowed: false, reason });

/** Proof is private launcher state, never a flag supplied by renderer/task JSON.
 * Existing directories, updates, content and historical untracked installs fail closed. */
export class DownloadCleanup {
  private readonly root: string;
  constructor(userData: string,
    private readonly removeTree: (directory: string) => Promise<void> = directory => fs.rm(directory, { recursive: true, force: false, maxRetries: 0 }),
    private readonly mountInfo: () => Promise<string> = () => fs.readFile('/proc/self/mountinfo', 'utf8')) { this.root = path.join(userData, 'download-ownership'); }
  private async safeRoot(): Promise<void> {
    const stat = await fs.lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.uid !== process.getuid?.()) throw Error('Unsafe ownership directory.');
  }
  private file(id: string): string { if (!uuid.test(id)) throw Error('Untracked installation.'); return path.join(this.root, id + '.json'); }
  private async proof(task: DownloadTask): Promise<Proof> {
    await this.safeRoot();
    const handle = await fs.open(this.file(task.id), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 4096 || stat.nlink !== 1 || stat.mode & 0o077 || stat.uid !== process.getuid?.()) throw Error('Unsafe ownership record.');
      const value = JSON.parse(await handle.readFile('utf8')) as Proof;
      if (value.schema !== 1 || value.id !== task.id || value.product !== task.productId || value.directory !== task.destination
        || !/^\d+$/.test(value.device) || !/^\d+$/.test(value.inode) || !uuid.test(value.token)
        || value.marker !== `.nexus-download-${value.token}`) throw Error('Ownership mismatch.');
      return value;
    } finally { await handle.close(); }
  }
  private async verify(directory: string, proof: Proof): Promise<void> {
    const stat = await fs.lstat(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || String(stat.dev) !== proof.device || String(stat.ino) !== proof.inode) throw Error('Installation folder changed.');
    const marker = await fs.open(path.join(directory, proof.marker), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await marker.stat();
      if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 256 || await marker.readFile('utf8') !== proof.token) throw Error('Installation marker changed.');
    } finally { await marker.close(); }
  }
  async prepare(task: DownloadTask): Promise<void> {
    if (task.kind !== 'install' || task.gameId) { await fs.mkdir(task.destination, { recursive: true }); return; }
    await fs.mkdir(path.dirname(task.destination), { recursive: true });
    try { await fs.mkdir(task.destination); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error; }
    // Failure to record ownership must never make a pre-existing directory deletable.
    try {
      if (await fs.realpath(task.destination) !== task.destination) return;
      const stat = await fs.lstat(task.destination, { bigint: true }), token = randomUUID();
      const proof: Proof = { schema: 1, id: task.id, product: task.productId, directory: task.destination,
        device: String(stat.dev), inode: String(stat.ino), marker: `.nexus-download-${token}`, token };
      await fs.writeFile(path.join(task.destination, proof.marker), token, { flag: 'wx', mode: 0o600 });
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      await this.safeRoot();
      await fs.writeFile(this.file(task.id), JSON.stringify(proof), { flag: 'wx', mode: 0o600 });
    } catch { /* Download can continue, but automatic deletion stays unavailable. */ }
  }
  /** Internal resume admission only. Carry an existing private proof forward,
   * never claim a directory just because a new queue entry names it. Retain the
   * old proof until admission succeeds so a failed resume remains cancellable. */
  async inheritResume(previous: DownloadTask, next: DownloadTask): Promise<void> {
    if (previous.status !== 'paused' || next.status !== 'queued' || previous.id === next.id
      || previous.kind !== 'install' || next.kind !== 'install' || previous.gameId || next.gameId
      || previous.productId !== next.productId || previous.destination !== next.destination
      || previous.selectedContentId !== next.selectedContentId || previous.selectionMarket !== next.selectionMarket) return;
    try {
      const proof = await this.proof(previous);
      if (await fs.realpath(previous.destination) !== previous.destination) return;
      await this.verify(previous.destination, proof);
      await fs.writeFile(this.file(next.id), JSON.stringify({ ...proof, id: next.id }), { flag: 'wx', mode: 0o600 });
    } catch { /* Missing, stale or untracked proof stays fail-closed, without blocking resume. */ }
  }
  async options(task: DownloadTask, locked: string[], roots: string[]): Promise<DownloadCancelOptions> {
    if (task.kind !== 'install' || task.gameId) return denied('Updates and DLC keep their files to protect the installed game.');
    if (task.status === 'complete') return denied('Completed installations cannot be deleted by cancelling a download.');
    try {
      const proof = await this.proof(task), directory = await fs.realpath(task.destination);
      if (directory !== task.destination) return denied('The installation folder changed or contains a symbolic link.');
      await this.verify(directory, proof);
      for (const item of locked) if (installPathsOverlap(directory, await canonicalInstallPath(item))) return denied('This folder is used by a game or another installation.');
      for (const item of roots) if (contains(directory, await canonicalInstallPath(item))) return denied('This is a protected installation or system location.');
      return { deleteFilesAllowed: true };
    } catch { return denied('Only a new installation folder created and tracked by this launcher can be deleted. Existing or untracked folders are kept.'); }
  }
  private async validateTree(directory: string, device: string): Promise<void> {
    let count = 0;
    const visit = async (current: string): Promise<void> => {
      if (++count > 200_000) throw Error('Too many files to verify safely.');
      const stat = await fs.lstat(current, { bigint: true });
      if (String(stat.dev) !== device || stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw Error('Unsafe link, mount or special file in installation.');
      if (stat.isDirectory()) for (const entry of await fs.readdir(current)) await visit(path.join(current, entry));
    };
    // Same-device bind mounts also need explicit rejection, not just st_dev checks.
    const mounts = await this.mountInfo();
    for (const line of mounts.trim().split('\n')) {
      const mount = line.split(' ')[4]?.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));
      if (mount && contains(directory, mount)) throw Error('Installation contains a mounted filesystem.');
    }
    await visit(directory);
  }
  async remove(task: DownloadTask, locked: string[], roots: string[]): Promise<void> {
    const options = await this.options(task, locked, roots);
    if (!options.deleteFilesAllowed) throw Error(options.reason);
    const proof = await this.proof(task), parent = path.dirname(task.destination);
    const handle = await fs.open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let quarantine: string | undefined, moved: string | undefined, deletionStarted = false;
    try {
      const anchor = `/proc/self/fd/${handle.fd}`;
      if (await fs.realpath(anchor) !== parent) throw Error('Installation parent changed.');
      const source = path.join(anchor, path.basename(task.destination));
      await this.verify(source, proof);
      quarantine = await fs.mkdtemp(path.join(anchor, '.nexus-cancel-'));
      moved = path.join(quarantine, 'files');
      await fs.rename(source, moved);
      // An atomic rename cannot accidentally delete a replacement at the old path.
      await this.verify(moved, proof);
      await this.validateTree(await fs.realpath(moved), proof.device);
      await this.verify(moved, proof);
      deletionStarted = true;
      await this.removeTree(moved);
      moved = undefined;
      await fs.unlink(this.file(task.id));
    } catch (error) {
      let recovery = '';
      if (moved) {
        try {
          // Never overwrite another directory created at the original destination.
          const source = path.join(`/proc/self/fd/${handle.fd}`, path.basename(task.destination));
          const exists = await fs.lstat(source).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
          if (exists) recovery = ` Remaining files are preserved at ${await fs.realpath(moved)}.`;
          else { await fs.rename(moved, source); moved = undefined; }
        } catch { recovery = ' Remaining files are preserved in the temporary cancellation folder next to the installation.'; }
      }
      throw Error(`${deletionStarted ? 'Cleanup was incomplete; some downloaded files may already have been deleted.' : 'Files were not deleted.'}${recovery} ${error instanceof Error ? error.message : 'Cleanup failed.'}`);
    } finally {
      if (quarantine && !moved) await fs.rmdir(quarantine).catch(() => {});
      await handle.close();
    }
  }

  async complete(task: DownloadTask): Promise<void> {
    try {
      const proof = await this.proof(task); await this.verify(task.destination, proof);
      await fs.unlink(path.join(task.destination, proof.marker)); await fs.unlink(this.file(task.id));
    } catch { /* Ownership metadata must not turn a completed download into a failure. */ }
  }
}
