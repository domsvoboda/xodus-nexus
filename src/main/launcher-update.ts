import { constants, promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { PreparedComponentUpdate } from './component-updates.js';
import type { LauncherUpdate } from '../shared/types.js';
import { isNewerVersion } from '../shared/utils.js';
import { APPIMAGE_ARCH_SUFFIX, currentArch, isLinuxElf64, type NexusArch } from './arch.js';

const REPO = 'domsvoboda/xodus-nexus';
const API = `https://api.github.com/repos/${REPO}/releases?per_page=100`;
interface Asset { name: string; browser_download_url: string; size: number }
interface Release { tag_name: string; draft?: boolean; prerelease?: boolean; assets: Asset[] }
export interface LauncherCandidate { version: string; image: Asset; checksum: Asset; releaseUrl: string }

const REPOSITORIES=['domsvoboda/xodus-nexus','domsvoboda/nexus-launcher'] as const;
const ARTIFACT_FAMILIES=['Xodus-Nexus','Nexus-Launcher'] as const;
export function launcherCandidate(releases: Release[], current: string, arch: NexusArch = currentArch()): LauncherCandidate | undefined {
  const stable = releases.filter(r => !r.draft && !r.prerelease && typeof r.tag_name === 'string' && /^v\d+\.\d+\.\d+$/.test(r.tag_name));
  stable.sort((a, b) => isNewerVersion(a.tag_name, b.tag_name) ? -1 : isNewerVersion(b.tag_name, a.tag_name) ? 1 : 0);
  for (const r of stable) {
    if (!isNewerVersion(r.tag_name, current)) continue;
    for (const family of ARTIFACT_FAMILIES) {
      const name = `${family}-${r.tag_name.slice(1)}-${APPIMAGE_ARCH_SUFFIX[arch]}.AppImage`;
      const images = Array.isArray(r.assets) ? r.assets.filter(a => a.name === name) : [];
      const sums = Array.isArray(r.assets) ? r.assets.filter(a => a.name === `${name}.sha512sum`) : [];
      if (images.length !== 1 || sums.length !== 1) continue;
      const image = images[0], checksum = sums[0];
      const repository = REPOSITORIES.find(repo => image.browser_download_url === `https://github.com/${repo}/releases/download/${r.tag_name}/${name}`
        && checksum.browser_download_url === `https://github.com/${repo}/releases/download/${r.tag_name}/${name}.sha512sum`);
      if (!repository || !Number.isSafeInteger(image.size) || image.size < 64 || image.size > 1024 ** 3
        || !Number.isSafeInteger(checksum.size) || checksum.size < 1 || checksum.size > 4096) continue;
      return { version: r.tag_name.slice(1), image, checksum, releaseUrl: `https://github.com/${repository}/releases/tag/${r.tag_name}` };
    }
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
  private mutationReserved = false;
  cancel(): void { this.controller?.abort(); }
  constructor(private version: string, private image: string | undefined, private userData: string,
    private changed: () => void, private fetcher: typeof fetch = fetch, private arch: NexusArch = currentArch()) {
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
      this.candidate = launcherCandidate(releases, this.version, this.arch);
      this.state.latestVersion = this.candidate?.version;
      this.state.releaseUrl = this.candidate?.releaseUrl;
    } catch (error) { this.state.error = (error as Error).message; }
    finally { this.state.checking = false; this.state.checkedAt = new Date().toISOString(); this.changed(); }
  }
  async prepareComponentUpdate(): Promise<PreparedComponentUpdate> {
    const item = { id: 'launcher', component: 'launcher' as const, label: 'Launcher', currentVersion: this.version,
      state: 'skipped' as 'ready' | 'skipped' | 'unchanged' | 'deferred', reason: 'An installed writable AppImage is required.' };
    if (this.state.restartRequired) return { item: { ...item, state: 'deferred', reason: 'Restart to use the installed launcher update.' }, isCurrent: async () => false, apply: async () => { throw Error('Restart required.'); } };
    let target: string;
    try { target = await this.writableImage(); } catch { return { item, isCurrent: async () => false, apply: async () => { throw Error(item.reason); } }; }
    const before = await fs.stat(target);
    await this.check();
    if (this.state.error) throw Error(this.state.error);
    const candidate = this.candidate ? structuredClone(this.candidate) : undefined;
    const same = async () => {
      try { const current = await fs.stat(target); return !this.state.restartRequired && await this.writableImage() === target && current.ino === before.ino && current.dev === before.dev && current.size === before.size && current.mtimeMs === before.mtimeMs && current.ctimeMs === before.ctimeMs; } catch { return false; }
    };
    return { item: { ...item, state: candidate ? 'ready' : 'unchanged', targetVersion: candidate?.version, reason: undefined },
      isCurrent: same,
      apply: async () => { if (!candidate) throw Error('No launcher update was selected.'); await this.install(candidate, same); return { committed: true, restartRequired: true }; },
      reconcile: async () => { if (!candidate || !this.state.restartRequired || this.journal?.version !== candidate.version || this.targetPath !== target) throw Error('Launcher update needs manual reconciliation.'); return { restartRequired: true }; },
    };
  }

  async install(selected?: LauncherCandidate, expectedCurrent?: () => Promise<boolean>): Promise<void> {
    if (this.mutationReserved) throw Error('A launcher update is already pending.');
    this.mutationReserved = true;
    try { await this.performInstall(selected, expectedCurrent); }
    finally { this.mutationReserved = false; }
  }
  private async performInstall(selected?: LauncherCandidate, expectedCurrent?: () => Promise<boolean>): Promise<void> {
    if (this.state.updating || this.state.restartRequired) throw new Error('A launcher update is already pending.');
    const candidate = selected ?? this.candidate;
    if (!candidate) throw new Error('Check for a newer launcher release first.');
    if (expectedCurrent && !await expectedCurrent()) throw Error('The installed launcher changed. Check again.');
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
    let activationCommitted = false;
    try {
    await lock.writeFile(String(process.pid)); await lock.close();
    const before = await fs.stat(target);
    const temporary = `${target}.nexus-update-${randomUUID()}`;
    const backup = `${target}.nexus-backup-${randomUUID()}`;
    const previousJournal = this.journal;
    let replaced = false, backedUp = false, rollbackFailed = false;
    let failure: unknown;
    let failed = false;
    this.controller = new AbortController();
    this.state.updating = true; this.state.error = undefined; this.state.progress = 0; this.state.phase = 'Downloading launcher update…';
    try {
      this.changed();
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
      if (!isLinuxElf64(header, this.arch) || header.subarray(8, 11).toString('hex') !== '414902') throw new Error(`The update is not a ${APPIMAGE_ARCH_SUFFIX[this.arch]} AppImage.`);
      const now = await fs.stat(target);
      this.controller.signal.throwIfAborted();
      if (expectedCurrent && !await expectedCurrent()) throw Error('The installed launcher changed before activation. Check again.');
      if (now.ino !== before.ino || now.size !== before.size || now.mtimeMs !== before.mtimeMs || await this.writableImage() !== target) throw new Error('The installed launcher changed during download. Retry the update.');
      this.state.phase = 'Installing verified launcher…'; this.changed();
      await fs.copyFile(target, backup, constants.COPYFILE_EXCL); backedUp = true;
      await fs.rename(temporary, target); replaced = true; activationCommitted = true;
      const j: Journal = { target, backup, previousVersion: this.version, version: candidate.version };
      const journalFile = path.join(this.userData, 'launcher-update.json');
      await fs.mkdir(this.userData, { recursive: true });
      const journalTemp = `${journalFile}.${randomUUID()}`;
      let journalPublished = false;
      try { await fs.writeFile(journalTemp, JSON.stringify(j), { flag: 'wx', mode: 0o600 }); await fs.rename(journalTemp, journalFile); journalPublished = true; }
      finally { if (!journalPublished) await fs.rm(journalTemp, { force: true }); }
      this.journal = j; this.targetPath = target;
      this.state.restartRequired = true; this.state.canRollback = true; this.state.phase = 'Update installed. Restart to use it.';
      if (previousJournal?.backup) await fs.rm(previousJournal.backup, { force: true }).catch(() => {});
    } catch (error) {
      failed = true; failure = error;
      if (replaced && backedUp) {
        try { await fs.rename(backup, target); backedUp = false; activationCommitted = false; }
        catch (rollbackError) { rollbackFailed = true; failure = new AggregateError([error, rollbackError], 'The launcher was replaced but restoring its backup failed.'); }
      }
      this.state.error = failure instanceof Error ? failure.message : String(failure);
      throw Object.assign(new Error(this.state.error, { cause: failure }), { committed: activationCommitted });
    } finally {
      let finishingFailure: unknown, finishingFailed = false;
      try {
        await fs.rm(temporary, { force: true });
        if (backedUp && !this.state.restartRequired && !rollbackFailed) await fs.rm(backup, { force: true });
      } catch (error) { finishingFailed = true; finishingFailure = error; }
      this.state.updating = false; this.controller = undefined;
      try { this.changed(); } catch (error) { finishingFailure = finishingFailed ? new AggregateError([finishingFailure,error], 'Launcher cleanup and notification failed.') : error; finishingFailed = true; }
      if (finishingFailed) {
        const cause = failed ? new AggregateError([failure,finishingFailure], 'Launcher update needs attention.') : finishingFailure;
        throw Object.assign(new Error(cause instanceof Error ? cause.message : String(cause), { cause }), { committed: activationCommitted });
      }
    }
    } finally {
      await lock.close().catch(() => undefined);
      try { await fs.rm(lockPath, { force: true }); } catch (error) { throw Object.assign(new Error('Launcher update lock cleanup failed.', { cause: error }), { committed: activationCommitted }); }
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
