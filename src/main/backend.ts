import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { BackendCapabilities, BackendStatus } from '../shared/types.js';
import { parseBackendHelp } from '../shared/utils.js';
import { run } from './process.js';
import { backendLock, compareVersions } from './backend-package.js';
import { discoverBackend, installBackend, prepareLocalBackend, backendHttpStatus, type BackendArtifact, BackendInstallError, type BackendUpdateStage } from './backend-releases.js';
import { backendDiagnostic } from './backend-diagnostics.js';
import type { PreparedComponentUpdate } from './component-updates.js';
import { BackendPrerequisiteError, backendPrerequisiteFailure } from './backend-prerequisites.js';

export const LINUX_RUN_PATCH = backendLock.compatibility;
const EMPTY_CAPABILITIES: BackendCapabilities = {
  commands: [], account: false, login: false, logout: false, download: false, streaming: false, run: false,
};

interface ManagedPointer { commit: string; binaryPath: string; builtAt: string; linuxRunPatch?: string; recipeSha256?: string; version?: string; delivery?: 'release' | 'local'; localBuild?: true; diagnosticOnly?: true; promotable?: false }
type BackendMutation = 'update';
export type BackendMutationTarget = Readonly<Pick<ManagedPointer, 'commit' | 'binaryPath' | 'version' | 'delivery' | 'linuxRunPatch' | 'recipeSha256'>>;
/** Publication of current.json is a commit boundary, not a durability claim. */
export class BackendMutationError extends Error {
  readonly target?: BackendMutationTarget;
  constructor(cause: unknown, readonly operation: BackendMutation, readonly committed: boolean, target?: BackendMutationTarget) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'BackendMutationError';
    this.target = target ? Object.freeze({ ...target }) : undefined;
  }
}

export class BackendManager {
  private status: BackendStatus;
  private readonly managedRoot: string;
  private readonly pointerFile: string;
  private emitLog: (scope: string, line: string) => void;
  private isOperationActive: () => boolean;
  private artifact?: BackendArtifact;
  private probeFailure?: string;
  private reconciliationEpoch = 0;
  private refreshSequence = 0;

  constructor(
    userData: string,
    externalRoot: string,
    emitLog: (scope: string, line: string) => void,
    isOperationActive: () => boolean,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.managedRoot = path.join(userData, 'xodus-backends');
    this.pointerFile = path.join(this.managedRoot, 'current.json');
    this.emitLog = emitLog;
    this.isOperationActive = isOperationActive;
    this.status = {
      available: false,
      source: 'none',
      updateAvailable: false,
      checking: false,
      updating: false,
      externalRoot,
      capabilities: EMPTY_CAPABILITIES,
    };
  }

  get current(): BackendStatus { return structuredClone(this.status); }

  setExternalRoot(root: string): void { this.status.externalRoot = root; this.reconciliationEpoch++; }

