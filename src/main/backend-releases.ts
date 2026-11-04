import { constants, promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { run } from './process.js';
import {
  BACKEND_REPOSITORIES, BACKEND_REPOSITORY, LEGACY_BACKEND_REPOSITORIES, type BackendRepository, backendPackageName, backendAssetUrl, compareVersions, minimumBackendVersion,
  validateBackendManifest, validateBackendArchive, type BackendPackageManifest,
} from './backend-package.js';
import { BACKEND_ARCH_SUFFIX, currentArch, isLinuxElf64, nexusArch, type NexusArch } from './arch.js';
import { backendDiagnostic } from './backend-diagnostics.js';

export interface BackendArtifact { repository: BackendRepository; tag: string; manifest: BackendPackageManifest; archiveUrl: string }

/** Fixed installer failure codes. Never derived from messages or paths. */
export type BackendInstallStage =
  | 'update-blocked' | 'update-manifest' | 'update-storage' | 'update-download-http' | 'update-download-limit'
  | 'update-checksum' | 'update-archive' | 'update-extract' | 'update-file-mismatch' | 'update-binary'
  | 'update-permission' | 'update-validate' | 'update-activate' | 'update-cleanup';
/** Fixed update operation stages, including the manager-owned boundaries. */
export type BackendUpdateStage = BackendInstallStage
  | 'update-platform' | 'update-stale' | 'update-discovery' | 'update-commit' | 'update-confirm' | 'update-notify';

export class BackendInstallError extends Error {
  readonly status?: number;
  constructor(readonly stage: BackendUpdateStage, cause: unknown) {
    const http = cause instanceof BackendHttpError ? cause.status : undefined;
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'BackendInstallError';
    this.status = http;
  }
}

class BackendHttpError extends Error {
  constructor(readonly status: number) { super(`Backend download failed (HTTP ${status}).`); }
}
/** Discovery transport failures may carry a fixed HTTP status without a stage. */
export function backendHttpStatus(error: unknown): number | undefined {
  return error instanceof BackendHttpError ? error.status : undefined;
}

async function bytes(url: string, fetcher: typeof fetch, limit: number): Promise<Buffer> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw new BackendHttpError(response.status);
  const parts: Uint8Array[] = [];
  const reader = response.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > limit) throw new Error('Backend metadata exceeds the download limit.');
      parts.push(chunk.value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(parts);
}

export async function discoverBackend(fetcher: typeof fetch, arch: NexusArch = currentArch()): Promise<BackendArtifact> {
  type Release = { tag_name?: string; draft?: boolean; prerelease?: boolean;
    assets?: Array<{ name?: string; browser_download_url?: string }> };
  let selected: { tag: string; version: string; repository: BackendRepository; release: Release } | undefined;
  // Prefer the fork for equal versions. An empty new repository still permits
  // installation of the compatible package previously published by the launcher.
  for (const repository of BACKEND_REPOSITORIES) {
    let releases: Release[];
    try {
      releases = JSON.parse((await bytes(`https://api.github.com/repos/${repository}/releases?per_page=100`, fetcher, 2_000_000)).toString());
    } catch (error) {
      if (error instanceof BackendHttpError && error.status === 404) continue;
      throw error;
    }
    if (!Array.isArray(releases)) throw new Error('Invalid backend release list.');
    for (const item of releases) {
      if (item.draft || item.prerelease) continue;
      const match = /^backend-v(\d+\.\d+\.\d+)$/.exec(item.tag_name ?? '');
      if (!match || compareVersions(match[1], minimumBackendVersion) < 0) continue;
      const name = backendPackageName(match[1], arch);
      const required = ['.tar.xz', '.manifest.json', '.sha512sum', '-source.tar.xz', '-source.sha512sum'];
      if (!required.every(suffix => item.assets?.some(asset => asset.name === name + suffix))) continue;
      if (!selected || compareVersions(match[1], selected.version) > 0) {
        const aliases: readonly BackendRepository[] = repository === BACKEND_REPOSITORY ? [BACKEND_REPOSITORY] : LEGACY_BACKEND_REPOSITORIES;
        const actualRepository = aliases.find(repo => required.every(suffix => {
          const assets = item.assets!.filter(asset => asset.name === name + suffix);
          return assets.length === 1 && assets[0].browser_download_url === `https://github.com/${repo}/releases/download/${item.tag_name}/${name}${suffix}`;
        }));
        if (!actualRepository) throw Error('Unexpected backend release asset URL.');
        selected = { tag: item.tag_name!, version: match[1], repository: actualRepository, release: item };
      }
    }
  }
  if (!selected) throw new Error('No compatible Nexus backend release has been published yet.');
  const tag = selected.tag;
  const packageName = backendPackageName(selected.version, arch);
  const asset = (name: string) => backendAssetUrl(tag, name, selected!.release.assets?.find(item => item.name === name)?.browser_download_url, selected!.repository);
  const archive = `${packageName}.tar.xz`;
  const manifest = validateBackendManifest(JSON.parse((await bytes(asset(`${packageName}.manifest.json`), fetcher, 100_000)).toString()), arch, selected.repository);
  if (manifest.version !== selected.version) throw new Error('The backend release does not match its manifest.');
  const checksum = (await bytes(asset(`${packageName}.sha512sum`), fetcher, 1000)).toString().trim();
  if (checksum !== `${manifest.archiveSha512}  ${archive}`) throw new Error('Backend SHA-512 manifest mismatch.');
  // Distribution must include the matching corresponding source, not just binaries.
  asset(`${packageName}-source.tar.xz`);
  asset(`${packageName}-source.sha512sum`);
  return { repository: selected.repository, tag, manifest, archiveUrl: asset(archive) };
}

