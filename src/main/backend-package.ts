import { readFileSync } from 'node:fs';
import { BACKEND_ARCH_SUFFIX, currentArch, type NexusArch } from './arch.js';

export const BACKEND_REPOSITORY = 'domsvoboda/nexus-backend';
export const LEGACY_BACKEND_REPOSITORY = 'domsvoboda/xodus-nexus';
export const BACKEND_REPOSITORIES = [BACKEND_REPOSITORY, LEGACY_BACKEND_REPOSITORY] as const;
export type BackendRepository = typeof BACKEND_REPOSITORIES[number];
export const backendLock = JSON.parse(readFileSync(new URL('../../assets/backend-source.lock.json', import.meta.url), 'utf8')) as {
  schema: 2; version: string; minimumVersion: string; repository: string; commit: string; rust: string;
  cargoLockSha256: string; buildConfigSha256: string; compatibility: string;
};
export const backendRecipeSha256 = backendLock.buildConfigSha256;
// The source pin may be newer than the minimum compatible published package.
export const minimumBackendVersion = backendLock.minimumVersion;
/** Release archives are per architecture; a launcher only ever installs its own. */
export const backendPackageName = (version: string, arch: NexusArch = currentArch()) => `xodus-nexus-backend-${version}-linux-${BACKEND_ARCH_SUFFIX[arch]}`;

export function compareVersions(a: string, b: string): number {
  const [aMajor, aMinor, aPatch] = a.split('.').map(Number);
  const [bMajor, bMinor, bPatch] = b.split('.').map(Number);
  return (aMajor - bMajor) || (aMinor - bMinor) || (aPatch - bPatch);
}

export interface BackendPackageManifest {
  schema: number; sourceRepository?: string; version: string; commit: string; recipeSha256: string;
  compatibility: string; platform: string; arch: string;
  archive: string; archiveSha512: string;
  files: Record<string, string>;
  authUi: 'electron';
}

export function validateBackendManifest(value: unknown, arch: NexusArch = currentArch(), repository?: BackendRepository): BackendPackageManifest {
  const item = value as BackendPackageManifest | undefined;
  if (!item || ![1, 2].includes(item.schema) ||
      (item.schema === 1 && (item.sourceRepository !== undefined || (repository && repository !== LEGACY_BACKEND_REPOSITORY))) ||
      (item.schema === 2 && (item.sourceRepository !== BACKEND_REPOSITORY || (repository && repository !== BACKEND_REPOSITORY))) || item.authUi !== 'electron' || !/^\d+\.\d+\.\d+$/.test(item.version ?? '') ||
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

export function backendAssetUrl(tag: string, name: string, url: unknown, repository: BackendRepository = BACKEND_REPOSITORY): string {
  if (!BACKEND_REPOSITORIES.includes(repository)) throw new Error('Unexpected backend repository.');
  const expected = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${name}`;
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
