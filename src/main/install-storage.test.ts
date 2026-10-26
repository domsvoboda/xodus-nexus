import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { availableInstallBytes } from './install-storage.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-install-space-')); roots.push(root); return root; }
it('reports available rather than reserved filesystem space without creating destination folders', async () => {
  const root = await fixture(), stat = await fs.statfs(root, { bigint: true });
  const result = await availableInstallBytes(path.join(root, 'new', 'game'));
  expect(result).toBeTypeOf('number');
  expect(Math.abs(result! - Number(stat.bsize * stat.bavail))).toBeLessThan(16 * 1024 * 1024);
  expect(await fs.readdir(root)).toEqual([]);
});
it('queries the actual symlinked target and refuses to guess a dangling target filesystem', async () => {
  const root = await fixture(); await fs.mkdir(path.join(root, 'real'));
  await fs.symlink(path.join(root, 'real'), path.join(root, 'link'));
  expect(await availableInstallBytes(path.join(root, 'link', 'new', 'game'))).toBeTypeOf('number');
  await fs.symlink(path.join(root, 'missing', 'target'), path.join(root, 'dangling'));
  expect(await availableInstallBytes(path.join(root, 'dangling', 'game'))).toBeUndefined();
  expect(await fs.readdir(root)).toEqual(['dangling', 'link', 'real']);
});
it.each(['relative', '', '/tmp/with\0nul', '/' + 'a'.repeat(4097)])('rejects invalid renderer paths before filesystem access', async destination => {
  const stat = vi.spyOn(fs, 'statfs');
  await expect(availableInstallBytes(destination)).rejects.toThrow('absolute path'); expect(stat).not.toHaveBeenCalled();
});
it('keeps inaccessible, non-directory and cyclic targets unknown instead of falling back to another disk', async () => {
  const root = await fixture(); await fs.writeFile(path.join(root, 'file'), 'synthetic');
  expect(await availableInstallBytes(path.join(root, 'file', 'new'))).toBeUndefined();
  await fs.symlink('cycle', path.join(root, 'cycle'));
  expect(await availableInstallBytes(path.join(root, 'cycle', 'new'))).toBeUndefined();
  vi.spyOn(fs, 'statfs').mockRejectedValueOnce(Object.assign(Error('private error'), { code: 'EACCES' }));
  expect(await availableInstallBytes(root)).toBeUndefined();
});
it('preserves a genuinely full disk and rejects unusable or unsafe numeric values', async () => {
  const stat = vi.spyOn(fs, 'statfs');
  for (const [bsize, bavail, expected] of [[4096n,0n,0], [4096n,5n,20480], [0n,5n,undefined], [4096n,-1n,undefined], [4096n,BigInt(Number.MAX_SAFE_INTEGER),undefined]] as const) {
    stat.mockResolvedValueOnce({ bsize, bavail } as never);
    expect(await availableInstallBytes('/synthetic/target')).toBe(expected);
  }
});
