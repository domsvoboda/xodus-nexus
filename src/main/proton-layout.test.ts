import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARM64_LAYOUT, detectProtonLayout, locateProtonWine, protonRootOf, X86_64_LAYOUT } from './proton-layout.js';

/** A 64-byte little-endian ELF64 header with the given e_machine. */
function elf64(machine: number): Buffer {
  const header = Buffer.alloc(64);
  header.write('7f454c46', 0, 'hex');
  header[4] = 2; // ELFCLASS64
  header[5] = 1; // little-endian
  header.writeUInt16LE(machine, 18);
  return header;
}

describe('Proton layout detection', () => {
  const created: string[] = [];
  afterEach(async () => { for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true }); });

  async function tree(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'xodus-nexus-layout-'));
    created.push(root);
    return path.join(root, 'proton');
  }

  it('treats a bin-arm64 loader as the CachyOS arm64 layout without reading it', async () => {
    const root = await tree();
    const wine = path.join(root, 'files', 'bin-arm64', 'wine');
    expect(protonRootOf(wine)).toBe(root);
    expect(await detectProtonLayout(wine)).toEqual(ARM64_LAYOUT);
  });

  it('keeps the x86_64 layout for scripts and x86_64 loaders', async () => {
    const root = await tree();
    const wine = path.join(root, 'files', 'bin', 'wine');
    await mkdir(path.dirname(wine), { recursive: true });
    await writeFile(wine, '#!/bin/sh\nexit 0\n');
    expect(await detectProtonLayout(wine)).toEqual(X86_64_LAYOUT);
    await writeFile(wine, elf64(62));
    expect(await detectProtonLayout(wine)).toEqual(X86_64_LAYOUT);
    expect(await detectProtonLayout(path.join(root, 'missing', 'wine'))).toEqual({ ...X86_64_LAYOUT, bin: 'missing' });
  });

  it('recognizes an aarch64 loader in files/bin and probes for the renamed prefix', async () => {
    const root = await tree();
    const wine = path.join(root, 'files', 'bin', 'wine');
    await mkdir(path.dirname(wine), { recursive: true });
    await writeFile(wine, elf64(183));
    expect(await detectProtonLayout(wine)).toEqual({ bin: 'bin', defaultPrefix: 'default_pfx', peArch: 'aarch64-windows' });
    await mkdir(path.join(root, 'files', 'share', 'default_pfx_arm64'), { recursive: true });
    expect(await detectProtonLayout(wine)).toEqual({ bin: 'bin', defaultPrefix: 'default_pfx_arm64', peArch: 'aarch64-windows' });
  });

  it('locates the loader for each launcher architecture', async () => {
    const root = await tree();
    const x64 = path.join(root, 'files', 'bin', 'wine');
    const arm64 = path.join(root, 'files', 'bin-arm64', 'wine');
    expect(await locateProtonWine(root, 'x64')).toBe(x64);
    expect(await locateProtonWine(root, 'arm64')).toBe(x64);
    await mkdir(path.dirname(x64), { recursive: true });
    await writeFile(x64, 'loader');
    expect(await locateProtonWine(root, 'arm64')).toBe(x64);
    await mkdir(path.dirname(arm64), { recursive: true });
    await writeFile(arm64, 'loader');
    expect(await locateProtonWine(root, 'arm64')).toBe(arm64);
    expect(await locateProtonWine(root, 'x64')).toBe(x64);
  });
});
