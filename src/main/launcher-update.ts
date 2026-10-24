import { constants, promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { LauncherUpdate } from '../shared/types.js';
import { isNewerVersion } from '../shared/utils.js';
import { APPIMAGE_ARCH_SUFFIX, currentArch, isLinuxElf64 } from './arch.js';

const REPO = 'domsvoboda/xodus-nexus';
const API = `https://api.github.com/repos/${REPO}/releases?per_page=100`;
interface Asset { name: string; browser_download_url: string; size: number }
interface Release { tag_name: string; draft?: boolean; prerelease?: boolean; assets: Asset[] }
export interface LauncherCandidate { version: string; image: Asset; checksum: Asset; releaseUrl: string }

function assetUrl(url: string, tag: string, name: string): boolean {
  return url === `https://github.com/${REPO}/releases/download/${tag}/${name}`;
}
export function launcherCandidate(releases: Release[], current: string): LauncherCandidate | undefined {
  const stable = releases.filter(r => !r.draft && !r.prerelease && /^v\d+\.\d+\.\d+$/.test(r.tag_name));
  stable.sort((a, b) => isNewerVersion(a.tag_name, b.tag_name) ? -1 : isNewerVersion(b.tag_name, a.tag_name) ? 1 : 0);
  for (const r of stable) {
    if (!isNewerVersion(r.tag_name, current)) continue;
    const name = `Xodus-Nexus-${r.tag_name.slice(1)}-${APPIMAGE_ARCH_SUFFIX[currentArch()]}.AppImage`;
    const image = r.assets?.find(a => a.name === name);
    const checksum = r.assets?.find(a => a.name === `${name}.sha512sum`);
    if (!image || !checksum || !assetUrl(image.browser_download_url, r.tag_name, image.name) ||
        !assetUrl(checksum.browser_download_url, r.tag_name, checksum.name) ||
        !Number.isSafeInteger(image.size) || image.size < 64 || image.size > 1024 ** 3 ||
        !Number.isSafeInteger(checksum.size) || checksum.size < 1 || checksum.size > 4096) continue;
    return { version: r.tag_name.slice(1), image, checksum, releaseUrl: `https://github.com/${REPO}/releases/tag/${r.tag_name}` };
  }
  return undefined;
}

interface Journal { target: string; backup: string; previousVersion: string; version: string }
export class LauncherUpdater {
  readonly state: LauncherUpdate;
  targetPath?: string;
  private candidate?: LauncherCandidate;
  private journal?: Journal;
  private checking?: Promise<void>;
  private controller?: AbortController;
  cancel(): void { this.controller?.abort(); }
  constructor(private version: string, private image: string | undefined, private userData: string,
    private changed: () => void, private fetcher: typeof fetch = fetch) {
    this.state = { currentVersion: version, checking: false, canInstall: false };
  }
  private async writableImage(): Promise<string> {
    if (!this.image || !path.isAbsolute(this.image) || !this.image.endsWith('.AppImage')) throw new Error('In-app updates require a writable AppImage. Use the installer for this build.');
    const target = await fs.realpath(this.image);
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw new Error('The AppImage must be a regular file owned and writable only by your user.');
    await fs.access(target, constants.W_OK);
    await fs.access(path.dirname(target), constants.W_OK);
    return target;
  }
  async initialize(): Promise<void> {
    try { this.targetPath = await this.writableImage(); this.state.canInstall = true; } catch { this.state.canInstall = false; }
    try {
      const j = JSON.parse(await fs.readFile(path.join(this.userData, 'launcher-update.json'), 'utf8')) as Journal;
      if (j.target !== this.targetPath || path.dirname(j.backup) !== path.dirname(j.target) ||
          !path.basename(j.backup).startsWith(path.basename(j.target) + '.nexus-backup-')) return;
      const stat = await fs.lstat(j.backup);
      if (!stat.isFile() || stat.uid !== process.getuid?.()) return;
      this.journal = j; this.state.canRollback = true;
    } catch { /* No previous in-app update. */ }
  }
  async check(): Promise<void> {
    if (this.state.updating || this.state.restartRequired) return;
    if (this.checking) return this.checking;
    this.checking = this.performCheck().finally(() => { this.checking = undefined; });
    return this.checking;
  }
  private async performCheck(): Promise<void> {
    this.state.checking = true; this.state.error = undefined; this.changed();
    try {
      const response = await this.fetcher(API, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`GitHub update check returned HTTP ${response.status}.`);
      const releases = await response.json() as Release[];
      if (!Array.isArray(releases)) throw new Error('Invalid GitHub release list.');
      this.candidate = launcherCandidate(releases, this.version);
      this.state.latestVersion = this.candidate?.version;
      this.state.releaseUrl = this.candidate?.releaseUrl;
    } catch (error) { this.state.error = (error as Error).message; }
    finally { this.state.checking = false; this.state.checkedAt = new Date().toISOString(); this.changed(); }
  }
  async install(): Promise<void> {
    if (this.state.updating || this.state.restartRequired) throw new Error('A launcher update is already pending.');
    if (!this.candidate) throw new Error('Check for a newer launcher release first.');
    const candidate = this.candidate;
    const target = await this.writableImage();
    const lockPath = `${target}.nexus-update.lock`;
    let lock;
    try { lock = await fs.open(lockPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stat = await fs.lstat(lockPath);
      if (!stat.isFile() || stat.uid !== process.getuid?.()) throw new Error('Unsafe launcher update lock.');
      const pid = Number(await fs.readFile(lockPath, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid launcher update lock.');
      try { process.kill(pid, 0); throw new Error('Another launcher update is active.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      await fs.rm(lockPath); lock = await fs.open(lockPath, 'wx', 0o600);
    }
    await lock.writeFile(String(process.pid)); await lock.close();
    const before = await fs.stat(target);
    const temporary = `${target}.nexus-update-${randomUUID()}`;
    const backup = `${target}.nexus-backup-${randomUUID()}`;
    const previousJournal = this.journal;
    let replaced = false, backedUp = false;
    this.controller = new AbortController();
    this.state.updating = true; this.state.error = undefined; this.state.progress = 0; this.state.phase = 'Downloading launcher update…'; this.changed();
    try {
      const checksumResponse = await this.fetcher(candidate.checksum.browser_download_url, { signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15_000)]) });
      if (!checksumResponse.ok || candidate.checksum.size > 4096) throw new Error('Could not download the launcher checksum.');
      const checksum = (await checksumResponse.text()).trim();
      const match = checksum.match(/^([a-f0-9]{128})  ([A-Za-z0-9._-]+)$/i);
      if (!match || match[2] !== candidate.image.name) throw new Error('Invalid launcher checksum file.');
      const response = await this.fetcher(candidate.image.browser_download_url, { signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(600_000)]) });
      if (!response.ok || !response.body) throw new Error('Could not download the launcher AppImage.');
      const handle = await fs.open(temporary, 'wx', 0o700);
      const hash = createHash('sha512'); let bytes = 0; let header = Buffer.alloc(0);
      try {
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > candidate.image.size) throw new Error('Launcher download exceeded its published size.');
          if (header.length < 64) header = Buffer.concat([header, chunk]).subarray(0, 64);
          hash.update(chunk); await handle.writeFile(chunk);
          this.state.progress = Math.round(bytes / candidate.image.size * 100); this.changed();
        }
        await handle.sync();
      } finally { await handle.close(); }
      if (bytes !== candidate.image.size || hash.digest('hex') !== match[1].toLowerCase()) throw new Error('Launcher SHA-512 verification failed. Your current launcher was kept.');
      if (!isLinuxElf64(header, currentArch()) || header.subarray(8, 11).toString('hex') !== '414902') throw new Error(`The update is not a ${APPIMAGE_ARCH_SUFFIX[currentArch()]} AppImage.`);
      const now = await fs.stat(target);
      this.controller.signal.throwIfAborted();
      if (now.ino !== before.ino || now.size !== before.size || now.mtimeMs !== before.mtimeMs || await this.writableImage() !== target) throw new Error('The installed launcher changed during download. Retry the update.');
      this.state.phase = 'Installing verified launcher…'; this.changed();
      await fs.copyFile(target, backup, constants.COPYFILE_EXCL); backedUp = true;
      await fs.rename(temporary, target); replaced = true;
      const j: Journal = { target, backup, previousVersion: this.version, version: candidate.version };
      const journalFile = path.join(this.userData, 'launcher-update.json');
      await fs.mkdir(this.userData, { recursive: true });
      const journalTemp = `${journalFile}.${randomUUID()}`;
      try { await fs.writeFile(journalTemp, JSON.stringify(j), { flag: 'wx', mode: 0o600 }); await fs.rename(journalTemp, journalFile); }
      finally { await fs.rm(journalTemp, { force: true }); }
      this.journal = j; this.targetPath = target;
      this.state.restartRequired = true; this.state.canRollback = true; this.state.phase = 'Update installed. Restart to use it.';
      if (previousJournal?.backup) await fs.rm(previousJournal.backup, { force: true }).catch(() => {});
    } catch (error) {
      if (replaced && backedUp) { await fs.rename(backup, target); backedUp = false; }
      this.state.error = (error as Error).message; throw error;
    } finally {
      await fs.rm(temporary, { force: true });
      if (backedUp && !this.state.restartRequired) await fs.rm(backup, { force: true });
      this.state.updating = false; this.controller = undefined; this.changed();
      await fs.rm(lockPath, { force: true });
    }
  }
  async rollback(): Promise<void> {
    if (this.state.updating || !this.journal) throw new Error('No launcher backup is available.');
    if (await this.writableImage() !== this.journal.target) throw new Error('The launcher location has changed.');
    const stat = await fs.lstat(this.journal.backup);
    if (!stat.isFile() || stat.uid !== process.getuid?.()) throw new Error('The launcher backup is unsafe.');
    await fs.rename(this.journal.backup, this.journal.target);
    await fs.rm(path.join(this.userData, 'launcher-update.json'), { force: true });
    this.state.canRollback = false; this.state.restartRequired = true; this.state.phase = 'Previous launcher restored. Restart to use it.';
    this.journal = undefined; this.changed();
  }
}