  private async validate(binaryPath: string): Promise<BackendCapabilities | null> {
    try {
      await fs.access(binaryPath, constants.X_OK);
      const result = await run(binaryPath, ['--help'], { maxOutput: 100_000 });
      if (result.code !== 0) {
        const failure = backendPrerequisiteFailure(result.output);
        if (failure) throw new BackendPrerequisiteError(failure.message);
        return null;
      }
      const capabilities = parseBackendHelp(result.output);
      if (capabilities.streaming) {
        const streaming = await run(binaryPath, ['streaming', '--help'], { maxOutput: 100_000 });
        capabilities.streamingProgressJson = streaming.code === 0 && /(?:^|\s)--progress-json(?:\s|$)/m.test(streaming.output);
        capabilities.streamingControls = Boolean(capabilities.streamingProgressJson && /(?:^|\s)--control-stdin(?:\s|$)/m.test(streaming.output));
        capabilities.streamingBandwidthLimit = Boolean(capabilities.streamingControls && /(?:^|\s)--download-limit-kib(?:\s|$)/m.test(streaming.output));
        capabilities.streamingUpdateRecovery = streaming.code === 0 && /^Nexus capabilities: update-recovery-v1\s*$/m.test(streaming.output);
        capabilities.packageSelection = streaming.code === 0 && capabilities.commands.includes('resolve-package') && /(?:^|\s)--selected-content-id(?:\s|$)/m.test(streaming.output);
        if (capabilities.packageSelection) {
          const help = await run(binaryPath, ['resolve-package', '--help'], { maxOutput: 100_000 });
          capabilities.contentPackageSelection = help.code === 0 && /(?:^|\s)--include-dlc(?:\s|$)/m.test(help.output);
        }
      }
      if (capabilities.run) {
        const launch = await run(binaryPath, ['run', '--help'], { maxOutput: 100_000 });
        const designation = capabilities.offlinePc ? await run(binaryPath, ['offline-pc', '--help'], { maxOutput: 100_000 }) : undefined;
        // Only a backend that also revokes stored licenses when Microsoft reports
        // the device as undesignated may keep them.
        capabilities.licenseCache = launch.code === 0 && /(?:^|\s)--license-cache(?:\s|$)/m.test(launch.output)
          && designation?.code === 0 && /(?:^|\s)--license-cache(?:\s|$)/m.test(designation.output);
        capabilities.offlineLaunch = Boolean(capabilities.licenseCache && /(?:^|\s)--offline(?:\s|$)/m.test(launch.output));
      }
      if (capabilities.login) {
        const login = await run(binaryPath, ['login', '--help'], { maxOutput: 100_000 });
        capabilities.playerAccount = login.code === 0 && /(?:^|\s)--player(?:\s|$)/m.test(login.output);
        const profileHelp = await run(binaryPath, ['profile', '--help']);
        capabilities.licenseProfile = profileHelp.code === 0 && /(?:^|\s)--license(?:\s|$)/m.test(profileHelp.output);
        const saved = await run(binaryPath, ['saved-accounts', '--help']);
        capabilities.savedAccounts = saved.code === 0 && /(?:^|\s)--enable(?:\s|$)/m.test(saved.output);
      }
      return capabilities.login && capabilities.streaming ? capabilities : null;
    } catch (error) { if (error instanceof BackendPrerequisiteError) throw error; return null; }
  }

  private async gitCommit(root: string): Promise<string | undefined> {
    try {
      const result = await run('git', ['-C', root, 'rev-parse', 'HEAD'], { maxOutput: 10_000 });
      return result.code === 0 ? result.output.trim() : undefined;
    } catch { return undefined; }
  }

  private async readPointer(): Promise<ManagedPointer | null> {
    try { return JSON.parse(await fs.readFile(this.pointerFile, 'utf8')) as ManagedPointer; } catch { return null; }
  }

  async refresh(): Promise<BackendStatus> {
    const epoch = this.reconciliationEpoch, sequence = ++this.refreshSequence;
    const externalRoot = this.status.externalRoot;
    const current = () => epoch === this.reconciliationEpoch && sequence === this.refreshSequence;

    let validationFailure: string | undefined;
    const validate = (binary: string) => this.validate(binary).catch(error => {
      if (error instanceof BackendPrerequisiteError) validationFailure ??= error.message;
      return null;
    });
    const pointer = await this.readPointer();
    if (pointer) {
      const capabilities = await validate(pointer.binaryPath);
      if (!current()) return this.current;
      if (capabilities) {
        this.probeFailure = undefined;
        Object.assign(this.status, {
          available: true, source: 'managed', binaryPath: pointer.binaryPath,
          commit: pointer.commit, capabilities, blockReason: undefined,
          linuxRunPatch: pointer.linuxRunPatch, recipeSha256: pointer.recipeSha256,
          version: pointer.version, delivery: pointer.delivery,
        });
        return this.current;
      }
    }

    const externalBinary = path.join(externalRoot, 'target', 'release', 'xodus-cli');
    const capabilities = await validate(externalBinary);
    const commit = capabilities ? await this.gitCommit(externalRoot) : undefined;
    if (!current()) return this.current;
    if (capabilities) {
      this.probeFailure = undefined;
      Object.assign(this.status, {
        available: true, source: 'external', binaryPath: externalBinary,
        commit, capabilities, blockReason: undefined,
        linuxRunPatch: undefined, recipeSha256: undefined,
        version: undefined, delivery: undefined,
      });
    } else {
      this.probeFailure = validationFailure;
      Object.assign(this.status, {
        available: false, source: 'none', binaryPath: undefined, commit: undefined,
        version: undefined, delivery: undefined, linuxRunPatch: undefined, recipeSha256: undefined,
        capabilities: EMPTY_CAPABILITIES,
        blockReason: validationFailure ?? 'No validated xodus-cli with login and streaming commands was found.',
      });
    }
    return this.current;
  }

