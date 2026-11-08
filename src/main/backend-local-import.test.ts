import { expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { backendLock, backendPackageName, backendRecipeSha256 } from './backend-package';
import { currentArch } from './arch';
import { installBackend, prepareLocalBackend } from './backend-releases';

const execute = promisify(execFile), hash = (value: Buffer | string, algorithm: 'sha256' | 'sha512' = 'sha256') => createHash(algorithm).update(value).digest('hex');
const elf = () => { const value = Buffer.alloc(64); value.write('7f454c46', 'hex'); value[4] = 2; value[5] = 1; value.writeUInt16LE(62, 18); return value; };

async function localBuild() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'backend-local-import-'));
  const output = path.join(root, 'output'), packageName = backendPackageName(backendLock.version, currentArch());
  const tree = path.join(output, packageName); await fs.mkdir(tree, { recursive: true });
  const files = { 'xodus-cli': elf(), 'xodus-service': elf(), LICENSE: Buffer.from('local backend license') };
  for (const [name, bytes] of Object.entries(files)) await fs.writeFile(path.join(tree, name), bytes, { mode: 0o755 });
  const archive = path.join(output, packageName + '.tar.xz');
  await execute('tar', ['-cJf', archive, '-C', output, packageName]);
  const archiveBytes = await fs.readFile(archive), archiveSha512 = hash(archiveBytes, 'sha512');
  const manifest = {
    schema: 2, sourceRepository: 'domsvoboda/nexus-backend', version: backendLock.version,
    commit: 'e7884a27f698c7447b96b431b2935f9ed50677f5', recipeSha256: backendRecipeSha256,
    compatibility: backendLock.compatibility, authUi: 'electron', platform: 'linux', arch: currentArch(),
    archive: packageName + '.tar.xz', archiveSha512,
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, hash(bytes)])),
  };
  await fs.writeFile(path.join(output, packageName + '.manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(output, packageName + '.sha512sum'), `${archiveSha512}  ${packageName}.tar.xz\n`);
  const source = Buffer.from('synthetic corresponding backend source'), sourceName = packageName + '-source.tar.xz', sourceSum = packageName + '-source.sha512sum';
  await fs.writeFile(path.join(output, sourceName), source);
  await fs.writeFile(path.join(output, sourceSum), `${hash(source, 'sha512')}  ${sourceName}\n`);
  return { root, output, packageName, manifest, archive };
}

it('prepares and installs the exact local backend 0.2.15 build through the normal core installer', async () => {
  const f = await localBuild(), managedRoot = path.join(f.root, 'managed');
  const prepared = await prepareLocalBackend(f.output, managedRoot);
  expect(prepared.artifact).toMatchObject({ repository: 'domsvoboda/nexus-backend', delivery: 'local', tag: 'local-0.2.15' });
  const fetcher = (async () => { throw Error('Local backend import must not use the network'); }) as unknown as typeof fetch;
  const cli = await installBackend(managedRoot, prepared.artifact, fetcher, async () => {}, async () => {}, () => {});
  expect(await fs.readFile(cli, 'hex')).toContain('7f454c46');
  expect(await fs.access(path.join(managedRoot, 'current.json')).then(() => true, () => false)).toBe(false);
  await prepared.cleanup();
});

it('rejects symlinked local backend inputs before any pointer or receipt exists', async () => {
  const f = await localBuild(), managedRoot = path.join(f.root, 'managed');
  const real = f.archive + '.real'; await fs.rename(f.archive, real); await fs.symlink(real, f.archive);
  await expect(prepareLocalBackend(f.output, managedRoot)).rejects.toThrow('regular non-symlink');
  expect(await fs.access(path.join(managedRoot, 'current.json')).then(() => true, () => false)).toBe(false);
});

it('rejects a local backend source checksum that does not bind the copied source', async () => {
  const f = await localBuild(), managedRoot = path.join(f.root, 'managed');
  await fs.writeFile(path.join(f.output, f.packageName + '-source.sha512sum'), `${'0'.repeat(128)}  ${f.packageName}-source.tar.xz\n`);
  await expect(prepareLocalBackend(f.output, managedRoot)).rejects.toThrow('source archive SHA-512');
  expect(await fs.access(path.join(managedRoot, 'current.json')).then(() => true, () => false)).toBe(false);
});
