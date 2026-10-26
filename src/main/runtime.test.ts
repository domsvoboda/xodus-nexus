import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalSnapshotName, nexusReleaseName, previewBaseRelease, RuntimeManager } from './runtime.js';
import { run } from './process.js';

describe('previewBaseRelease', () => {
  it('derives release names from versions, commits and asset names', () => {
    expect(nexusReleaseName('xodus-nexus-runtime-11.0-20261011-g3fd4ae10-x86_64.tar.xz')).toBe('xodus-nexus-runtime-11.0-20261011-g3fd4ae10');
    expect(canonicalSnapshotName('3fd4ae1091339ef07d6f2d53fda8e15541f96ad3')).toBe('xodus-proton-3fd4ae10');
  });

  it('finds the published Nexus runtime release and its assets', async () => {
    // Launcher AppImage releases share the repository; a newer release without
    // runtime assets must not hide the runtime release.
    const fetcher = (async (input: URL | RequestInfo) => new Response(JSON.stringify([
      {
        tag_name: 'v0.5.25',
        assets: [{ name: 'Xodus-Nexus-0.5.25-x86_64.AppImage', browser_download_url: 'https://example.com/app.AppImage' }],
      },
      {
        tag_name: 'runtime-11.0-20261011-g3fd4ae10',
        assets: [
          { name: 'xodus-nexus-runtime-11.0-20261011-g3fd4ae10-x86_64.tar.xz', browser_download_url: 'https://example.com/xodus-nexus-runtime-11.0-20261011-g3fd4ae10-x86_64.tar.xz' },
          { name: 'xodus-nexus-runtime-11.0-20261011-g3fd4ae10-x86_64.sha512sum', browser_download_url: 'https://example.com/xodus-nexus-runtime-11.0-20261011-g3fd4ae10-x86_64.sha512sum' },
        ],
      },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    const manager = new RuntimeManager('/tmp/unused', () => undefined, () => false, fetcher);
    const status = await manager.checkNexus();
    expect(status.nexusAvailable).toBe(true);
    expect(status.nexusVersion).toBe('runtime-11.0-20261011-g3fd4ae10');
    expect(status.nexusName).toBe('xodus-nexus-runtime-11.0-20261011-g3fd4ae10-x86_64.tar.xz');
  });

  it.each([false, true])('selects the newest publication regardless of list or commit-hash order: reversed=%s', async reversed => {
    const runtime = (suffix: string, published_at: string) => {
      const name = `xodus-nexus-runtime-11.0-20261014-${suffix}-x86_64.tar.xz`;
      return {
        tag_name: `runtime-11.0-20261014-${suffix}`, published_at,
        assets: [name, name.replace('.tar.xz', '.sha512sum')].map(name => ({
          name, browser_download_url: `https://example.com/${name}`,
        })),
      };
    };
    const older = runtime('g9e1653e1', '2026-10-14T12:18:00Z');
    const newer = runtime('g606bbea0', '2026-10-14T22:13:42Z');
    const releases = [
      { tag_name: 'v0.2.3', published_at: '2026-10-15T00:00:00Z', assets: [] },
      ...(reversed ? [newer, older] : [older, newer]),
      { ...runtime('draft', '2026-10-16T00:00:00Z'), draft: true },
      { ...runtime('preview', '2026-10-16T00:00:00Z'), prerelease: true },
      { ...runtime('incomplete', '2026-10-16T00:00:00Z'), assets: older.assets.slice(0, 1) },
      runtime('undated', 'invalid'),
    ];
    const fetcher = (async () => new Response(JSON.stringify(releases))) as typeof fetch;
    const manager = new RuntimeManager('/tmp/unused', () => undefined, () => false, fetcher);
    const status = await manager.checkNexus();
    expect(status.nexusVersion).toBe(newer.tag_name);
    expect(status.nexusName).toBe(newer.assets[0].name);
  });

  it('reports no Nexus runtime when no release carries one', async () => {
    const fetcher = (async () => new Response(JSON.stringify([
      {
        tag_name: 'v0.5.24',
        assets: [{ name: 'Xodus-Nexus-0.5.24-x86_64.AppImage', browser_download_url: 'https://example.com/app.AppImage' }],
      },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    const manager = new RuntimeManager('/tmp/unused', () => undefined, () => false, fetcher);
    const status = await manager.checkNexus();
    expect(status.nexusAvailable).toBe(false);
    expect(status.nexusError).toContain('No Nexus runtime release has been published yet');
  });

  it('ignores previews, unrelated archives and mismatched checksum pairs', async () => {
    const name = 'xodus-nexus-runtime-11.0-tested-x86_64.tar.xz';
    const asset = (file: string) => ({ name: file, browser_download_url: `https://example.com/${file}` });
    const pair = [asset(name), asset(name.replace('.tar.xz', '.sha512sum'))];
    const fetcher = (async () => new Response(JSON.stringify([
      { tag_name: 'draft', draft: true, assets: pair },
      { tag_name: 'preview', prerelease: true, assets: pair },
      { tag_name: 'unrelated', assets: [asset('other-x86_64.tar.xz'), asset('other-x86_64.sha512sum')] },
      { tag_name: 'mismatched', assets: [asset(name), asset('xodus-nexus-runtime-different-x86_64.sha512sum')] },
      { tag_name: 'runtime-tested', assets: pair },
    ]))) as typeof fetch;
    const manager = new RuntimeManager('/tmp/unused', () => undefined, () => false, fetcher);
    expect((await manager.checkNexus()).nexusVersion).toBe('runtime-tested');
  });

  it('does not download or replace a runtime during an active operation', async () => {
    const fetcher = (async () => { throw new Error('No download may start'); }) as typeof fetch;
    const manager = new RuntimeManager('/tmp/unused', () => undefined, () => true, fetcher);
    await expect(manager.installNexus(() => undefined)).rejects.toThrow('while a Xodus operation is active');
  });

  it.each(['empty', '404', 'preview', 'incomplete'])('keeps published legacy releases available while the fork is %s', async scenario => {
    const old = 'xodus-nexus-runtime-tested-x86_64.tar.xz';
    const next = 'nexus-runtime-tested-x86_64.tar.xz';
    const pair = (name: string) => [name, name.replace('.tar.xz', '.sha512sum')].map(name => ({ name, browser_download_url: `https://example.com/${name}` }));
    const calls: string[] = [];
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = String(input); calls.push(url);
      if (url.includes('/nexus-runtime/')) {
        if (scenario === '404') return new Response('', { status: 404 });
        return new Response(JSON.stringify(scenario === 'empty' ? [] : [{ tag_name: 'next', prerelease: scenario === 'preview', assets: scenario === 'incomplete' ? pair(next).slice(0, 1) : pair(next) }]));
      }
      return new Response(JSON.stringify([{ tag_name: 'previous', assets: pair(old) }]));
    }) as typeof fetch;
    const status = await new RuntimeManager('/tmp/unused', () => undefined, () => false, fetcher).checkNexus();
    expect(status.nexusName).toBe(old);
    expect(calls).toHaveLength(2);
  });

  it('prefers the complete published fork release without changing an installed runtime', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-discovery-'));
    try {
      const previous = { name: 'previous', winePath: '/previous/wine', commit: 'previous', installedAt: 'before' };
      await fs.writeFile(path.join(root, 'current.json'), JSON.stringify(previous));
      const name = 'nexus-runtime-11.0-experimental-g12345678-x86_64.tar.xz';
      let calls = 0;
      const fetcher = (async (input: URL | RequestInfo) => {
        expect(String(input)).toContain('/domsvoboda/nexus-runtime/releases?'); calls++;
        return new Response(JSON.stringify([{ tag_name: 'next', assets: [name, name.replace('.tar.xz', '.sha512sum')].map(name => ({ name, browser_download_url: `https://example.com/${name}` })) }]));
      }) as typeof fetch;
      const status = await new RuntimeManager(root, () => undefined, () => false, fetcher).checkNexus();
      expect(status.nexusName).toBe(name); expect(calls).toBe(1);
      expect(JSON.parse(await fs.readFile(path.join(root, 'current.json'), 'utf8'))).toEqual(previous);
      expect(await fs.readdir(root)).toEqual(['current.json']);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each([403, 500])('does not silently downgrade after a fork repository error: %s', async status => {
    let calls = 0;
    const fetcher = (async () => { calls++; return new Response('', { status }); }) as typeof fetch;
    const result = await new RuntimeManager('/tmp/unused', () => undefined, () => false, fetcher).checkNexus();
    expect(result.nexusAvailable).toBe(false); expect(result.nexusError).toContain('could not be read'); expect(calls).toBe(1);
  });

  it.each(['valid', 'new-fork', 'stderr-warning', 'bad-digest', 'wrong-file', 'unsafe-root', 'mixed-root'])('verifies a downloaded Nexus runtime before activation: %s', async scenario => {
    // Build a real tar.xz runtime archive with a fake wine binary, publish it
    // through the mocked release API, and run the full install path:
    // download, SHA-512 verification, extraction, canonical naming, pointer.
    const releaseName = scenario === 'new-fork' ? 'nexus-runtime-11.0-experimental-g3fd4ae10' : 'xodus-nexus-runtime-11.0-20261011-g3fd4ae10';
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xodus-nexus-install-test-'));
    const build = path.join(root, 'build');
    const top = scenario === 'new-fork' ? releaseName : scenario === 'unsafe-root' ? 'unexpected-root' : 'proton-xodus-bleeding-edge-11.0-20260803-3-g7c0b4354-x86_64';
    const wine = path.join(build, top, 'files', 'bin', 'wine');
    await fs.mkdir(path.dirname(wine), { recursive: true });
    await fs.writeFile(wine, '#!/bin/sh\necho wine-11.0-test\n', { mode: 0o755 });
    if (scenario === 'mixed-root') await fs.mkdir(path.join(build, 'second-root'));
    const packed = await run('tar', ['-cJf', path.join(build, `${releaseName}-x86_64.tar.xz`), '-C', build, top, ...(scenario === 'mixed-root' ? ['second-root'] : [])]);
    if (packed.code !== 0) throw new Error('The tar fixture could not be created.');
    const digest = createHash('sha512').update(await fs.readFile(path.join(build, `${releaseName}-x86_64.tar.xz`))).digest('hex');
    await fs.writeFile(path.join(build, `${releaseName}-x86_64.sha512sum`), `${scenario === 'bad-digest' ? '0'.repeat(128) : digest}  ${scenario === 'wrong-file' ? 'other.tar.xz' : `${releaseName}-x86_64.tar.xz`}\n`);
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes('/releases?')) {
        return new Response(JSON.stringify([{ tag_name: 'runtime-11.0-20261011-g3fd4ae10', assets: [
          { name: `${releaseName}-x86_64.tar.xz`, browser_download_url: `https://example.com/${releaseName}-x86_64.tar.xz` },
          { name: `${releaseName}-x86_64.sha512sum`, browser_download_url: `https://example.com/${releaseName}-x86_64.sha512sum` },
        ] }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const file = path.join(build, url.split('/').pop()!);
      return new Response(await fs.readFile(file), { status: 200 });
    }) as typeof fetch;
    const manager = new RuntimeManager(root, () => undefined, () => false, fetcher);
    const originalPreload = process.env.LD_PRELOAD;
    if (scenario === 'stderr-warning') process.env.LD_PRELOAD = path.join(root, 'nonexistent-test-overlay.so');
    try {
      const previousWine = path.join(root, 'releases', 'previous', 'files', 'bin', 'wine');
      await fs.mkdir(path.dirname(previousWine), { recursive: true });
      await fs.writeFile(previousWine, '#!/bin/sh\necho wine-previous\n', { mode: 0o755 });
      const previous = { name: 'previous', winePath: previousWine, commit: 'previous', installedAt: 'before' };
      await fs.writeFile(path.join(root, 'current.json'), JSON.stringify(previous));
      await manager.refresh(); // detect tar and sha512sum prerequisites
      if (!['valid', 'new-fork', 'stderr-warning'].includes(scenario)) {
        await expect(manager.installNexus(() => undefined)).rejects.toThrow(['unsafe-root', 'mixed-root'].includes(scenario) ? /runtime structure/ : /SHA-512/);
        expect(JSON.parse(await fs.readFile(path.join(root, 'current.json'), 'utf8'))).toEqual(previous);
        expect(manager.current.name).toBe('previous');
        expect(manager.current.updating).toBe(false);
        expect((await fs.readdir(root)).some(name => name.startsWith('.staging-'))).toBe(false);
        return;
      }
      const winePath = await manager.installNexus(() => undefined);
      expect(winePath).toBe(path.join(root, 'releases', releaseName, 'files', 'bin', 'wine'));
      const pointer = JSON.parse(await fs.readFile(path.join(root, 'current.json'), 'utf8')) as { name: string; commit: string };
      expect(pointer.name).toBe(releaseName);
      expect(pointer.commit).toBe('runtime-11.0-20261011-g3fd4ae10');
      expect(manager.current.name).toBe(releaseName);
      expect(manager.current.installed).toBe(true);
      expect(await fs.readFile(previousWine, 'utf8')).toContain('wine-previous');
    } finally {
      if (originalPreload === undefined) delete process.env.LD_PRELOAD;
      else process.env.LD_PRELOAD = originalPreload;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('extracts the preserved base release', () => {
    expect(previewBaseRelease('proton-xodus-test-offline-v2-xgamesave-pr28-3fd4ae1091')).toBe('proton-xodus-test-offline-v2');
    expect(previewBaseRelease('proton-xodus-test-offline-v2-xgamesave-pr28-3fd4ae1091-bridge-v1')).toBe('proton-xodus-test-offline-v2');
    expect(previewBaseRelease('proton-xodus-test-offline-v2-xgamesave-pr28-3fd4ae1091-bridge-v1-userstate-v1')).toBe('proton-xodus-test-offline-v2');
    expect(previewBaseRelease('proton-xodus-test-offline-v2-xgamesave-pr28-3fd4ae1091-bridge-v1-userstate-v1-userguest-v1')).toBe('proton-xodus-test-offline-v2');
    expect(previewBaseRelease('proton-xodus-test-offline-v2-xgamesave-pr28-3fd4ae1091-bridge-v1-userstate-v1-userguest-v1-locale-v1')).toBe('proton-xodus-test-offline-v2');
    expect(previewBaseRelease('proton-xodus-test-offline-v2-xgamesave-pr28-3fd4ae1091-locale-v1')).toBe('proton-xodus-test-offline-v2');
  });

  it('rejects unrelated and malformed release names', () => {
    expect(previewBaseRelease('proton-xodus-test-offline-v2')).toBeNull();
    expect(previewBaseRelease('../escape-xgamesave-pr28-3fd4ae1091')).toBeNull();
  });

  it('atomically switches a preview back to its validated base release', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xodus-runtime-test-'));
    const base = 'proton-xodus-test-offline-v2';
    const winePath = path.join(root, 'releases', base, 'files', 'bin', 'wine');
    try {
      await fs.mkdir(path.dirname(winePath), { recursive: true });
      await fs.writeFile(winePath, '#!/bin/sh\necho wine-test\n', { mode: 0o755 });
      await fs.writeFile(path.join(root, 'current.json'), JSON.stringify({
        name: `${base}-xgamesave-pr28-3fd4ae1091`, winePath: '/preview/wine', commit: 'abc', installedAt: 'before',
      }));
      const manager = new RuntimeManager(root, () => undefined, () => false);
      expect(await manager.rollbackCloudSavePreview(() => undefined)).toBe(winePath);
      const pointer = JSON.parse(await fs.readFile(path.join(root, 'current.json'), 'utf8')) as { name: string; winePath: string };
      expect(pointer.name).toBe(base);
      expect(pointer.winePath).toBe(winePath);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
