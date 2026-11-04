import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { RuntimeManager } from './runtime.js';
import { run } from './process.js';

vi.mock('./process.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./process.js')>();
  return { ...actual, run: (...args: Parameters<typeof actual.run>) => args[0] === 'gh'
    ? Promise.resolve({ code: 1, output: 'No GitHub authentication in this synthetic fixture.' })
    : actual.run(...args) };
});

describe('existing runtime payload activation', () => {
  it.each(['identical', 'changed', 'missing', 'extra', 'root-link'])(
    'handles %s payload without overwriting existing files or saves', async scenario => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'payload-install-'));
      try {
        const runtimeRoot = path.join(root, 'runtime'), build = path.join(root, 'build');
        const name = 'nexus-runtime-11.0-test-g12345678', staged = path.join(build, name);
        const installed = path.join(runtimeRoot, 'releases', name);
        await fs.mkdir(path.join(staged, 'files/bin'), { recursive: true });
        await fs.writeFile(path.join(staged, 'files/bin/wine'), '#!/bin/sh\necho wine-synthetic\n', { mode: 0o755 });
        await fs.writeFile(path.join(staged, 'files/engine.dll'), 'verified engine');
        await fs.cp(staged, installed, { recursive: true });
        const archive = name + '-x86_64.tar.xz', checksum = name + '-x86_64.sha512sum';
        expect((await run('tar', ['-cJf', path.join(build, archive), '-C', build, name])).code).toBe(0);
        await fs.writeFile(path.join(build, checksum), createHash('sha512').update(await fs.readFile(path.join(build, archive))).digest('hex') + '  ' + archive + '\n');
        if (scenario === 'changed') await fs.writeFile(path.join(installed, 'files/engine.dll'), 'different engine');
        if (scenario === 'missing') await fs.unlink(path.join(installed, 'files/engine.dll'));
        if (scenario === 'extra') await fs.writeFile(path.join(installed, 'extra.dll'), 'keep me');
        let existingRoot = installed;
        if (scenario === 'root-link') {
          existingRoot = path.join(root, 'linked-payload');
          await fs.rename(installed, existingRoot); await fs.symlink(existingRoot, installed);
        }
        const existingWine = path.join(existingRoot, 'files/bin/wine');
        const beforeWine = await fs.stat(existingWine);
        const oldWine = path.join(runtimeRoot, 'releases/previous/files/bin/wine');
        await fs.mkdir(path.dirname(oldWine), { recursive: true });
        await fs.writeFile(oldWine, '#!/bin/sh\necho wine-previous\n', { mode: 0o755 });
        const pointer = JSON.stringify({ name: 'previous', winePath: oldWine, commit: 'previous', installedAt: 'before' });
        await fs.writeFile(path.join(runtimeRoot, 'current.json'), pointer);
        const save = path.join(root, 'compatdata/game/pfx/drive_c/users/player/save.dat');
        await fs.mkdir(path.dirname(save), { recursive: true }); await fs.writeFile(save, Buffer.from([1, 2, 255, 0]));
        const beforeSave = await fs.stat(save);
        const fetcher = (async (input: URL | RequestInfo) => {
          const url = String(input);
          if (url.includes('/releases?')) return new Response(JSON.stringify([{ tag_name: 'runtime-test', assets: [archive, checksum].map(asset => ({ name: asset, browser_download_url: 'https://example.com/' + asset })) }]));
          return new Response(await fs.readFile(path.join(build, url.split('/').pop()!)));
        }) as typeof fetch;
        const manager = new RuntimeManager(runtimeRoot, () => undefined, () => false, fetcher, 'x64');
        await manager.refresh();
        if (scenario === 'identical') {
          expect(await manager.installNexus(() => undefined)).toBe(path.join(installed, 'files/bin/wine'));
          expect(JSON.parse(await fs.readFile(path.join(runtimeRoot, 'current.json'), 'utf8')).commit).toBe('runtime-test');
        } else {
          await expect(manager.installNexus(() => undefined)).rejects.toThrow(/does not match|root must be a directory/);
          expect(await fs.readFile(path.join(runtimeRoot, 'current.json'), 'utf8')).toBe(pointer);
          expect(manager.current.name).toBe('previous');
        }
        expect((await fs.stat(existingWine)).ino).toBe(beforeWine.ino);
        expect(await fs.readFile(oldWine, 'utf8')).toContain('wine-previous');
        expect(await fs.readFile(save)).toEqual(Buffer.from([1, 2, 255, 0]));
        expect((await fs.stat(save)).ino).toBe(beforeSave.ino);
        expect((await fs.readdir(runtimeRoot)).some(entry => entry.startsWith('.staging-'))).toBe(false);
        if (scenario === 'changed') expect(await fs.readFile(path.join(installed, 'files/engine.dll'), 'utf8')).toBe('different engine');
        if (scenario === 'extra') expect(await fs.readFile(path.join(installed, 'extra.dll'), 'utf8')).toBe('keep me');
        if (scenario === 'missing') await expect(fs.lstat(path.join(installed, 'files/engine.dll'))).rejects.toMatchObject({ code: 'ENOENT' });
        if (scenario === 'root-link') expect(await fs.readlink(installed)).toBe(existingRoot);
      } finally { await fs.rm(root, { recursive: true, force: true }); }
    },
  );
});