  async externalDownloadRunning(): Promise<boolean> {
    try {
      const result = await run('ps', ['-eo', 'args='], { maxOutput: 2_000_000 });
      return result.output.split('\n').some((line) => {
        const lower = line.toLowerCase();
        return lower.includes('xodus-cli') && /\s(streaming|download)\s/.test(lower);
      });
    } catch { return false; }
  }

  private async assertUpdateAllowed(): Promise<void> {
    if (this.isOperationActive()) throw new Error('The backend cannot be updated while authentication, a download, or a game is active.');
    if (await this.externalDownloadRunning()) throw new Error('An external Xodus download is active. The update was blocked.');
  }

  async checkUpdate(): Promise<BackendStatus> {
    this.status.checking = true;
    try {
      this.artifact = await discoverBackend(this.fetcher);
      const pointer = await this.readPointer();
      this.status.releaseAvailable = true;
      this.status.releaseVersion = this.artifact.manifest.version;
      const remote = this.artifact.manifest.version;
      const comparison = pointer?.version ? compareVersions(pointer.version, remote) : -1;
      // A local build is offered the exact official same version, but never an
      // automatic downgrade to an older published release.
      this.status.updateAvailable = !this.status.available || !pointer?.version || comparison < 0
        || (pointer?.delivery === 'local' && pointer.version === remote);
      this.status.blockReason = this.status.available ? undefined : this.probeFailure;
    } catch (error) {
      this.artifact = undefined;
      this.status.releaseAvailable = false;
      this.status.updateAvailable = false;
      const message = (error as Error).message;
      this.status.blockReason = message.startsWith('No compatible Nexus backend release')
        ? message : `Backend release check failed: ${message}`;
      // A read-only discovery failure is not an install attempt, so the fixed
      // stage differs from install discovery and no state is mutated.
      backendDiagnostic({ operation: 'update', event: 'failure', stage: 'update-check-failed', committed: false,
        status: backendHttpStatus(error) });
    } finally { this.status.checking = false; }
    return this.current;
  }

  async prepareComponentUpdate(onStatus: () => void): Promise<PreparedComponentUpdate> {
    const before = await fs.readFile(this.pointerFile, 'utf8').catch(() => undefined);
    const externalRoot = this.status.externalRoot;
    let pointer: ManagedPointer | undefined;
    try { pointer = before === undefined ? undefined : JSON.parse(before) as ManagedPointer; } catch { /* Ineligible malformed pointer. */ }
    const eligible = this.status.available && this.status.source === 'managed' && pointer?.delivery === 'release' && pointer.binaryPath === this.status.binaryPath;
    const item = { id: 'backend', component: 'backend' as const, label: 'Backend', currentVersion: pointer?.version,
      state: 'skipped' as 'ready' | 'skipped' | 'unchanged', reason: 'Only an installed managed backend release is updated automatically.' };
    let target: BackendMutationTarget | undefined;
    const same = async () => before === await fs.readFile(this.pointerFile, 'utf8').catch(() => undefined) && externalRoot === this.status.externalRoot;
    if (!eligible || !pointer) return { item, isCurrent: same, apply: async () => { throw Error(item.reason); } };
    const artifact = await discoverBackend(this.fetcher);
    const newer = !pointer.version || compareVersions(pointer.version, artifact.manifest.version) < 0;
    return {
      item: { ...item, targetVersion: artifact.manifest.version, state: newer ? 'ready' : 'unchanged', reason: undefined },
      isCurrent: same,
      apply: async () => {
        try { await this.performUpdate(onStatus, artifact, same); target = { commit: this.status.commit!, binaryPath: this.status.binaryPath!, version: this.status.version, delivery: this.status.delivery, linuxRunPatch: this.status.linuxRunPatch, recipeSha256: this.status.recipeSha256 }; }
        catch (error) { if (error instanceof BackendMutationError && error.committed) target = error.target; throw error; }
        return { committed: true };
      },
      reconcile: async () => {
        const pointer = await this.readPointer();
        if (!target || !pointer || (['binaryPath','commit','version','delivery','linuxRunPatch','recipeSha256'] as const).some(key=>pointer[key]!==target![key]) || !await this.matchesPreparedPayload(target,artifact)) throw Object.assign(Error('The activated backend changed. Check again.'), {retryable:false});
        const refreshed = await this.refresh();
        if (!refreshed.available || refreshed.source !== 'managed' || refreshed.binaryPath !== target.binaryPath) throw Error('The activated backend is not available.');
        onStatus(); return {};
      },
    };
  }

