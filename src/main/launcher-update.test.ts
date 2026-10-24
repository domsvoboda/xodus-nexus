import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LauncherUpdater, launcherCandidate } from './launcher-update.js';
import { APPIMAGE_ARCH_SUFFIX, ELF_MACHINE, currentArch } from './arch.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
function image(marker: number): Buffer {
  const bytes = Buffer.alloc(100, marker); Buffer.from('7f454c46', 'hex').copy(bytes);
  bytes[4] = 2; bytes[5] = 1; Buffer.from('414902', 'hex').copy(bytes, 8); bytes.writeUInt16LE(ELF_MACHINE[currentArch()], 18); return bytes;
}
function release(version = '0.2.3') {
  const name = `Xodus-Nexus-${version}-${APPIMAGE_ARCH_SUFFIX[currentArch()]}.AppImage`;
  return { tag_name: `v${version}`, assets: [
    { name, size: 100, browser_download_url: `https://github.com/domsvoboda/xodus-nexus/releases/download/v${version}/${name}` },
    { name: `${name}.sha512sum`, size: 200, browser_download_url: `https://github.com/domsvoboda/xodus-nexus/releases/download/v${version}/${name}.sha512sum` },
  ] };
}
async function fixture(bad = '') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-update-test-')); roots.push(root);
  const target = path.join(root, 'Launcher.AppImage'); await fs.writeFile(target, image(1), { mode: 0o700 });
  const next = bad === 'format' ? Buffer.alloc(100) : image(2);
  const r = release();
  const fetcher = (async (url: string | URL | Request) => {
    const text = String(url);
    if (text.includes('api.github')) return new Response(JSON.stringify([r]));
    if (text.endsWith('.sha512sum')) return new Response(`${bad === 'checksum' ? '0'.repeat(128) : createHash('sha512').update(next).digest('hex')}  ${r.assets[0].name}\n`);
    if (bad === 'network') throw new Error('Network interrupted');
    return new Response(next);
  }) as typeof fetch;
  const updater = new LauncherUpdater('0.2.2', target, root, () => {}, fetcher);
  await updater.initialize(); await updater.check(); return { root, target, updater, fetcher };
}
describe('AppImage updater', () => {
  it('ignores backend/runtime tags and prereleases; uses newest complete stable launcher', () => {
    expect(launcherCandidate([{ ...release('9.0.0'), tag_name: 'backend-v9.0.0' }, { ...release('8.0.0'), prerelease: true }, release('0.2.3'), release('0.2.4')], '0.2.2')?.version).toBe('0.2.4');
    expect(launcherCandidate([release()], '0.2.3')).toBeUndefined();
    const unsafe = release(); unsafe.assets[0].browser_download_url = 'https://evil.example/update';
    expect(launcherCandidate([unsafe], '0.2.2')).toBeUndefined();
  });
  it('atomically installs exact verified bytes and restores the previous launcher without touching settings', async () => {
    const { root, target, updater, fetcher } = await fixture();
    await fs.writeFile(path.join(root, 'settings.json'), 'KEEP');
    await updater.install(); expect(await fs.readFile(target)).toEqual(image(2));
    expect(updater.state.restartRequired).toBe(true); expect(updater.state.canRollback).toBe(true);
    const restarted = new LauncherUpdater('0.2.3', target, root, () => {}, fetcher); await restarted.initialize();
    expect(restarted.state.canRollback).toBe(true); await restarted.rollback();
    expect(await fs.readFile(target)).toEqual(image(1)); expect(await fs.readFile(path.join(root, 'settings.json'), 'utf8')).toBe('KEEP');
  });
  it.each(['checksum', 'network', 'format'])('preserves the installed image on %s failure and removes staging/lock', async bad => {
    const { root, target, updater } = await fixture(bad);
    await expect(updater.install()).rejects.toThrow(); expect(await fs.readFile(target)).toEqual(image(1));
    expect((await fs.readdir(root)).some(name => name.includes('nexus-update') || name.includes('nexus-backup'))).toBe(false);
    expect(updater.state.updating).toBe(false);
  });
  it('rejects shared-writable images and keeps manual release download available for development builds', async () => {
    const { root, target, fetcher } = await fixture(); await fs.chmod(target, 0o777);
    const updater = new LauncherUpdater('0.2.2', target, root, () => {}, fetcher); await updater.initialize(); await updater.check();
    expect(updater.state.canInstall).toBe(false); expect(updater.state.releaseUrl).toContain('/releases/tag/v0.2.3');
    await expect(updater.install()).rejects.toThrow('owned');
    const dev = new LauncherUpdater('0.2.2', undefined, root, () => {}, fetcher); await dev.initialize(); expect(dev.state.canInstall).toBe(false);
  });
});