export async function installBackend(
  managedRoot: string, artifact: BackendArtifact, fetcher: typeof fetch,
  validate: (cli: string) => Promise<void>, assertIdle: () => Promise<void>,
  phase: (message: string) => void, runner: typeof run = run,
): Promise<string> {
  if (process.platform !== 'linux' || !nexusArch()) throw new BackendInstallError('update-platform', new Error('The prebuilt backend supports x86_64 and arm64 Linux only.'));
  let stage: BackendInstallStage = 'update-blocked';
  let staging: string | undefined;
  let primary: BackendInstallError | undefined;
  try {
    await assertIdle();
    stage = 'update-manifest';
    const manifest = validateBackendManifest(artifact.manifest, currentArch(), artifact.repository);
    backendAssetUrl(artifact.tag, manifest.archive, artifact.archiveUrl, artifact.repository);
    const download = path.join(managedRoot, `.download-${randomUUID()}`);
    stage = 'update-storage';
    await fs.mkdir(download, { recursive: true });
    staging = download;
    phase('Downloading the Nexus backend…');
    backendDiagnostic({ operation: 'update', event: 'diagnostic', stage: 'update-download' });
    stage = 'update-download-http';
    const archive = path.join(staging, manifest.archive);
    const response = await fetcher(artifact.archiveUrl, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok || !response.body) throw new BackendHttpError(response.status);
    const reader = response.body.getReader();
    stage = 'update-storage';
    const file = await fs.open(archive, 'wx');
    const hash = createHash('sha512');
    let size = 0;
    try {
      for (;;) {
        // Transport reads and local writes fail independently; keep their fixed
        // stages separate so a broken stream is never reported as storage.
        stage = 'update-download-http';
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 256 * 1024 * 1024) throw new BackendInstallError('update-download-limit', new Error('Backend archive exceeds the download limit.'));
        hash.update(chunk.value);
        stage = 'update-storage';
        await file.writeFile(chunk.value);
      }
    } finally { await file.close(); await reader.cancel(); }
    phase('Verifying the backend checksum and archive…');
    backendDiagnostic({ operation: 'update', event: 'diagnostic', stage: 'update-verify' });
    stage = 'update-checksum';
    if (hash.digest('hex') !== manifest.archiveSha512) throw new Error('Backend SHA-512 verification failed.');
    stage = 'update-archive';
    const listing = await runner('tar', ['-tJf', archive], { maxOutput: 100_000 });
    const verbose = await runner('tar', ['-tvJf', archive], { maxOutput: 100_000 });
    if (listing.code !== 0 || verbose.code !== 0) throw new Error('The backend archive is invalid.');
    const packageName = backendPackageName(manifest.version);
    validateBackendArchive(listing.output.trimEnd().split('\n'), verbose.output.trimEnd().split('\n'), packageName);
    stage = 'update-extract';
    const extracted = path.join(staging, 'extracted');
    await fs.mkdir(extracted);
    const result = await runner('tar', ['-xJf', archive, '--no-same-owner', '--no-same-permissions', '-C', extracted]);
    if (result.code !== 0) throw new Error('Backend extraction failed.');
    const candidate = path.join(extracted, packageName);
    const verifyFiles = async (root: string) => {
      for (const [name, expected] of Object.entries(manifest.files)) {
        stage = 'update-file-mismatch';
        const target = path.join(root, name);
        if (!(await fs.lstat(target)).isFile() || createHash('sha256').update(await fs.readFile(target)).digest('hex') !== expected) {
          throw new Error(`Backend file verification failed: ${name}`);
        }
      }
      for (const name of ['xodus-cli', 'xodus-service']) {
        stage = 'update-binary';
        const header = await fs.readFile(path.join(root, name));
        if (!isLinuxElf64(header, currentArch())) {
          throw new Error(`The backend binary is not a Linux ${BACKEND_ARCH_SUFFIX[currentArch()]} ELF executable.`);
        }
        stage = 'update-permission';
        await fs.chmod(path.join(root, name), 0o755);
        await fs.access(path.join(root, name), constants.X_OK);
      }
      // Never execute xodus-service --help: it starts keychain/device auth.
      stage = 'update-validate';
      backendDiagnostic({ operation: 'update', event: 'diagnostic', stage: 'update-validate' });
      await validate(path.join(root, 'xodus-cli'));
    };
    phase('Checking backend commands and runtime libraries…');
    await verifyFiles(candidate);
    stage = 'update-blocked';
    await assertIdle();
    stage = 'update-activate';
    backendDiagnostic({ operation: 'update', event: 'diagnostic', stage: 'update-activate' });
    const release = path.join(managedRoot, 'releases', `${packageName}-${manifest.archiveSha512.slice(0, 16)}`);
    await fs.mkdir(path.dirname(release), { recursive: true });
    try { await fs.rename(candidate, release); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await verifyFiles(release);
    }
    stage = 'update-storage';
    await fs.writeFile(path.join(release, 'metadata.json'), JSON.stringify(manifest, null, 2));
    return path.join(release, 'xodus-cli');
  } catch (error) {
    primary = error instanceof BackendInstallError ? error : new BackendInstallError(stage, error);
    throw primary;
  } finally {
    if (staging) {
      try { await fs.rm(staging, { recursive: true, force: true }); }
      catch (cleanupError) {
        // A cleanup failure is reported separately and must never replace the
        // captured installer failure, its user-facing reason or its stage.
        backendDiagnostic({ operation: 'update', event: 'diagnostic', stage: 'update-cleanup' });
        if (!primary) {
          throw new BackendInstallError('update-cleanup', new Error(
            'The backend update staging area could not be removed. Check available disk space and profile permissions, then retry.',
            { cause: cleanupError }));
        }
      }
    }
  }
}