  private async matchesPreparedPayload(target: BackendMutationTarget, artifact: BackendArtifact): Promise<boolean> {
      try {
          const directory = path.dirname(target.binaryPath), relative = path.relative(this.managedRoot, directory);
          if (relative.startsWith('..') || path.isAbsolute(relative))
              return false;
          let parent = this.managedRoot;
          for (const part of ['', ...relative.split(path.sep)]) {
              parent = path.join(parent, part);
              if (!(await fs.lstat(parent)).isDirectory())
                  return false;
          }
          for (const [name, expected] of Object.entries(artifact.manifest.files)) {
              const filename = path.join(directory, name), before = await fs.lstat(filename);
              if (!before.isFile())
                  return false;
              const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
              try {
                  const opened = await file.stat();
                  if (opened.dev !== before.dev || opened.ino !== before.ino)
                      return false;
                  const digest = createHash('sha256');
                  for await (const bytes of file.createReadStream({ autoClose: false }))
                      digest.update(bytes);
                  const after = await file.stat(), named = await fs.lstat(filename);
                  if (digest.digest('hex') !== expected || before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || named.dev !== before.dev || named.ino !== before.ino || named.ctimeMs !== before.ctimeMs)
                      return false;
              }
              finally {
                  await file.close();
              }
          }
          return true;
      }
      catch {
          return false;
      }
  }

  async importLocal(directory: unknown, onStatus: () => void): Promise<BackendStatus> {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw Error('Choose an absolute local backend build directory.');
    let prepared: Awaited<ReturnType<typeof prepareLocalBackend>> | undefined;
    try {
      prepared = await prepareLocalBackend(directory, this.managedRoot);
      await this.performUpdate(onStatus, prepared.artifact);
      return this.current;
    }
    finally { if (prepared) await prepared.cleanup(); }
  }

  async update(onStatus: () => void): Promise<void> { return this.performUpdate(onStatus); }

