import {legacyManagedState,type LegacyManagedState} from './legacy-runtime-state.js';
import {materializeRuntimeArchive} from './runtime-family-archive.js';
import type {VerifiedManagedFamilyRelease} from './runtime-family-release.js';
import {isDeepStrictEqual} from 'node:util';
import {ManagedRuntimeManager} from './managed-runtime.js';
import {commitRuntimePointer,type PointerCommitResult} from './runtime-pointer-commit.js';
import {installedRuntimeFamilies} from './runtime-families.js';
import {runtimeWineFailure} from './runtime-prerequisites.js';
import { constants, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { RuntimeStatus } from '../shared/types.js';
import { run } from './process.js';
import { runtimeArchiveArch, runtimeLoader } from './proton-layout.js';
import { runtimePayloadMatches } from './runtime-payload-identity.js';

const REPOSITORY = 'xodus-gaming/Proton';
const BRANCH = 'xodus/bleeding-edge';
const REPOSITORY_URL = 'https://github.com/xodus-gaming/Proton.git';
const NEXUS_REPOSITORY = 'domsvoboda/nexus-launcher';
const LEGACY_NEXUS_REPOSITORY = 'domsvoboda/xodus-nexus';
const NEXUS_RUNTIME_REPOSITORY = 'domsvoboda/nexus-runtime';

interface RuntimePointer {
  name: string;
  winePath: string;
  commit: string;
  installedAt: string;
}

interface ArtifactInfo {
  runId: number;
  commit: string;
  name: string;
  checksumName: string;
  expiresAt: string;
}

interface NexusArtifact {
  version: string;
  name: string;
  url: string;
  checksumName: string;
  checksumUrl: string;
}

// Release directories carry simple, user-facing version names; patch
// provenance lives in current.json and the release notes, not in the path.
// Upstream Proton describe style: <wine>-<yyyymmdd>-g<sha> (e.g.
// 11.0-20261011-g3fd4ae10), so the version says which Wine it is.
export function canonicalSnapshotName(commit: string): string {
  return `xodus-proton-${commit.slice(0, 8)}`;
}

export function nexusReleaseName(archiveAssetName: string): string {
  return archiveAssetName.replace(/-(?:x86_64|aarch64)\.tar\.xz$/, '');
}

export function previewBaseRelease(name: string): string | null {
  const match = name.match(/^(proton-xodus-[A-Za-z0-9._-]+)-xgamesave-pr28-[0-9a-f]{10}(?:-bridge-v1(?:-userstate-v1(?:-userguest-v1)?)?)?(?:-locale-v1)?$/);
  return match?.[1] ?? null;
}

export interface RuntimeSettingsReservation { setRoot(root: string): void; release(): void; }
type AfterInstall = ((winePath: string) => Promise<void>) | {
  persistSelection(winePath:string):Promise<void>;
  refreshAccount?():Promise<void>;
};
export interface LegacyRuntimeUpdateTarget {
    readonly kind: 'legacy-standard';
    readonly root: string;
    readonly installed: Readonly<LegacyManagedState>;
    readonly version: string;
    readonly candidateSha256: string;
    readonly channel: 'stable' | 'prerelease';
}
export interface LegacyRuntimeUpdateCallbacks {
    configuredWine(): string;
    persistSelection(wine: string): Promise<void>;
    refreshAccount?(): Promise<void>;
}
interface Activation {winePath:string;pointer:PointerCommitResult;}

export class RuntimeManager {
  private legacyTargets=new WeakMap<LegacyRuntimeUpdateTarget,VerifiedManagedFamilyRelease>();
  private managed:ManagedRuntimeManager;
  private mutation?: symbol;
  private settingsReservation?: RuntimeSettingsReservation;
  private status: RuntimeStatus;
  private emitLog: (scope: string, line: string) => void;
  private isOperationActive: () => boolean;
  private latestArtifact?: ArtifactInfo;
  private nexusArtifact?: NexusArtifact;
  private readonly fetcher: typeof fetch;
  private readonly hostArch: string;

  constructor(runtimeRoot: string, emitLog: (scope: string, line: string) => void, isOperationActive: () => boolean, fetcher: typeof fetch = fetch, hostArch: string = process.arch, versions:()=>{launcher:string;backend:string}=()=>({launcher:'0.0.0',backend:'0.0.0'}), managedNotify:()=>void=()=>{}) {
    this.emitLog = emitLog;
    this.isOperationActive = isOperationActive;
    this.fetcher = fetcher;
    this.hostArch = hostArch;
    this.status = {
      installed: false,
      checking: false,
      updating: false,
      runtimeRoot,
      artifactAvailable: false,
      prerequisites: { gh: false, authenticated: false, tar: false, sha512sum: false },
    };
    this.managed=new ManagedRuntimeManager({root:()=>this.status.runtimeRoot,reserve:()=>this.reserveMutation(),versions,fetcher,arch:hostArch,notify:managedNotify,completed:()=>{this.status.managedRevision=(this.status.managedRevision??0)+1;}});
  }

  get current(): RuntimeStatus { return structuredClone({...this.status,managedFamilies:this.managed.current}); }
  checkManagedRuntime(family:unknown,options:unknown,onStatus:()=>void=()=>{}) {return this.managedCheck(family,options,onStatus);}
  private async managedCheck(family:unknown,options:unknown,onStatus:()=>void) {try{onStatus();return await this.managed.check(family,options);}finally{onStatus();}}
  async installManagedRuntime(family:unknown,expected:unknown,options:unknown,onStatus:()=>void=()=>{}) {const result=await this.managed.install(family,expected,options);try{await this.refreshFamilies();onStatus();}catch(error){return {...result,success:false,error:[result.error,'Updating runtime status failed: '+(error as Error).message].filter(Boolean).join(' ')};}return result;}
  async importManagedRuntime(family:unknown,directory:unknown,options:unknown,onStatus:()=>void=()=>{}) {const result=await this.managed.importLocal(family,directory,options);try{await this.refreshFamilies();onStatus();}catch(error){return {...result,success:false,error:[result.error,'Updating runtime status failed: '+(error as Error).message].filter(Boolean).join(' ')};}return result;}
  async installPreparedManagedRuntime(family: unknown, target: Readonly<VerifiedManagedFamilyRelease>, options: unknown, onStatus: () => void = () => { }) {
      const result = await this.managed.install(family, target.candidateSha256, options, target);
      try {
          await this.refreshFamilies();
          onStatus();
      }
      catch (error) {
          return { ...result, success: false, error: [result.error, 'Updating runtime status failed: ' + (error instanceof Error ? error.message : String(error))].filter(Boolean).join(' ') };
      }
      return result;
  }
  async checkManagedRuntimeUpdate(family: unknown, channel: unknown, onStatus: () => void = () => { }) { try {
      return await this.managed.checkInstalledUpdate(family, channel);
  }
  finally {
      onStatus();
  } }
  managedTarget(family:unknown){return this.managed.target(family);}
  get busy(): boolean { return this.mutation !== undefined; }
  setRoot(root: string): void {
    if (this.busy) throw new Error('The runtime cannot be changed while a Xodus operation is active.');
    this.status.runtimeRoot = root;
  }
  private reserveMutation() {
    if (this.busy || this.isOperationActive()) throw new Error('The runtime cannot be changed while a Xodus operation is active.');
    const owner = Symbol('runtime mutation'), root = this.status.runtimeRoot;
    this.mutation = owner;
    this.status.updating = true;
    return { owner, root, release: () => {
      if (this.mutation !== owner) return;
      this.settingsReservation = undefined;
      this.mutation = undefined;
      this.status.updating = false;
    } };
  }
  assertSettingsReservation(reservation: RuntimeSettingsReservation): void {
    if (!this.busy || this.settingsReservation !== reservation) throw new Error('The runtime cannot be changed while a Xodus operation is active.');
  }
  reserveSettingsChange(): RuntimeSettingsReservation {
    const lease = this.reserveMutation();
    const reservation: RuntimeSettingsReservation = Object.freeze({
      setRoot: (root: string) => { this.assertSettingsReservation(reservation); this.status.runtimeRoot = root; },
      release: lease.release,
    });
    this.settingsReservation = reservation;
    return reservation;
  }

  private async commandOk(command: string, args: string[]): Promise<boolean> {
    try { return (await run(command, args, { maxOutput: 30_000 })).code === 0; } catch { return false; }
  }

  private pointerFile(root = this.status.runtimeRoot): string { return path.join(root, 'current.json'); }

  private async readPointer(root = this.status.runtimeRoot): Promise<RuntimePointer | null> {
    try { return JSON.parse(await fs.readFile(this.pointerFile(root), 'utf8')) as RuntimePointer; } catch { return null; }
  }

  private async validateWine(winePath: string, failureMessage?: string): Promise<boolean> {
    let problem: string;
    try {
      await fs.access(winePath, constants.X_OK);
      const result = await run(winePath, ['--version'], { maxOutput: 30_000 });
      if (result.code === 0 && /wine/i.test(result.output)) return true;
      problem = runtimeWineFailure(result.output) ?? `Wine --version failed (exit code ${result.code}).`;
    } catch { problem = 'The Wine executable could not be started. Check that the runtime matches this system and its installation allows execution.'; }
    if (failureMessage) throw Error(failureMessage + ' ' + problem);
    return false;
  }

  async refreshFamilies() {
    const root=this.status.runtimeRoot,revision=this.managed.revision;
    const variants=await installedRuntimeFamilies(root,this.hostArch);
    if(root!==this.status.runtimeRoot)throw Error('Runtime location changed. Check installed families again.');
    if(revision!==this.managed.revision)return structuredClone(this.status.variants??[]);
    this.status.variants=variants;
    await this.managed.refresh();
    return structuredClone(variants);
  }

  async refresh(): Promise<RuntimeStatus> {
    const [gh, authenticated, tar, sha512sum] = await Promise.all([
      this.commandOk('gh', ['--version']),
      this.commandOk('gh', ['auth', 'status', '--hostname', 'github.com']),
      this.commandOk('tar', ['--version']),
      this.commandOk('sha512sum', ['--version']),
    ]);
    this.status.prerequisites = { gh, authenticated, tar, sha512sum };
    await this.refreshFamilies();
    const pointer = await this.readPointer();
    if (pointer && await this.validateWine(pointer.winePath)) {
      Object.assign(this.status, {
        installed: true,
        name: pointer.name,
        winePath: pointer.winePath,
        commit: pointer.commit,
        error: undefined,
      });
    } else {
      Object.assign(this.status, { installed: false, name: undefined, winePath: undefined, commit: undefined });
    }
    return this.current;
  }

  async refreshSelection(onStatus: () => void, afterRefresh: () => Promise<void>): Promise<RuntimeStatus> {
    const lease = this.reserveMutation();
    let operationError:unknown;
    try {
      onStatus();
      await this.refresh();
      await afterRefresh();
    } catch(error){operationError=error;throw error;} finally {
      lease.release();
      this.notifyCompletion(onStatus,operationError);
    }
    return this.current;
  }

  private async discoverArtifact(): Promise<ArtifactInfo> {
    if (this.hostArch !== 'x64') throw new Error('The upstream runtime snapshot supports x86_64 only. Install the native Nexus runtime instead.');
    const remote = await run('git', ['ls-remote', REPOSITORY_URL, `refs/heads/${BRANCH}`], { maxOutput: 30_000 });
    if (remote.code !== 0) throw new Error('Could not resolve the Xodus Proton branch HEAD.');
    const upstreamCommit = remote.output.trim().split(/\s+/)[0];
    this.status.upstreamCommit = upstreamCommit;

    const runs = await run('gh', [
      'api', '--method', 'GET', `repos/${REPOSITORY}/actions/runs`,
      '-f', `branch=${BRANCH}`, '-f', 'status=success', '-f', 'per_page=20',
    ], { maxOutput: 2_000_000 });
    if (runs.code !== 0) throw new Error('GitHub Actions runs are unavailable. Is gh authenticated?');
    const parsedRuns = JSON.parse(runs.output) as { workflow_runs?: Array<{ id: number; name: string; head_sha: string }> };
    const matchingRun = parsedRuns.workflow_runs?.find((entry) => entry.name === 'Snapshot' && entry.head_sha === upstreamCommit)
      ?? parsedRuns.workflow_runs?.find((entry) => entry.name === 'Snapshot');
    if (!matchingRun) throw new Error('No successful Xodus Proton snapshot was found.');

    const artifactsResult = await run('gh', ['api', `repos/${REPOSITORY}/actions/runs/${matchingRun.id}/artifacts`], { maxOutput: 2_000_000 });
    if (artifactsResult.code !== 0) throw new Error('Could not load Xodus Proton snapshot artifacts.');
    const parsedArtifacts = JSON.parse(artifactsResult.output) as { artifacts?: Array<{ name: string; expired: boolean; expires_at: string }> };
    const archive = parsedArtifacts.artifacts?.find((entry) => !entry.expired && entry.name.endsWith('-x86_64.tar.xz'));
    const checksum = parsedArtifacts.artifacts?.find((entry) => !entry.expired && entry.name.endsWith('-x86_64.sha512sum'));
    if (!archive || !checksum) throw new Error('The x86_64 snapshot is missing or has expired.');
    return {
      runId: matchingRun.id,
      commit: matchingRun.head_sha,
      name: archive.name,
      checksumName: checksum.name,
      expiresAt: archive.expires_at,
    };
  }

  async check(): Promise<RuntimeStatus> {
    this.status.checking = true;
    this.status.error = undefined;
    try {
      if (!this.status.prerequisites.gh || !this.status.prerequisites.authenticated) {
        await this.refresh();
      }
      if (!this.status.prerequisites.gh) throw new Error('GitHub CLI (gh) is missing.');
      if (!this.status.prerequisites.authenticated) throw new Error('GitHub CLI is not authenticated; run gh auth login.');
      this.latestArtifact = await this.discoverArtifact();
      Object.assign(this.status, {
        artifactAvailable: true,
        artifactName: this.latestArtifact.name,
        artifactExpiresAt: this.latestArtifact.expiresAt,
      });
    } catch (error) {
      this.latestArtifact = undefined;
      this.status.artifactAvailable = false;
      this.status.error = (error as Error).message;
    } finally { this.status.checking = false; }
    return this.current;
  }

  private setPhase(phase: string, onStatus: () => void): void {
    this.status.phase = phase;
    this.emitLog('runtime', phase);
    onStatus();
  }

  async install(onStatus: () => void, afterInstall?: AfterInstall): Promise<string> {
    const lease = this.reserveMutation();
    let staging: string | undefined;
    let operationError:unknown;
    try {
      onStatus();
      if (!this.latestArtifact) await this.check();
      const artifact = this.latestArtifact && { ...this.latestArtifact };
      if (!artifact) throw new Error(this.status.error ?? 'The current snapshot is unavailable.');
      if (!this.status.prerequisites.tar || !this.status.prerequisites.sha512sum) throw new Error('tar or sha512sum is missing.');

      this.status.error = undefined;
      onStatus();
      staging = path.join(lease.root, `.staging-${randomUUID()}`);
      const downloads = path.join(staging, 'downloads');
      await fs.mkdir(downloads, { recursive: true });
      this.setPhase('Downloading the official x86_64 snapshot from GitHub Actions…', onStatus);
      let result = await run('gh', ['run', 'download', String(artifact.runId), '--repo', REPOSITORY, '--name', artifact.name, '--dir', downloads], {
        onLine: (line) => this.emitLog('runtime', line), maxOutput: 1_000_000,
      });
      if (result.code !== 0) throw new Error(`Runtime download failed (gh code ${result.code}).`);
      result = await run('gh', ['run', 'download', String(artifact.runId), '--repo', REPOSITORY, '--name', artifact.checksumName, '--dir', downloads], {
        onLine: (line) => this.emitLog('runtime', line), maxOutput: 100_000,
      });
      if (result.code !== 0) throw new Error('Checksum download failed.');

      this.setPhase('Verifying the SHA-512 checksum…', onStatus);
      result = await run('sha512sum', ['-c', artifact.checksumName], { cwd: downloads, maxOutput: 100_000 });
      if (result.code !== 0) throw new Error('Snapshot SHA-512 verification failed.');

      const activation = await this.activateArchive(downloads, artifact.name, artifact.commit, onStatus, canonicalSnapshotName(artifact.commit), lease.root);
      await this.completeActivation(activation,afterInstall);
      return activation.winePath;
    } catch (error) {
      operationError=error;
      this.status.error = (error as Error).message;
      throw error;
    } finally {
      if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      lease.release();
      this.notifyCompletion(onStatus,operationError,true);
    }
  }
  // Shared tail of both install paths: verify the archive structure, extract,
  // validate Wine and atomically switch the active runtime pointer. The
  // release directory uses the simple canonical name (releaseName); what the
  // archive calls its top-level folder is only provenance, kept in current.json.
  private async activateArchive(downloads: string, archiveName: string, commit: string, onStatus: () => void, releaseName: string, root: string): Promise<Activation> {
    const staging = path.join(root, `.staging-${randomUUID()}`);
    const extracted = path.join(staging, 'extracted');
    const archivePath = path.join(downloads, archiveName);
    try {
      // Only tar's stdout contains paths. Loader/overlay warnings on stderr
      // must not become archive members, even when tar itself exits successfully.
      const listing = await run('tar', ['-tJf', archivePath], { maxOutput: 20_000_000, stdoutOnly: true });
      if (listing.code !== 0) throw new Error('The runtime is not a valid tar.xz archive.');
      const entries = listing.output.split('\n').filter(Boolean);
      if (entries.length === 0 || entries.some((entry) => path.isAbsolute(entry) || entry.split('/').includes('..'))) {
        throw new Error('The archive contains unsafe paths.');
      }
      const top = entries[0].split('/')[0];
      if (!/^(proton-xodus-|xodus-nexus-runtime-|nexus-runtime-)/.test(top) || entries.some((entry) => entry.split('/')[0] !== top)) {
        throw new Error('Unexpected Xodus Proton runtime structure.');
      }

      this.setPhase('Extracting approximately 1.4 GB of runtime files…', onStatus);
      await fs.mkdir(extracted, { recursive: true });
      let result = await run('tar', ['-xJf', archivePath, '-C', extracted], { onLine: (line) => this.emitLog('runtime', line), maxOutput: 1_000_000 });
      if (result.code !== 0) throw new Error('Runtime extraction failed.');
      const candidateRoot = path.join(extracted, top);
      const candidateWine = await runtimeLoader(candidateRoot, this.hostArch, false);
      return await this.activateVerifiedPayload(candidateRoot,candidateWine,commit,onStatus,releaseName,root);
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async activateVerifiedPayload(candidateRoot: string, candidateWine: string, commit: string, onStatus: () => void, releaseName: string, root: string, precommit?: () => Promise<void>, releaseIdentity?: {
      sourceRepository: string;
      candidateSha256: string;
      prerelease: boolean;
  }): Promise<Activation> {
      await this.validateWine(candidateWine, 'The downloaded Wine failed --version validation.');
      if (this.isOperationActive())
          throw new Error('Another operation started during installation; the runtime was not activated.');
      const releases = path.join(root, 'releases');
      const releaseRoot = path.join(releases, releaseName);
      await fs.mkdir(releases, { recursive: true });
      let existing = true;
      try {
          await fs.lstat(releaseRoot);
      }
      catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
              throw error;
          existing = false;
      }
      if (existing) {
          if (!await runtimePayloadMatches(candidateRoot, releaseRoot)) {
              throw new Error('The existing runtime folder does not match the verified download. It was left unchanged.');
          }
      }
      else {
          await fs.rename(candidateRoot, releaseRoot);
      }
      const winePath = path.join(releaseRoot, path.relative(candidateRoot, candidateWine));
      if (!await this.validateWine(winePath))
          throw new Error('The activated runtime is not executable.');
      await precommit?.();
      const pointer: RuntimePointer = { name: releaseName, winePath, commit, installedAt: new Date().toISOString(), ...releaseIdentity };
      await fs.mkdir(root, { recursive: true });
      const pointerResult = await commitRuntimePointer(root, pointer);
      Object.assign(this.status, { installed: true, name: releaseName, winePath, commit, phase: 'Runtime activated; finishing setup.', error: undefined });
      try {
          this.emitLog('runtime', `Active Wine: ${winePath}`);
      }
      catch (error) {
          pointerResult.errors.push(new Error('Runtime activation log failed: ' + (error as Error).message, { cause: error }));
      }
      return { winePath, pointer: pointerResult };
  }
  async prepareLegacyManagedUpdate(configuredWine: string): Promise<{
      target?: Readonly<LegacyRuntimeUpdateTarget>;
      skipReason?: string;
      state: 'ready' | 'unchanged' | 'skipped' | 'deferred';
      currentVersion?: string;
  }> {
      const root = this.status.runtimeRoot, installed = await legacyManagedState(root, configuredWine);
      if (!installed)
          return { state: 'skipped', skipReason: 'The default runtime is custom, unavailable or not a supported managed Standard installation.' };
      const currentVersion = installed.releaseTag;
      const channel = installed.channel ?? await this.managed.legacyInstalledChannel(installed.releaseTag, installed.name, installed.sourceCommit);
      if (!channel)
          return { state: 'skipped', currentVersion, skipReason: 'The installed Standard runtime release channel could not be verified.' };
      const checked = await this.managed.check('nexus', { allowCachyos: false, allowPrerelease: channel === 'prerelease' }, channel);
      const release = this.managed.target('nexus');
      if (!release || checked.error)
          return { state: 'deferred', currentVersion, skipReason: checked.error ?? 'No trusted Standard runtime update is available.' };
      if (checked.available?.candidateSha256 !== release.candidateSha256 || release.prerelease !== (channel === 'prerelease'))
          return { state: 'deferred', currentVersion, skipReason: 'Runtime release selection changed while checking. Check again.' };
      if (root !== this.status.runtimeRoot || (await legacyManagedState(root, configuredWine))?.identity !== installed.identity)
          return { state: 'deferred', currentVersion, skipReason: 'The installed Standard runtime changed while checking.' };
      if (installed.candidateSha256 === release.candidateSha256)
          return { state: 'unchanged', currentVersion, skipReason: 'The managed Standard runtime is already current.' };
      const target = Object.freeze({ kind: 'legacy-standard' as const, root, installed, version: release.tag, candidateSha256: release.candidateSha256, channel });
      this.legacyTargets.set(target, release);
      return { target, state: 'ready', currentVersion };
  }

  async applyLegacyManagedUpdate(value: unknown, callbacks: LegacyRuntimeUpdateCallbacks, onStatus: () => void = () => { }): Promise<{
      success: boolean;
      committed: boolean;
      durability: 'confirmed' | 'unknown' | 'not-committed';
      error?: string;
  }> {
      if (!value || typeof value !== 'object' || !this.legacyTargets.has(value as LegacyRuntimeUpdateTarget))
          throw Error('Unknown prepared Standard runtime update');
      const target = value as LegacyRuntimeUpdateTarget, release = this.legacyTargets.get(target)!;
      const lease = this.reserveMutation();
      let staging: string | undefined, activation: Activation | undefined, operationError: Error | undefined;
      let outcome: {
          success: boolean;
          committed: boolean;
          durability: 'confirmed' | 'unknown' | 'not-committed';
          error?: string;
      } = { success: false, committed: false, durability: 'not-committed' };
      const fail = (error: unknown) => {
          const next = error instanceof Error ? error : new Error(String(error), { cause: error });
          operationError = operationError ? new AggregateError([operationError, next], operationError.message + ' ' + next.message) : next;
          this.status.error = operationError.message;
          this.status.phase = activation ? 'Runtime activated; finishing setup needs attention.' : 'Active runtime selection was not changed.';
          outcome = { success: false, committed: Boolean(activation), durability: activation?.pointer.durability ?? 'not-committed', error: this.status.error };
      };
      try {
          this.status.phase = 'Checking the selected Standard runtime update.';
          onStatus();
          const unchanged = async () => {
              const configured = callbacks.configuredWine();
              if (this.status.runtimeRoot !== target.root || lease.root !== target.root || configured !== target.installed.configuredWine || (await legacyManagedState(target.root, configured))?.identity !== target.installed.identity)
                  throw Error('The selected Standard runtime changed; check updates again.');
          };
          await unchanged();
          staging = path.join(lease.root, '.staging-' + randomUUID());
          await fs.mkdir(staging, { mode: 0o700 });
          const archive = path.join(staging, release.assets.binary.name);
          await this.managed.downloadPreparedRelease(release, lease.root, archive, { allowCachyos: false, allowPrerelease: target.channel === 'prerelease' });
          const extracted = path.join(staging, 'payload');
          await fs.mkdir(extracted, { mode: 0o700 });
          const name = nexusReleaseName(release.assets.binary.name), payload = await materializeRuntimeArchive(archive, extracted, name);
          const file = path.join(payload, 'XODUS_NEXUS_PATCH.json'), stat = await fs.lstat(file);
          if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
              throw Error('Missing bounded runtime source metadata');
          const metadata = JSON.parse(await fs.readFile(file, 'utf8'));
          if (metadata.schema !== 1 || !isDeepStrictEqual(metadata.sourceGraph, release.sourceGraph) || metadata.requiresBackendVersion !== release.requiresBackendVersion || metadata.requiresLauncherVersion !== release.requiresLauncherVersion || typeof metadata.sourceLockSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.sourceLockSha256))
              throw Error('Standard runtime payload does not match its verified release identity');
          const wine = await runtimeLoader(payload, this.hostArch, false);
          await unchanged();
          activation = await this.activateVerifiedPayload(payload, wine, release.tag, onStatus, name, lease.root, unchanged, { sourceRepository: release.repository, candidateSha256: release.candidateSha256, prerelease: target.channel === 'prerelease' });
          await this.completeActivation(activation, { persistSelection: callbacks.persistSelection, refreshAccount: callbacks.refreshAccount });
          outcome = { success: true, committed: true, durability: activation.pointer.durability };
      }
      catch (error) {
          fail(error);
      }
      finally {
          if (staging)
              try {
                  await fs.rm(staging, { recursive: true, force: true });
              }
              catch (error) {
                  fail(new Error('Cleaning runtime staging failed.', { cause: error }));
              }
          lease.release();
          try {
              onStatus();
          }
          catch (error) {
              fail(new Error('Updating runtime status failed.', { cause: error }));
          }
      }
      return outcome;
  }
  private notifyCompletion(onStatus:()=>void,prior:unknown,activated=false):void {
    try{onStatus();}catch(error){
      if(prior)throw new AggregateError([prior,error],(prior as Error).message+' Status notification failed: '+(error as Error).message);
      if(activated){
        this.status.phase='Runtime activated; finishing setup needs attention.';
        this.status.error='The runtime was activated, but updating its status failed: '+(error as Error).message;
        throw new Error(this.status.error,{cause:error});
      }
      throw error;
    }
  }
  private async completeActivation(activation:Activation,afterInstall?:AfterInstall):Promise<void> {
    const errors=[...activation.pointer.errors];
    if(typeof afterInstall==='function') {
      try{await afterInstall(activation.winePath);}catch(error){errors.push(new Error('Finishing launcher setup failed: '+(error as Error).message,{cause:error}));}
    } else if(afterInstall) {
      let saved=false;
      try{await afterInstall.persistSelection(activation.winePath);saved=true;}
      catch(error){errors.push(new Error('Saving the selected runtime failed or could not be confirmed: '+(error as Error).message,{cause:error}));}
      if(saved&&afterInstall.refreshAccount)try{await afterInstall.refreshAccount();}
      catch(error){errors.push(new Error('The runtime selection was saved, but refreshing account status failed: '+(error as Error).message,{cause:error}));}
    }
    if(errors.length) {
      this.status.phase='Runtime activated; finishing setup needs attention.';
      this.status.error='The runtime was activated. '+errors.map(error=>error.message).join(' ');
      throw new AggregateError(errors,this.status.error);
    }
    this.status.phase='Runtime is ready.';this.status.error=undefined;
  }

  // Only published releases are installable here, never unapproved CI artifacts.
  // The complete fork has its own release repository. Keep the existing release
  // source as a fallback until a complete new runtime is explicitly published.
  async checkNexus(): Promise<RuntimeStatus> {
    this.status.nexusChecking = true;
    this.status.nexusError = undefined;
    try {
      // Each host installs the runtime built for it: -x86_64 or -aarch64.
      const suffix = runtimeArchiveArch(this.hostArch);
      let selected = false;
      for (const repository of [NEXUS_RUNTIME_REPOSITORY, NEXUS_REPOSITORY, LEGACY_NEXUS_REPOSITORY]) {
        const response = await this.fetcher(`https://api.github.com/repos/${repository}/releases?per_page=30`, {
          headers: { Accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(20_000),
        });
        // The new canonical launcher repository owns the historical runtime
        // assets after the rename. The old name remains a read-only fallback.
        if (response.status === 404) continue;
        if (!response.ok) throw new Error('The Nexus runtime release list could not be read.');
        const releases = await response.json() as Array<{ tag_name?: unknown; published_at?: unknown; draft?: boolean; prerelease?: boolean; assets?: Array<{ name?: unknown; browser_download_url?: unknown }> }>;
        let found: { version: string; archive: { name: string; url: string }; checksum: { name: string; url: string } } | undefined;
        let newestPublication = -Infinity;
        for (const release of releases) {
          if (release.draft || release.prerelease) continue;
          const version = typeof release.tag_name === 'string' && release.tag_name.trim() ? release.tag_name.trim() : '';
          const assets = (release.assets ?? []).map((asset) => ({
            name: typeof asset.name === 'string' ? asset.name : '',
            url: typeof asset.browser_download_url === 'string' ? asset.browser_download_url : '',
          }));
          const pattern = new RegExp(`^${repository === NEXUS_RUNTIME_REPOSITORY ? 'nexus-runtime' : 'xodus-nexus-runtime'}-[A-Za-z0-9._-]+-${suffix}\\.tar\\.xz$`);
          const archive = assets.find((asset) => pattern.test(asset.name) &&
            /^https:\/\//.test(asset.url) && assets.some((sum) => sum.name === asset.name.replace(/\.tar\.xz$/, '.sha512sum') && /^https:\/\//.test(sum.url)));
          const checksum = archive && assets.find((asset) => asset.name === archive.name.replace(/\.tar\.xz$/, '.sha512sum'));
          if (archive && checksum) {
            // GitHub's list order is not necessarily publication order, and the
            // commit suffix in runtime tags is not a sortable version number.
            const parsed = typeof release.published_at === 'string' ? Date.parse(release.published_at) : NaN;
            const publication = Number.isFinite(parsed) ? parsed : -Infinity;
            // Keep an undated fallback only when no dated candidate is available.
            if (!found || publication > newestPublication) {
              found = { version, archive, checksum };
              newestPublication = publication;
            }
          }
        }
        if (!found) continue;
        this.nexusArtifact = {
          version: found.version,
          name: found.archive.name,
          url: found.archive.url,
          checksumName: found.checksum.name,
          checksumUrl: found.checksum.url,
        };
        Object.assign(this.status, { nexusAvailable: true, nexusName: found.archive.name, nexusVersion: found.version, nexusError: undefined });
        selected = true;
        break;
      }
      if (!selected) throw new Error('No Nexus runtime release has been published yet.');
    } catch (error) {
      this.nexusArtifact = undefined;
      Object.assign(this.status, { nexusAvailable: false, nexusName: undefined, nexusVersion: undefined, nexusError: (error as Error).message });
    } finally {
      this.status.nexusChecking = false;
    }
    return this.current;
  }

  private async downloadFile(url: string, target: string): Promise<void> {
    const response = await this.fetcher(url, { signal: AbortSignal.timeout(600_000) });
    if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}.`);
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(target));
  }

  async installNexus(onStatus: () => void, afterInstall?: AfterInstall): Promise<string> {
    const lease = this.reserveMutation();
    let staging: string | undefined;
    let operationError:unknown;
    try {
      onStatus();
      if (!this.nexusArtifact) await this.checkNexus();
      const artifact = this.nexusArtifact && { ...this.nexusArtifact };
      if (!artifact) throw new Error(this.status.nexusError ?? 'No Nexus runtime is available.');
      if (!this.status.prerequisites.tar || !this.status.prerequisites.sha512sum) throw new Error('tar or sha512sum is missing.');

      this.status.error = undefined;
      onStatus();
      staging = path.join(lease.root, `.staging-${randomUUID()}`);
      const downloads = path.join(staging, 'downloads');
      await fs.mkdir(downloads, { recursive: true });
      this.setPhase(`Downloading the Nexus runtime ${artifact.version}…`, onStatus);
      await this.downloadFile(artifact.url, path.join(downloads, artifact.name));
      this.setPhase('Verifying the SHA-512 checksum…', onStatus);
      await this.downloadFile(artifact.checksumUrl, path.join(downloads, artifact.checksumName));
      const checksum = (await fs.readFile(path.join(downloads, artifact.checksumName), 'utf8')).trim().match(/^([a-f0-9]{128})[ \t]+\*?([^\r\n]+)$/i);
      if (!checksum || checksum[2] !== artifact.name) throw new Error('The SHA-512 file does not identify this Nexus runtime archive.');
      const result = await run('sha512sum', ['-c', artifact.checksumName], { cwd: downloads, maxOutput: 100_000 });
      if (result.code !== 0) throw new Error('Nexus runtime SHA-512 verification failed.');

      const activation = await this.activateArchive(downloads, artifact.name, artifact.version, onStatus, nexusReleaseName(artifact.name), lease.root);
      await this.completeActivation(activation,afterInstall);
      return activation.winePath;
    } catch (error) {
      operationError=error;
      this.status.error = (error as Error).message;
      throw error;
    } finally {
      if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      lease.release();
      this.notifyCompletion(onStatus,operationError,true);
    }
  }
  async rollbackCloudSavePreview(onStatus: () => void, afterInstall?: AfterInstall): Promise<string> {
    const lease = this.reserveMutation();
    let operationError:unknown;
    try {
      onStatus();
      const current = await this.readPointer(lease.root);
      const baseName = current ? previewBaseRelease(current.name) : null;
      if (!current || !baseName) throw new Error('No cloud-save preview is active.');
      const winePath = await runtimeLoader(path.join(lease.root, 'releases', baseName), this.hostArch);
      await this.validateWine(winePath, 'The previous runtime is missing or failed validation. The preview remains active.');
      onStatus();
      const pointer: RuntimePointer = { ...current, name: baseName, winePath, installedAt: new Date().toISOString() };
      const pointerResult=await commitRuntimePointer(lease.root,pointer);
      Object.assign(this.status, { installed:true,name:baseName,winePath,commit:pointer.commit,phase:'Previous runtime restored; finishing setup.',error:undefined });
      try{this.emitLog('runtime', `Restored Wine: ${winePath}`);}catch(error){pointerResult.errors.push(new Error('Runtime activation log failed: '+(error as Error).message,{cause:error}));}
      await this.completeActivation({winePath,pointer:pointerResult},afterInstall);
      return winePath;
    } catch(error){operationError=error;this.status.error=(error as Error).message;throw error;} finally {
      lease.release();
      this.notifyCompletion(onStatus,operationError,true);
    }
  }
}
