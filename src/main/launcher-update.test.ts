import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LauncherUpdater, launcherCandidate } from './launcher-update.js';
import { LEGACY_LAUNCHER_REPOSITORY, RENAMED_LAUNCHER_REPOSITORY } from './release-repositories.js';
import { APPIMAGE_ARCH_SUFFIX, ELF_MACHINE, currentArch, type NexusArch } from './arch.js';
const LEGACY = LEGACY_LAUNCHER_REPOSITORY;
const RENAMED = RENAMED_LAUNCHER_REPOSITORY;
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
function image(marker: number, arch: NexusArch = currentArch()): Buffer {
  const bytes = Buffer.alloc(100, marker); Buffer.from('7f454c46', 'hex').copy(bytes);
  bytes[4] = 2; bytes[5] = 1; Buffer.from('414902', 'hex').copy(bytes, 8); bytes.writeUInt16LE(ELF_MACHINE[arch], 18); return bytes;
}
function release(version = '0.2.3', arch: NexusArch = currentArch(), repository = LEGACY) {
  const name = `Xodus-Nexus-${version}-${APPIMAGE_ARCH_SUFFIX[arch]}.AppImage`;
  return { tag_name: `v${version}`, assets: [
    { name, size: 100, browser_download_url: `https://github.com/${repository}/releases/download/v${version}/${name}` },
    { name: `${name}.sha512sum`, size: 200, browser_download_url: `https://github.com/${repository}/releases/download/v${version}/${name}.sha512sum` },
  ] };
}
async function fixture(bad = '', arch: NexusArch = currentArch(), repository = LEGACY) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-update-test-')); roots.push(root);
  const target = path.join(root, 'Launcher.AppImage'); await fs.writeFile(target, image(1,arch), { mode: 0o700 });
  const next = bad === 'format' ? Buffer.alloc(100) : image(2,bad==='architecture'?(arch==='x64'?'arm64':'x64'):arch);
  const r = release('0.2.3',arch,repository);
  const fetcher = (async (url: string | URL | Request) => {
    const text = String(url);
    if (text.includes('api.github')) return new Response(JSON.stringify([r]));
    if (text.endsWith('.sha512sum')) return new Response(`${bad === 'checksum' ? '0'.repeat(128) : createHash('sha512').update(next).digest('hex')}  ${r.assets[0].name}\n`);
    if (bad === 'network') throw new Error('Network interrupted');
    return new Response(next);
  }) as typeof fetch;
  const updater = new LauncherUpdater('0.2.2', target, root, () => {}, fetcher, arch);
  await updater.initialize(); await updater.check(); return { root, target, updater, fetcher };
}
type Feed = { releases?: unknown[]; status?: number; error?: string };
function feedFetcher(feeds: Record<string, Feed>) {
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input); requests.push(url);
    for (const [repository, feed] of Object.entries(feeds)) {
      if (url === `https://api.github.com/repos/${repository}/releases?per_page=100`) {
        if (feed.error) throw new Error(feed.error);
        if (feed.status) return new Response('', { status: feed.status });
        return new Response(JSON.stringify(feed.releases));
      }
    }
    if (url.startsWith('https://api.github.com/repos/')) return new Response('', { status: 404 });
    throw new Error(`Unexpected request ${url}`);
  }) as typeof fetch;
  return { fetcher, requests };
}
async function check(feeds: Record<string, Feed>, current = '0.4.2', arch: NexusArch = currentArch()) {
  const { fetcher, requests } = feedFetcher(feeds);
  const updater = new LauncherUpdater(current, undefined, '/unused', () => {}, fetcher, arch);
  await updater.check();
  return { updater, requests };
}
describe('AppImage updater', () => {
  it('ignores backend/runtime tags and prereleases; uses newest complete stable launcher', () => {
    expect(launcherCandidate([{ ...release('9.0.0'), tag_name: 'backend-v9.0.0' }, { ...release('8.0.0'), prerelease: true }, release('0.2.3'), release('0.2.4')], '0.2.2')?.version).toBe('0.2.4');
    expect(launcherCandidate([release()], '0.2.3')).toBeUndefined();
    const unsafe = release(); unsafe.assets[0].browser_download_url = 'https://evil.example/update';
    expect(launcherCandidate([unsafe], '0.2.2')).toBeUndefined();
  });
  it.each(['x64','arm64'] as const)('atomically installs exact %s bytes and restores the previous launcher without touching settings', async arch => {
    const { root, target, updater, fetcher } = await fixture('',arch);
    await fs.writeFile(path.join(root, 'settings.json'), 'KEEP');
    await updater.install(); expect(await fs.readFile(target)).toEqual(image(2,arch));
    expect(updater.state.restartRequired).toBe(true); expect(updater.state.canRollback).toBe(true);
    const restarted = new LauncherUpdater('0.2.3', target, root, () => {}, fetcher, arch); await restarted.initialize();
    expect(restarted.state.canRollback).toBe(true); await restarted.rollback();
    expect(await fs.readFile(target)).toEqual(image(1,arch)); expect(await fs.readFile(path.join(root, 'settings.json'), 'utf8')).toBe('KEEP');
  });
  it.each(['checksum', 'network', 'format', 'architecture'])('preserves the installed image on %s failure and removes staging/lock', async bad => {
    const { root, target, updater } = await fixture(bad);
    await expect(updater.install()).rejects.toThrow(); expect(await fs.readFile(target)).toEqual(image(1));
    expect((await fs.readdir(root)).some(name => name.includes('nexus-update') || name.includes('nexus-backup'))).toBe(false);
    expect(updater.state.updating).toBe(false);
  });
  it('selects each native AppImage without a newer release hiding the last matching build',()=>{
    const releases=[release('9.9.9','x64'),release('9.8.0','arm64')];
    expect(launcherCandidate(releases,'0.4.0','arm64')?.version).toBe('9.8.0');
    expect(launcherCandidate(releases,'0.4.0','x64')?.version).toBe('9.9.9');
    expect(launcherCandidate([release('9.9.9','x64')],'0.4.0','arm64')).toBeUndefined();
  });
  it('rejects shared-writable images and keeps manual release download available for development builds', async () => {
    const { root, target, fetcher } = await fixture(); await fs.chmod(target, 0o777);
    const updater = new LauncherUpdater('0.2.2', target, root, () => {}, fetcher); await updater.initialize(); await updater.check();
    expect(updater.state.canInstall).toBe(false); expect(updater.state.releaseUrl).toContain('/releases/tag/v0.2.3');
    await expect(updater.install()).rejects.toThrow('owned');
    const dev = new LauncherUpdater('0.2.2', undefined, root, () => {}, fetcher); await dev.initialize(); expect(dev.state.canInstall).toBe(false);
  });
});

