import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runtimePayloadMatches } from './runtime-payload-identity.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'payload-')); roots.push(root);
  const staged = path.join(root, 'staged'), installed = path.join(root, 'installed');
  for (const directory of [staged, installed]) {
    await fs.mkdir(path.join(directory, 'bin'), { recursive: true, mode: 0o755 });
    await fs.writeFile(path.join(directory, 'bin/wine'), '#!/bin/sh\necho wine-test\n', { mode: 0o755 });
    await fs.writeFile(path.join(directory, 'engine.dll'), Buffer.from([0, 1, 2, 255]), { mode: 0o644 });
    await fs.symlink('bin/wine', path.join(directory, 'wine'));
  }
  return { root, staged, installed };
}

describe('runtimePayloadMatches', () => {
  it('accepts exact bytes and metadata independently of timestamps or directory names', async () => {
    const { staged, installed } = await fixture();
    await fs.utimes(path.join(installed, 'engine.dll'), 1, 1);
    expect(await runtimePayloadMatches(staged, installed)).toBe(true);
  });
  it.each(['changed', 'missing', 'extra', 'executable', 'link', 'directory-mode'])(
    'rejects a working Wine loader with a %s payload', async mutation => {
      const { staged, installed } = await fixture();
      if (mutation === 'changed') await fs.writeFile(path.join(installed, 'engine.dll'), Buffer.from([0, 1, 3, 255]));
      if (mutation === 'missing') await fs.unlink(path.join(installed, 'engine.dll'));
      if (mutation === 'extra') await fs.writeFile(path.join(installed, 'extra.dll'), 'extra');
      if (mutation === 'executable') await fs.chmod(path.join(installed, 'bin/wine'), 0o644);
      if (mutation === 'directory-mode') await fs.chmod(path.join(installed, 'bin'), 0o700);
      if (mutation === 'link') { await fs.unlink(path.join(installed, 'wine')); await fs.symlink('engine.dll', path.join(installed, 'wine')); }
      expect(await runtimePayloadMatches(staged, installed)).toBe(false);
    },
  );
  it('compares broken, cyclic and absolute template links literally without traversing them', async () => {
    const { root, staged, installed } = await fixture();
    const save = path.join(root, 'save'); await fs.writeFile(save, 'existing save');
    for (const directory of [staged, installed]) {
      await fs.symlink('/', path.join(directory, 'z:'));
      await fs.symlink('missing', path.join(directory, 'broken'));
      await fs.symlink('.', path.join(directory, 'cycle'));
      await fs.symlink(save, path.join(directory, 'save-link'));
    }
    expect(await runtimePayloadMatches(staged, installed)).toBe(true);
    expect(await fs.readFile(save, 'utf8')).toBe('existing save');
  });
  it('rejects a symlinked installed root without changing its target', async () => {
    const { root, staged, installed } = await fixture();
    const link = path.join(root, 'alias'); await fs.symlink(installed, link);
    await expect(runtimePayloadMatches(staged, link)).rejects.toThrow('root must be a directory');
    expect(await fs.readFile(path.join(installed, 'engine.dll'))).toEqual(Buffer.from([0, 1, 2, 255]));
  });
  it('rejects replacing a regular file with a link even when its target bytes match', async () => {
    const { staged, installed } = await fixture();
    await fs.unlink(path.join(installed, 'engine.dll'));
    await fs.symlink(path.join(staged, 'engine.dll'), path.join(installed, 'engine.dll'));
    expect(await runtimePayloadMatches(staged, installed)).toBe(false);
  });
  it('propagates missing tree errors rather than accepting or repairing an installation', async () => {
    const { root, staged, installed } = await fixture();
    await expect(runtimePayloadMatches(staged, path.join(root, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await runtimePayloadMatches(staged, installed)).toBe(true);
  });
  it('rejects an ordinary file replacement between inspecting and opening it', async () => {
    const { staged, installed } = await fixture();
    const target = path.join(installed, 'engine.dll'), open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (name, flags, mode) => {
      if (name === target) {
        await fs.rename(target, target + '.previous');
        await fs.writeFile(target, Buffer.from([0, 1, 2, 255]));
      }
      return open(name, flags, mode);
    });
    await expect(runtimePayloadMatches(staged, installed)).rejects.toThrow('changed during verification');
    expect(await fs.readFile(target + '.previous')).toEqual(Buffer.from([0, 1, 2, 255]));
  });
});
