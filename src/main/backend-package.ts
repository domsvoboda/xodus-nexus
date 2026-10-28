import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BACKEND_ARCH_SUFFIX, currentArch, type NexusArch } from './arch.js';

export const BACKEND_REPOSITORY = 'domsvoboda/xodus-nexus';
export const backendAssets = fileURLToPath(new URL('../../assets/', import.meta.url));
const lockBytes = readFileSync(new URL('../../assets/backend-source.lock.json', import.meta.url));
export const backendLock = JSON.parse(lockBytes.toString()) as {
  schema: number; version: string; repository: string; commit: string; rust: string;
  cargoLockSha256: string; patchId: string; compatibility: string;
  patches: Array<{ file: string; sha256: string }>;
};
export const backendRecipeSha256 = createHash('sha256').update(lockBytes).digest('hex');
// The launcher accepts any stable backend release at or above the version it was
// built with, so backend updates no longer require a new launcher release.
export const minimumBackendVersion = backendLock.version;
/** Release archives are per architecture; a launcher only ever installs its own. */
export const backendPackageName = (version: string, arch: NexusArch = currentArch()) => `xodus-nexus-backend-${version}-linux-${BACKEND_ARCH_SUFFIX[arch]}`;

export function compareVersions(a: string, b: string): number {
  const [aMajor, aMinor, aPatch] = a.split('.').map(Number);
  const [bMajor, bMinor, bPatch] = b.split('.').map(Number);
  return (aMajor - bMajor) || (aMinor - bMinor) || (aPatch - bPatch);
}

export interface BackendPackageManifest {
  schema: number; version: string; commit: string; recipeSha256: string;
  compatibility: string; platform: string; arch: string;
  archive: string; archiveSha512: string;
  files: Record<string, string>;
  authUi: 'electron';
}

export function validateBackendManifest(value: unknown, arch: NexusArch = currentArch()): BackendPackageManifest {
  const item = value as BackendPackageManifest | undefined;
  if (!item || item.schema !== 1 || item.authUi !== 'electron' || !/^\d+\.\d+\.\d+$/.test(item.version ?? '') ||
      compareVersions(item.version, minimumBackendVersion) < 0 ||
      !/^[a-f0-9]{40}$/.test(item.commit ?? '') || !/^[a-f0-9]{64}$/.test(item.recipeSha256 ?? '') ||
      typeof item.compatibility !== 'string' || !item.compatibility.trim() ||
      item.platform !== 'linux' || item.arch !== arch ||
      item.archive !== `${backendPackageName(item.version, arch)}.tar.xz` || !/^[a-f0-9]{128}$/.test(item.archiveSha512 ?? '') ||
      !item.files || Object.keys(item.files).sort().join(',') !== 'LICENSE,xodus-cli,xodus-service' ||
      Object.values(item.files).some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error('The backend package manifest is not a valid compatible release.');
  }
  return item;
}

export function backendAssetUrl(tag: string, name: string, url: unknown): string {
  const expected = `https://github.com/${BACKEND_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${name}`;
  if (url !== expected) throw new Error('Unexpected backend release asset URL.');
  return expected;
}

export function validateBackendArchive(entries: string[], verbose: string[], packageName = backendPackageName(backendLock.version)): void {
  const expected = new Set([`${packageName}/`, ...['xodus-cli', 'xodus-service', 'LICENSE'].map(name => `${packageName}/${name}`)]);
  if (entries.length !== expected.size || entries.some(name => !expected.delete(name)) ||
      verbose.length !== entries.length || verbose.some(line => {
        const size = line.match(/^[-d]\S*\s+\S+\s+(\d+)\s/);
        return !size || Number(size[1]) > 256 * 1024 * 1024;
      })) {
    throw new Error('Unsafe backend archive: only the package directory and regular binaries/license are allowed.');
  }
}
