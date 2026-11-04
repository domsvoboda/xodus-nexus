import { describe, expect, it } from 'vitest';
import { backendLock, backendPackageName } from './backend-package.js';
import { discoverBackend } from './backend-releases.js';
import {
  BACKEND_RELEASE_REPOSITORIES, LEGACY_LAUNCHER_REPOSITORY, RENAMED_LAUNCHER_REPOSITORY,
} from './release-repositories.js';
import { currentArch, type NexusArch } from './arch.js';

const LEGACY = LEGACY_LAUNCHER_REPOSITORY;
const RENAMED = RENAMED_LAUNCHER_REPOSITORY;
const ARCHES: NexusArch[] = ['x64', 'arm64'];
const SUFFIXES = ['.tar.xz', '.manifest.json', '.sha512sum', '-source.tar.xz', '-source.sha512sum'] as const;
const ARCHIVE = 'c'.repeat(128);

function assets(version: string, arch: NexusArch, repository: string, tag = `backend-v${version}`) {
  const name = backendPackageName(version, arch);
  return SUFFIXES.map(suffix => ({
    name: name + suffix,
    browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${name}${suffix}`,
  }));
}
function release(version: string, arch: NexusArch, repository: string) {
  return { tag_name: `backend-v${version}`, assets: assets(version, arch, repository) };
}
function metadata(url: string): Response | undefined {
  if (!url.includes('/releases/download/')) return undefined;
  const file = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
  const match = /^xodus-nexus-backend-(\d+\.\d+\.\d+)-linux-(x86_64|aarch64)/.exec(file);
  if (!match) return undefined;
  const [, version, suffix] = match;
  const arch: NexusArch = suffix === 'x86_64' ? 'x64' : 'arm64';
  if (file.endsWith('.manifest.json')) {
    return new Response(JSON.stringify({
      schema: 1, authUi: 'electron', version, commit: 'a'.repeat(40), recipeSha256: 'b'.repeat(64),
      compatibility: 'linux-run-fixture', platform: 'linux', arch,
      archive: backendPackageName(version, arch) + '.tar.xz', archiveSha512: ARCHIVE,
      files: { 'xodus-cli': 'd'.repeat(64), 'xodus-service': 'e'.repeat(64), LICENSE: 'f'.repeat(64) },
    }));
  }
  if (file.endsWith('.sha512sum') && !file.includes('-source.')) {
    return new Response(`${ARCHIVE}  ${backendPackageName(version, arch)}.tar.xz\n`);
  }
  return new Response('fixture-bytes');
}
function fetcherFor(releases: unknown[]) {
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url === `https://api.github.com/repos/${LEGACY}/releases?per_page=100`) {
      return new Response(JSON.stringify(releases));
    }
    const response = metadata(url);
    if (!response) throw new Error(`Unexpected request ${url}`);
    return response;
  }) as typeof fetch;
  return { fetcher, requests };
}

describe('backend repository rename alias', () => {
  it.each(ARCHES)('keeps the existing backend discovery and old URLs for %s', async arch => {
    const { fetcher, requests } = fetcherFor([release(backendLock.version, arch, LEGACY)]);
    const artifact = await discoverBackend(fetcher, arch);
    expect(artifact.tag).toBe(`backend-v${backendLock.version}`);
    expect(artifact.manifest.version).toBe(backendLock.version);
    expect(artifact.archiveUrl).toBe(
      `https://github.com/${LEGACY}/releases/download/backend-v${backendLock.version}/${backendPackageName(backendLock.version, arch)}.tar.xz`,
    );
    // Still exactly one discovery feed: the released backend algorithm is unchanged.
    expect(requests.filter(url => url.includes('/releases?'))).toEqual([
      `https://api.github.com/repos/${LEGACY}/releases?per_page=100`,
    ]);
    expect(requests.every(url => !url.startsWith('https://api.github.com/repos/domsvoboda/nexus-backend'))).toBe(true);
  });

  it.each(ARCHES)('accepts canonical renamed download URLs for the same released backend on %s', async arch => {
    const { fetcher, requests } = fetcherFor([release(backendLock.version, arch, RENAMED)]);
    const artifact = await discoverBackend(fetcher, arch);
    expect(artifact.tag).toBe(`backend-v${backendLock.version}`);
    expect(artifact.archiveUrl).toBe(
      `https://github.com/${RENAMED}/releases/download/backend-v${backendLock.version}/${backendPackageName(backendLock.version, arch)}.tar.xz`,
    );
    const downloads = requests.filter(url => !url.includes('/releases?'));
    expect(downloads.length).toBeGreaterThan(0);
    expect(downloads.every(url => url.startsWith(`https://github.com/${RENAMED}/`))).toBe(true);
  });

  it.each(ARCHES)('does not let a newer wrong-architecture or incomplete release hide the compatible %s backend', async arch => {
    const other: NexusArch = arch === 'x64' ? 'arm64' : 'x64';
    const incomplete = release('0.2.15', arch, LEGACY);
    incomplete.assets = incomplete.assets.filter(asset => !asset.name.endsWith('-source.sha512sum'));
    const { fetcher } = fetcherFor([release('0.2.16', other, LEGACY), incomplete, release(backendLock.version, arch, RENAMED)]);
    const artifact = await discoverBackend(fetcher, arch);
    expect(artifact.tag).toBe(`backend-v${backendLock.version}`);
    expect(artifact.archiveUrl).toContain(`/${RENAMED}/releases/download/`);
  });

  const mutations: Array<[string, (url: string) => string]> = [
    ['lookalike repository', url => url.replace(`/${RENAMED}/`, `/${RENAMED}-extra/`)],
    ['lookalike owner', url => url.replace('github.com/domsvoboda/', 'github.com/domsvoboda-evil/')],
    ['insecure protocol', url => url.replace('https://', 'http://')],
    ['query string', url => `${url}?download=1`],
    ['mismatched tag', url => url.replace(`backend-v${backendLock.version}`, 'backend-v9.9.9')],
    ['nested path', url => url.replace('/releases/download/', '/releases/download/../download/')],
    ['mismatched asset name', url => `${url}.evil`],
  ];
  it.each(mutations)('rejects %s asset URLs before downloading anything', async (_, mutate) => {
    const item = release(backendLock.version, 'x64', RENAMED);
    item.assets[1].browser_download_url = mutate(item.assets[1].browser_download_url);
    const { fetcher, requests } = fetcherFor([item]);
    await expect(discoverBackend(fetcher, 'x64')).rejects.toThrow('Unexpected backend release asset URL.');
    expect(requests.filter(url => !url.includes('/releases?'))).toEqual([]);
  });

  it('allows only the explicit old and renamed launcher repository aliases', () => {
    expect([...BACKEND_RELEASE_REPOSITORIES]).toEqual([RENAMED, LEGACY]);
  });
});
