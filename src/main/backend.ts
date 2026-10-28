import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { BackendCapabilities, BackendStatus } from '../shared/types.js';
import { parseBackendHelp } from '../shared/utils.js';
import { run } from './process.js';
import { backendLock, backendRecipeSha256, backendAssets, compareVersions } from './backend-package.js';
import { discoverBackend, installBackend, type BackendArtifact } from './backend-releases.js';
import { BackendPrerequisiteError, backendPrerequisiteFailure } from './backend-prerequisites.js';

const REPOSITORY = backendLock.repository;
export const LINUX_RUN_PATCH = backendLock.compatibility;
const LINUX_RUN_RELEASE = backendLock.patchId;
const EMPTY_CAPABILITIES: BackendCapabilities = {
  commands: [], account: false, login: false, logout: false, download: false, streaming: false, run: false,
};

interface ManagedPointer { commit: string; binaryPath: string; builtAt: string; linuxRunPatch?: string; recipeSha256?: string; version?: string; delivery?: 'release' | 'local' }

export class BackendManager {
  private status: BackendStatus;
  private readonly managedRoot: string;
  private readonly pointerFile: string;
  private emitLog: (scope: string, line: string) => void;
  private isOperationActive: () => boolean;
  private artifact?: BackendArtifact;
  private probeFailure?: string;

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
      prerequisites: { git: false, cargo: false, rustc: false, protoc: false },
    };
  }

  get current(): BackendStatus { return structuredClone(this.status); }

  setExternalRoot(root: string): void { this.status.externalRoot = root; }

  private async commandExists(command: string): Promise<boolean> {
    try { return (await run(command, ['--version'], { maxOutput: 20_000 })).code === 0; } catch { return false; }
  }

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
    const [git, cargo, rustc, protoc] = await Promise.all([
      this.commandExists('git'), this.commandExists('cargo'), this.commandExists('rustc'), this.commandExists('protoc'),
    ]);
    this.status.prerequisites = { git, cargo, rustc, protoc };

    let validationFailure: string | undefined;
    const validate = (binary: string) => this.validate(binary).catch(error => {
      if (error instanceof BackendPrerequisiteError) validationFailure ??= error.message;
      return null;
    });
    const pointer = await this.readPointer();
    if (pointer) {
      const capabilities = await validate(pointer.binaryPath);
      if (capabilities) {
        this.probeFailure = undefined;
        Object.assign(this.status, {
          available: true, source: 'managed', binaryPath: pointer.binaryPath,
          commit: pointer.commit, capabilities, blockReason: undefined,
          linuxRunPatch: pointer.linuxRunPatch,
          version: pointer.version, delivery: pointer.delivery,
        });
        return this.current;
      }
    }

    const externalBinary = path.join(this.status.externalRoot, 'target', 'release', 'xodus-cli');
    const capabilities = await validate(externalBinary);
    if (capabilities) {
      this.probeFailure = undefined;
      Object.assign(this.status, {
        available: true, source: 'external', binaryPath: externalBinary,
        commit: await this.gitCommit(this.status.externalRoot), capabilities, blockReason: undefined,
        linuxRunPatch: undefined,
        version: undefined, delivery: undefined,
      });
    } else {
      this.probeFailure = validationFailure;
      Object.assign(this.status, {
        available: false, source: 'none', binaryPath: undefined, commit: undefined,
        version: undefined, delivery: undefined, linuxRunPatch: undefined,
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
      this.status.updateAvailable = !this.status.available || pointer?.delivery !== 'release' ||
        !pointer?.version || compareVersions(pointer.version, this.artifact.manifest.version) < 0;
      this.status.blockReason = this.status.available ? undefined : this.probeFailure;
    } catch (error) {
      this.artifact = undefined;
      this.status.releaseAvailable = false;
      this.status.updateAvailable = false;
      const message = (error as Error).message;
      this.status.blockReason = message.startsWith('No compatible Nexus backend release')
        ? message : `Backend release check failed: ${message}`;
    } finally { this.status.checking = false; }
    return this.current;
  }

  async update(onStatus: () => void): Promise<void> {
    await this.assertUpdateAllowed();
    if (this.status.updating) throw new Error('A backend installation is already running.');
    this.status.updating = true;
    this.status.blockReason = undefined;
    onStatus();
    try {
      // Refresh discovery at install time; do not use a stale candidate.
      this.artifact = await discoverBackend(this.fetcher);
      const binaryPath = await installBackend(this.managedRoot, this.artifact, this.fetcher, async cli => {
        const caps = await this.validate(cli);
        if (!caps?.account || !caps.run || !caps.streaming || !caps.login || !caps.logout || !caps.download || !caps.externalAuth || !caps.packageSelection) {
          throw new Error('Backend validation failed. The prebuilt build requires glibc 2.35 or newer, OpenSSL 3 and D-Bus runtime libraries.');
        }
        const help = await run(cli, ['run', '--help'], { maxOutput: 100_000 });
        if (help.code !== 0 || !help.output.includes('--materialize-chain')) throw new Error('Backend launch-chain validation failed.');
      }, () => this.assertUpdateAllowed(), message => {
        this.status.phase = message; this.emitLog('backend', message); onStatus();
      });
      await this.assertUpdateAllowed();
      const manifest = this.artifact.manifest;
      const pointer: ManagedPointer = { commit: manifest.commit, binaryPath, builtAt: new Date().toISOString(),
        linuxRunPatch: manifest.compatibility, recipeSha256: manifest.recipeSha256, version: manifest.version, delivery: 'release' };
      const temporary = `${this.pointerFile}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, JSON.stringify(pointer, null, 2)); await fs.rename(temporary, this.pointerFile); }
      finally { await fs.rm(temporary, { force: true }); }
      await this.refresh();
      Object.assign(this.status, { releaseAvailable: true, releaseVersion: manifest.version, updateAvailable: false, phase: 'Backend is ready.' });
    } catch (error) {
      this.status.blockReason = (error as Error).message;
      this.status.phase = 'Backend update failed; the previous backend was kept.';
      throw error;
    } finally { this.status.updating = false; onStatus(); }
  }

  async rebuild(onStatus: () => void): Promise<void> {
    await this.assertUpdateAllowed();
    if (this.status.updating) throw new Error('A backend installation is already running.');
    if (!this.status.prerequisites.git || !this.status.prerequisites.cargo || !this.status.prerequisites.rustc || !this.status.prerequisites.protoc) {
      throw new Error('Git, Cargo, Rust, or protoc is missing. Check the build dependencies in Settings.');
    }
    this.status.updating = true;
    this.status.blockReason = undefined;
    onStatus();
    await fs.mkdir(path.join(this.managedRoot, 'releases'), { recursive: true });
    const staging = path.join(this.managedRoot, `.staging-${randomUUID()}`);
    const log = (line: string) => this.emitLog('backend', line);
    try {
      for (const patch of backendLock.patches) {
        if (createHash('sha256').update(await fs.readFile(path.join(backendAssets, patch.file))).digest('hex') !== patch.sha256) throw new Error('Backend patch checksum mismatch.');
      }
      log(`Cloning the pinned Xodus source ${backendLock.commit}…`);
      let result = await run('git', ['clone', '--no-checkout', REPOSITORY, staging], { onLine: log });
      if (result.code !== 0) throw new Error(`git clone exited with code ${result.code}`);
      result = await run('git', ['-C', staging, 'checkout', '--detach', backendLock.commit], { onLine: log });
      if (result.code !== 0) throw new Error('Pinned backend checkout failed.');
      const commit = (await run('git', ['-C', staging, 'rev-parse', 'HEAD'])).output.trim();
      if (commit !== backendLock.commit || createHash('sha256').update(await fs.readFile(path.join(staging, 'Cargo.lock'))).digest('hex') !== backendLock.cargoLockSha256) throw new Error('Backend source lock mismatch.');
      for (const patch of backendLock.patches) {
        const patchFile = path.join(staging, `.nexus-${patch.file}`);
        await fs.writeFile(patchFile, await fs.readFile(path.join(backendAssets, patch.file)));
        log(`Applying ${patch.file}…`);
        result = await run('git', ['-C', staging, 'apply', '--check', patchFile], { onLine: log, maxOutput: 100_000 });
        if (result.code !== 0) throw new Error(`The pinned backend patch ${patch.file} does not apply; the previous backend remains active.`);
        result = await run('git', ['-C', staging, 'apply', patchFile], { onLine: log, maxOutput: 100_000 });
        if (result.code !== 0) throw new Error(`Backend patch ${patch.file} could not be applied.`);
      }
      const target = path.join(staging, 'target');
      log(`Building ${commit.slice(0, 10)} with Cargo…`);
      result = await run('cargo', ['build', '--locked', '--release', '--no-default-features', '-p', 'xodus-cli', '-p', 'xodus-service'], {
        cwd: staging,
        env: { ...process.env, CARGO_TARGET_DIR: target },
        onLine: log,
        maxOutput: 5_000_000,
      });
      if (result.code !== 0) throw new Error(`cargo build exited with code ${result.code}`);
      const builtCli = path.join(target, 'release', 'xodus-cli');
      const capabilities = await this.validate(builtCli);
      if (!capabilities?.login || !capabilities.streaming || !capabilities.account || !capabilities.externalAuth || !capabilities.packageSelection) throw new Error('The built backend failed command validation.');
      const runHelp = await run(builtCli, ['run', '--help'], { maxOutput: 100_000 });
      if (runHelp.code !== 0 || !runHelp.output.includes('--materialize-chain')) throw new Error('The built backend lacks launch-chain support.');
      await this.assertUpdateAllowed();

      const releaseDir = path.join(this.managedRoot, 'releases', `${commit}-${LINUX_RUN_RELEASE}-local-${randomUUID()}`);
      await fs.mkdir(releaseDir, { recursive: true });
      const managedCli = path.join(releaseDir, 'xodus-cli');
      await fs.copyFile(builtCli, managedCli);
      await fs.chmod(managedCli, 0o755);
      const builtService = path.join(target, 'release', 'xodus-service');
      await fs.copyFile(builtService, path.join(releaseDir, 'xodus-service'));
      await fs.chmod(path.join(releaseDir, 'xodus-service'), 0o755);
      await fs.writeFile(path.join(releaseDir, 'metadata.json'), JSON.stringify({ commit, builtAt: new Date().toISOString(), capabilities, linuxRunPatch: LINUX_RUN_PATCH }, null, 2));
      const pointer: ManagedPointer = { commit, binaryPath: managedCli, builtAt: new Date().toISOString(), linuxRunPatch: LINUX_RUN_PATCH,
        recipeSha256: backendRecipeSha256, version: backendLock.version, delivery: 'local' };
      const pointerTmp = `${this.pointerFile}.tmp`;
      await fs.writeFile(pointerTmp, JSON.stringify(pointer, null, 2));
      await fs.rename(pointerTmp, this.pointerFile);
      Object.assign(this.status, {
        available: true, source: 'managed', binaryPath: managedCli, commit,
        upstreamCommit: commit, updateAvailable: false, capabilities, linuxRunPatch: LINUX_RUN_PATCH,
      });
      log('The new backend passed validation and was activated atomically. Older builds were preserved.');
    } catch (error) {
      this.status.blockReason = (error as Error).message;
      throw error;
    } finally {
      this.status.updating = false;
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      onStatus();
    }
  }
}