  private async performUpdate(onStatus: () => void, selected?: BackendArtifact, expectedCurrent?: () => Promise<boolean>): Promise<void> {
    if (this.status.updating) {
      backendDiagnostic({ operation: 'update', event: 'failure', stage: 'update-blocked', committed: false });
      throw new Error('A backend installation is already running.');
    }
    // Reserve before the first awaited external activity check. Notification
    // failures must also release this reservation.
    this.status.updating = true;
    this.reconciliationEpoch++;
    this.status.blockReason = undefined;
    let committed = false;
    let failure: BackendMutationError | undefined;
    let target: BackendMutationTarget | undefined;
    let reconciled = false;
    const started = performance.now();
    // Fixed installer stages only. No messages, paths, URLs or child output.
    let stage: BackendUpdateStage = 'update-blocked';
    backendDiagnostic({ operation: 'update', event: 'start' });
    try {
      onStatus();
      await this.assertUpdateAllowed();
      // Keep this operation's verified target independent of later read-only
      // release checks, which may replace the manager's discovery cache.
      stage = 'update-stale';
      if (expectedCurrent && !await expectedCurrent()) throw Error('The installed backend changed. Check again.');
      stage = 'update-discovery';
      const artifact = selected ?? await discoverBackend(this.fetcher);
      if (!selected) this.artifact = artifact;
      stage = 'update-storage';
      const binaryPath = await installBackend(this.managedRoot, artifact, this.fetcher, async cli => {
        const caps = await this.validate(cli);
        if (!caps?.account || !caps.run || !caps.streaming || !caps.login || !caps.logout || !caps.download || !caps.externalAuth || !caps.packageSelection) {
          throw new Error('Backend validation failed. The prebuilt build requires glibc 2.35 or newer, OpenSSL 3 and D-Bus runtime libraries.');
        }
        const help = await run(cli, ['run', '--help'], { maxOutput: 100_000 });
        if (help.code !== 0 || !help.output.includes('--materialize-chain')) throw new Error('Backend launch-chain validation failed.');
      }, () => this.assertUpdateAllowed(), message => {
        this.status.phase = message; this.emitLog('backend', message); onStatus();
      });
      stage = 'update-blocked';
      await this.assertUpdateAllowed();
      stage = 'update-stale';
      if (expectedCurrent && !await expectedCurrent()) throw Error('The installed backend changed before activation. Check again.');
      const manifest = artifact.manifest;
      const pointer: ManagedPointer = { commit: manifest.commit, binaryPath, builtAt: new Date().toISOString(),
        linuxRunPatch: manifest.compatibility, recipeSha256: manifest.recipeSha256, version: manifest.version, delivery: artifact.delivery ?? 'release',
        ...(artifact.delivery === 'local' ? { localBuild: true as const, diagnosticOnly: true as const, promotable: false as const } : {}) };
      target = { commit: pointer.commit, binaryPath, version: pointer.version, delivery: pointer.delivery, linuxRunPatch: pointer.linuxRunPatch, recipeSha256: pointer.recipeSha256 };
      const temporary = `${this.pointerFile}.${randomUUID()}.tmp`;
      stage = 'update-commit';
      try {
        await fs.writeFile(temporary, JSON.stringify(pointer, null, 2));
        await fs.rename(temporary, this.pointerFile);
        committed = true;
        this.reconciliationEpoch++;
      } finally {
        // Rename consumed our temporary path. Never remove a replacement file
        // created at that name after publication.
        if (!committed) await fs.rm(temporary, { force: true });
      }
      Object.assign(this.status, { available: false, capabilities: EMPTY_CAPABILITIES, source: 'managed', binaryPath, commit: manifest.commit,
        linuxRunPatch: manifest.compatibility, recipeSha256: manifest.recipeSha256,
        version: manifest.version, delivery: artifact.delivery ?? 'release', phase: 'Backend activated; checking availability.' });
      stage = 'update-confirm';
      backendDiagnostic({ operation: 'update', event: 'diagnostic', stage: 'update-confirm' });
      const refreshed = await this.refresh();
      if (!refreshed.available || refreshed.source !== 'managed' || refreshed.binaryPath !== binaryPath) {
        throw new Error('The selected backend could not be confirmed after activation.');
      }
      reconciled = true;
      if (artifact.delivery === 'local') {
        // The local build is not a published release. A later explicit check
        // may offer the exact official same version, never an older downgrade.
        Object.assign(this.status, { releaseAvailable: false, releaseVersion: undefined, updateAvailable: false, phase: 'Backend is ready.' });
      }
      else {
        // A concurrent read-only check may have discovered a newer release.
        const cached = this.artifact?.manifest;
        const latest = cached && compareVersions(cached.version, manifest.version) >= 0 ? cached : manifest;
        Object.assign(this.status, { releaseAvailable: Boolean(latest), releaseVersion: latest?.version,
          updateAvailable: Boolean(latest && compareVersions(manifest.version, latest.version) < 0), phase: 'Backend is ready.' });
      }
      backendDiagnostic({ operation: 'update', event: 'diagnostic', stage: 'update-ready' });
    } catch (error) {
      const failureStage = error instanceof BackendInstallError ? error.stage : stage;
      backendDiagnostic({ operation: 'update', event: 'failure', stage: failureStage, committed,
        status: error instanceof BackendInstallError ? error.status : backendHttpStatus(error) });
      if (committed && !reconciled) Object.assign(this.status, { available: false, capabilities: EMPTY_CAPABILITIES,
        source: 'managed', ...target });
      failure = this.mutationFailure('update', error, committed, target);
      throw failure;
    } finally {
      this.status.updating = false;
      backendDiagnostic({ operation: 'update', event: 'exit', code: reconciled ? 0 : -1, elapsedMs: performance.now() - started });
      try { this.notifyMutation('update', onStatus, committed, target, failure); }
      catch (error) {
        backendDiagnostic({ operation: 'update', event: 'failure', stage: 'update-notify', committed });
        throw error;
      }
    }
  }

  private mutationFailure(operation: BackendMutation, error: unknown, committed: boolean, target?: BackendMutationTarget): BackendMutationError {
    const failure = new BackendMutationError(error, operation, committed, target);
    this.status.blockReason = failure.message;
    this.status.phase = committed ? 'Backend activated; finishing setup needs attention.' : 'Backend update failed; no new backend was activated.';
    return failure;
  }

  private notifyMutation(operation: BackendMutation, onStatus: () => void, committed: boolean, target?: BackendMutationTarget, failure?: BackendMutationError): void {
    try { onStatus(); } catch (error) {
      const reason = failure ? new AggregateError([failure, error], failure.message + ' Status notification failed.') : error;
      throw this.mutationFailure(operation, reason, committed, target);
    }
  }

}
