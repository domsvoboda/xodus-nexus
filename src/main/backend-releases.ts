import { constants, promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { run } from './process.js';
import {
  BACKEND_REPOSITORY, backendPackageName, backendAssetUrl, compareVersions, minimumBackendVersion,
  validateBackendManifest, validateBackendArchive, type BackendPackageManifest,
} from './backend-package.js';
import { BACKEND_ARCH_SUFFIX, currentArch, isLinuxElf64, nexusArch, type NexusArch } from './arch.js';

export interface BackendArtifact { tag: string; manifest: BackendPackageManifest; archiveUrl: string }

async function bytes(url: string, fetcher: typeof fetch, limit: number): Promise<Buffer> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw new Error(`Backend download failed (HTTP ${response.status}).`);
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
  const releases = JSON.parse((await bytes(`https://api.github.com/repos/${BACKEND_REPOSITORY}/releases?per_page=100`, fetcher, 2_000_000)).toString()) as Array<{
    tag_name?: string; draft?: boolean; prerelease?: boolean;
    assets?: Array<{ name?: string; browser_download_url?: string }>;
  }>;
  if (!Array.isArray(releases)) throw new Error('Invalid backend release list.');
  // The Electron-hosted backend requires the updated launcher.
  let selected: { tag: string; version: string; release: NonNullable<typeof releases[number]> } | undefined;
  for (const item of releases) {
    if (item.draft || item.prerelease) continue;
    const match = /^backend-v(\d+\.\d+\.\d+)$/.exec(item.tag_name ?? '');
    if (!match || compareVersions(match[1], minimumBackendVersion) < 0) continue;
    // A newer release may not ship this architecture. Never select its other
    // architecture or let it hide the newest complete matching release.
    const name = backendPackageName(match[1], arch);
    const required = ['.tar.xz', '.manifest.json', '.sha512sum', '-source.tar.xz', '-source.sha512sum'];
    if (!required.every(suffix => item.assets?.some(asset => asset.name === name + suffix))) continue;
    if (!selected || compareVersions(match[1], selected.version) > 0) selected = { tag: item.tag_name!, version: match[1], release: item };
  }
  if (!selected) throw new Error('No compatible Nexus backend release has been published yet.');
  const tag = selected.tag;
  const packageName = backendPackageName(selected.version, arch);
  const asset = (name: string) => backendAssetUrl(tag, name, selected!.release.assets?.find(item => item.name === name)?.browser_download_url);
  const archive = `${packageName}.tar.xz`;
  const manifest = validateBackendManifest(JSON.parse((await bytes(asset(`${packageName}.manifest.json`), fetcher, 100_000)).toString()), arch);
  if (manifest.version !== selected.version) throw new Error('The backend release does not match its manifest.');
  const checksum = (await bytes(asset(`${packageName}.sha512sum`), fetcher, 1000)).toString().trim();
  if (checksum !== `${manifest.archiveSha512}  ${archive}`) throw new Error('Backend SHA-512 manifest mismatch.');
  // Distribution must include the matching corresponding source, not just binaries.
  asset(`${packageName}-source.tar.xz`);
  asset(`${packageName}-source.sha512sum`);
  return { tag, manifest, archiveUrl: asset(archive) };
}

export async function installBackend(
  managedRoot: string, artifact: BackendArtifact, fetcher: typeof fetch,
  validate: (cli: string) => Promise<void>, assertIdle: () => Promise<void>,
  phase: (message: string) => void, runner: typeof run = run,
): Promise<string> {
  if (process.platform !== 'linux' || !nexusArch()) throw new Error('The prebuilt backend supports x86_64 and arm64 Linux only.');
  await assertIdle();
  const manifest = validateBackendManifest(artifact.manifest);
  const staging = path.join(managedRoot, `.download-${randomUUID()}`);
  await fs.mkdir(staging, { recursive: true });
  try {
    phase('Downloading the Nexus backend…');
    const archive = path.join(staging, manifest.archive);
    const response = await fetcher(artifact.archiveUrl, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok || !response.body) throw new Error(`Backend download failed (HTTP ${response.status}).`);
    const reader = response.body.getReader();
    const file = await fs.open(archive, 'wx');
    const hash = createHash('sha512');
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 256 * 1024 * 1024) throw new Error('Backend archive exceeds the download limit.');
        hash.update(chunk.value);
        await file.writeFile(chunk.value);
      }
    } finally { await file.close(); await reader.cancel(); }
    phase('Verifying the backend checksum and archive…');
    if (hash.digest('hex') !== manifest.archiveSha512) throw new Error('Backend SHA-512 verification failed.');
    const listing = await runner('tar', ['-tJf', archive], { maxOutput: 100_000 });
    const verbose = await runner('tar', ['-tvJf', archive], { maxOutput: 100_000 });
    if (listing.code !== 0 || verbose.code !== 0) throw new Error('The backend archive is invalid.');
    const packageName = backendPackageName(manifest.version);
    validateBackendArchive(listing.output.trimEnd().split('\n'), verbose.output.trimEnd().split('\n'), packageName);
    const extracted = path.join(staging, 'extracted');
    await fs.mkdir(extracted);
    const result = await runner('tar', ['-xJf', archive, '--no-same-owner', '--no-same-permissions', '-C', extracted]);
    if (result.code !== 0) throw new Error('Backend extraction failed.');
    const candidate = path.join(extracted, packageName);
    const verifyFiles = async (root: string) => {
      for (const [name, expected] of Object.entries(manifest.files)) {
        const target = path.join(root, name);
        if (!(await fs.lstat(target)).isFile() || createHash('sha256').update(await fs.readFile(target)).digest('hex') !== expected) {
          throw new Error(`Backend file verification failed: ${name}`);
        }
      }
      for (const name of ['xodus-cli', 'xodus-service']) {
        const header = await fs.readFile(path.join(root, name));
        if (!isLinuxElf64(header, currentArch())) {
          throw new Error(`The backend binary is not a Linux ${BACKEND_ARCH_SUFFIX[currentArch()]} ELF executable.`);
        }
        await fs.chmod(path.join(root, name), 0o755);
        await fs.access(path.join(root, name), constants.X_OK);
      }
      // Never execute xodus-service --help: it starts keychain/device auth.
      await validate(path.join(root, 'xodus-cli'));
    };
    phase('Checking backend commands and runtime libraries…');
    await verifyFiles(candidate);
    await assertIdle();
    const release = path.join(managedRoot, 'releases', `${packageName}-${manifest.archiveSha512.slice(0, 16)}`);
    await fs.mkdir(path.dirname(release), { recursive: true });
    try { await fs.rename(candidate, release); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await verifyFiles(release);
    }
    await fs.writeFile(path.join(release, 'metadata.json'), JSON.stringify(manifest, null, 2));
    return path.join(release, 'xodus-cli');
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