describe('launcher repository rename bridge', () => {
  it.each(['x64', 'arm64'] as const)('finds the next major in the renamed repository before the physical rename for %s', async arch => {
    const { updater, requests } = await check({
      [RENAMED]: { releases: [release('0.5.0', arch, RENAMED)] },
      [LEGACY]: { releases: [release('0.4.3', arch, LEGACY)] },
    }, '0.4.2', arch);
    expect(updater.state.error).toBeUndefined();
    expect(updater.state.latestVersion).toBe('0.5.0');
    expect(updater.state.releaseUrl).toBe(`https://github.com/${RENAMED}/releases/tag/v0.5.0`);
    expect(requests.filter(url => url.includes('/releases?'))).toHaveLength(2);
  });

  it.each(['x64', 'arm64'] as const)('accepts canonical renamed URLs returned by the old API after the rename for %s', async arch => {
    const { updater } = await check({
      [RENAMED]: { status: 404 },
      [LEGACY]: { releases: [release('0.5.0', arch, RENAMED)] },
    }, '0.4.2', arch);
    expect(updater.state.error).toBeUndefined();
    expect(updater.state.latestVersion).toBe('0.5.0');
    expect(updater.state.releaseUrl).toBe(`https://github.com/${RENAMED}/releases/tag/v0.5.0`);
  });

  it('keeps the bridge release and old URLs before the renamed repository exists', async () => {
    const { updater } = await check({
      [RENAMED]: { status: 404 },
      [LEGACY]: { releases: [release('0.4.3', 'x64', LEGACY)] },
    }, '0.4.2', 'x64');
    expect(updater.state.error).toBeUndefined();
    expect(updater.state.latestVersion).toBe('0.4.3');
    expect(updater.state.releaseUrl).toBe(`https://github.com/${LEGACY}/releases/tag/v0.4.3`);
  });

  it('uses the renamed feed when the old feed is temporarily unavailable', async () => {
    const { updater } = await check({
      [RENAMED]: { releases: [release('0.5.0', 'x64', RENAMED)] },
      [LEGACY]: { status: 500 },
    }, '0.4.2', 'x64');
    expect(updater.state.error).toBeUndefined();
    expect(updater.state.latestVersion).toBe('0.5.0');
  });

  it('reports an error only when both allowed feeds fail', async () => {
    const { updater } = await check({
      [RENAMED]: { status: 404 },
      [LEGACY]: { error: 'network interrupted' },
    }, '0.4.2', 'x64');
    expect(updater.state.latestVersion).toBeUndefined();
    expect(updater.state.error).toContain('HTTP 404');
    expect(updater.state.error).toContain('network interrupted');
  });

  it('skips incomplete or wrong-architecture releases without hiding the next usable version', async () => {
    const incomplete = release('0.5.5', 'x64', RENAMED); incomplete.assets.pop();
    const { updater } = await check({
      [RENAMED]: { releases: [release('0.6.0', 'arm64', RENAMED), incomplete, release('0.5.0', 'x64', RENAMED)] },
      [LEGACY]: { releases: [release('0.4.3', 'x64', LEGACY)] },
    }, '0.4.2', 'x64');
    expect(updater.state.latestVersion).toBe('0.5.0');
  });

  it.each([LEGACY, RENAMED])('accepts exact %s URLs for the legacy AppImage asset names', repository => {
    const candidate = launcherCandidate([release('0.5.0', 'x64', repository)], '0.4.2', 'x64');
    expect(candidate?.version).toBe('0.5.0');
    expect(candidate?.releaseUrl).toBe(`https://github.com/${repository}/releases/tag/v0.5.0`);
  });

  it.each(['x64', 'arm64'] as const)('requires the actual legacy artifact name for a 0.5.0 release from the renamed repository on %s', async arch => {
    const image = `Xodus-Nexus-0.5.0-${APPIMAGE_ARCH_SUFFIX[arch]}.AppImage`;
    const candidate = launcherCandidate([release('0.5.0', arch, RENAMED)], '0.4.2', arch);
    expect(candidate?.image.name).toBe(image);
    expect(candidate?.checksum.name).toBe(`${image}.sha512sum`);
    expect(candidate?.image.browser_download_url).toBe(`https://github.com/${RENAMED}/releases/download/v0.5.0/${image}`);
    expect(candidate?.checksum.browser_download_url).toBe(`https://github.com/${RENAMED}/releases/download/v0.5.0/${image}.sha512sum`);
  });

  it('does not guess a renamed product artifact name', () => {
    const item = release('0.5.0', 'x64', RENAMED);
    const guessed = `Nexus-Launcher-0.5.0-${APPIMAGE_ARCH_SUFFIX.x64}.AppImage`;
    item.assets[0].name = guessed;
    item.assets[0].browser_download_url = `https://github.com/${RENAMED}/releases/download/v0.5.0/${guessed}`;
    item.assets[1].name = `${guessed}.sha512sum`;
    item.assets[1].browser_download_url = `https://github.com/${RENAMED}/releases/download/v0.5.0/${guessed}.sha512sum`;
    expect(launcherCandidate([item], '0.4.2', 'x64')).toBeUndefined();
  });

  it.each(['x64', 'arm64'] as const)('installs checksum-verified bytes from canonical renamed URLs for %s', async arch => {
    const { target, updater } = await fixture('', arch, RENAMED);
    expect(updater.state.latestVersion).toBe('0.2.3');
    await updater.install();
    expect(await fs.readFile(target)).toEqual(image(2, arch));
    expect(updater.state.restartRequired).toBe(true);
  });

  const mutations: Array<[string, (candidate: ReturnType<typeof release>) => void]> = [
    ['lookalike repository', r => { r.assets[0].browser_download_url = r.assets[0].browser_download_url.replace(`/${RENAMED}/`, `/${RENAMED}-extra/`); }],
    ['lookalike owner', r => { r.assets[0].browser_download_url = r.assets[0].browser_download_url.replace('github.com/domsvoboda/', 'github.com/domsvoboda-evil/'); }],
    ['insecure protocol', r => { r.assets[0].browser_download_url = r.assets[0].browser_download_url.replace('https://', 'http://'); }],
    ['query string', r => { r.assets[0].browser_download_url = `${r.assets[0].browser_download_url}?download=1`; }],
    ['mismatched tag', r => { r.assets[0].browser_download_url = r.assets[0].browser_download_url.replace('/v9.9.9/', '/v9.9.8/'); }],
    ['nested path', r => { r.assets[0].browser_download_url = r.assets[0].browser_download_url.replace('/releases/download/', '/releases/download/../download/'); }],
    ['mismatched asset name', r => { r.assets[0].browser_download_url = `${r.assets[0].browser_download_url}.evil`; }],
    ['mixed trusted repositories', r => { r.assets[1].browser_download_url = r.assets[1].browser_download_url.replace(`/${RENAMED}/`, `/${LEGACY}/`); }],
  ];
  it.each(mutations)('rejects %s URLs', (_, mutate) => {
    const item = release('9.9.9', 'x64', RENAMED); mutate(item);
    expect(launcherCandidate([item], '0.4.2', 'x64')).toBeUndefined();
  });
});
