import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARM64_LAYOUT, X86_64_LAYOUT, layoutOfWine, protonRootOf, runtimeArchiveArch, runtimeLoader } from './proton-layout.js';

const created: string[] = [];
afterEach(async () => { await Promise.all(created.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('proton layout', () => {
  it('derives the layout and root from the active loader path', () => {
    expect(layoutOfWine('/runtimes/r/files/bin/wine')).toEqual(X86_64_LAYOUT);
    expect(layoutOfWine('/runtimes/r/files/bin-arm64/wine')).toEqual(ARM64_LAYOUT);
    expect(protonRootOf('/runtimes/r/files/bin-arm64/wine')).toBe(path.resolve('/runtimes/r'));
  });

  it('maps hosts to runtime archive suffixes and rejects other hosts', () => {
    expect(runtimeArchiveArch('x64')).toBe('x86_64');
    expect(runtimeArchiveArch('arm64')).toBe('aarch64');
    expect(() => runtimeArchiveArch('ia32')).toThrow('not built for ia32');
  });

  it.skipIf(process.platform === 'win32')('prefers the native arm64 loader only on arm64 hosts that have one', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nexus-layout-')); created.push(root);
    for (const bin of ['bin', 'bin-arm64']) {
      await mkdir(path.join(root, 'files', bin), { recursive: true });
      await writeFile(path.join(root, 'files', bin, 'wine'), '#!/bin/sh\n', { mode: 0o755 });
    }
    expect(await runtimeLoader(root, 'arm64')).toBe(path.join(root, 'files', 'bin-arm64', 'wine'));
    expect(await runtimeLoader(root, 'x64')).toBe(path.join(root, 'files', 'bin', 'wine'));
    // An x86_64 runtime on an arm64 host (run under FEX) keeps files/bin.
    await rm(path.join(root, 'files', 'bin-arm64'), { recursive: true });
    expect(await runtimeLoader(root, 'arm64')).toBe(path.join(root, 'files', 'bin', 'wine'));
    // A newly downloaded ARM archive must not silently activate x86 code.
    await expect(runtimeLoader(root, 'arm64', false)).rejects.toThrow('no executable native loader');
    await expect(runtimeLoader(root, 'riscv64')).rejects.toThrow('not built');
  });
});
