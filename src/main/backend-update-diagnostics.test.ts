import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendManager } from './backend.js';
import { BackendDiagnostics, setBackendDiagnostics } from './backend-diagnostics.js';
import { backendLock, backendPackageName, backendRecipeSha256 } from './backend-package.js';
import { BACKEND_ARCH_SUFFIX, ELF_MACHINE, currentArch } from './arch.js';
import { run } from './process.js';

// The installer must reach real tar/filesystem code, while the staged CLI is a
// synthetic fixture that never executes a real backend or touches an account.
vi.mock('./process.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./process.js')>();
  const help = 'xodus-cli 0.1.0\n  account    Account\n  login    Login\n  logout    Logout\n  download    Download\n  streaming    Streaming\n  run    Run\n  resolve-package    Resolve packages\n\nOptions:\n  --external-webview-stdio  External UI\n';
  return { ...actual, run: vi.fn(async (cmd: string, args: string[], options: object) => {
    if (cmd.endsWith('/xodus-cli')) {
      if (args[0] === 'streaming') return { code: 0, output: '--selected-content-id\n--json\n' };
      if (args[0] === 'run') return { code: 0, output: '--materialize-chain\n' };
      if (args[0] === '--help') return { code: 0, output: help };
      return { code: 0, output: '' };
    }
    if (['git', 'cargo', 'rustc', 'protoc'].includes(cmd)) return { code: 1, output: 'Build tool intentionally absent' };
    if (cmd === 'ps') return { code: 0, output: '' };
    return actual.run(cmd, args, options);
  }) };
});

const arch = currentArch();
const version = backendLock.version;
const packageName = backendPackageName(version, arch);
const archiveName = `${packageName}.tar.xz`;
const assetUrl = (asset: string) => `https://github.com/domsvoboda/nexus-backend/releases/download/backend-v${version}/${asset}`;
const sha = (data: Buffer, algorithm = 'sha256') => createHash(algorithm).update(data).digest('hex');
const elf = () => {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  bytes.writeUInt16LE(ELF_MACHINE[arch], 18);
  return bytes;
};

let root: string;
let managed: string;
let log: BackendDiagnostics;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-backend-update-diagnostics-'));
  managed = path.join(root, 'xodus-backends');
  await fs.mkdir(managed);
  log = new BackendDiagnostics(root);
  setBackendDiagnostics(log);
});
afterEach(async () => {
  setBackendDiagnostics(undefined);
  await log.read().catch(() => {});
  for (const entry of await fs.readdir(managed).catch(() => [] as string[]))
    if (entry.startsWith('.download-')) await fs.chmod(path.join(managed, entry), 0o700).catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
});

/** A tiny synthetic package whose bytes never leave this fixture. */
async function packageFixture(options: { badDigest?: boolean } = {}) {
  const build = path.join(root, 'build');
  const bundle = path.join(build, packageName);
  await fs.mkdir(bundle, { recursive: true });
  await fs.writeFile(path.join(bundle, 'xodus-cli'), elf());
  await fs.writeFile(path.join(bundle, 'xodus-service'), elf());
  await fs.writeFile(path.join(bundle, 'LICENSE'), 'synthetic license fixture');
  const files: Record<string, string> = {};
  for (const file of ['xodus-cli', 'xodus-service', 'LICENSE']) files[file] = sha(await fs.readFile(path.join(bundle, file)));
  expect((await run('tar', ['-cJf', path.join(build, archiveName), '-C', build, packageName])).code).toBe(0);
  const bytes = await fs.readFile(path.join(build, archiveName));
  const archiveSha512 = options.badDigest ? sha(randomBytes(32), 'sha512') : sha(bytes, 'sha512');
  const manifest = {
    schema: 2, sourceRepository: 'domsvoboda/nexus-backend', authUi: 'electron', version, commit: backendLock.commit,
    recipeSha256: backendRecipeSha256, compatibility: backendLock.compatibility, platform: 'linux', arch,
    archive: archiveName, archiveSha512, files,
  };
  return { manifest, bytes };
}

function fetcherFor(fixture: { manifest: Record<string, unknown>; bytes: Buffer }, options: { omitSource?: boolean; archive?: () => Response | Promise<Response> } = {}) {
  const requests: string[] = [];
  const assets = [archiveName, `${packageName}.manifest.json`, `${packageName}.sha512sum`, `${packageName}-source.tar.xz`,
    ...(options.omitSource ? [] : [`${packageName}-source.sha512sum`])];
  const fetcher = vi.fn(async (input: URL | RequestInfo) => {
    const target = String(input); requests.push(target);
    if (target.includes('/releases?')) return new Response(JSON.stringify([{ tag_name: `backend-v${version}`,
      assets: assets.map(asset => ({ name: asset, browser_download_url: assetUrl(asset) })) }]));
    if (target.endsWith('.manifest.json')) return new Response(JSON.stringify(fixture.manifest));
    if (target.endsWith('.sha512sum')) return new Response(`${fixture.manifest.archiveSha512}  ${archiveName}\n`);
    if (target.endsWith(archiveName)) return options.archive ? options.archive() : new Response(fixture.bytes);
    return new Response('source fixture bytes');
  });
  return { fetcher: fetcher as unknown as typeof fetch, requests };
}

function manager(fetcher: typeof fetch) {
  return new BackendManager(root, '', () => {}, () => false, fetcher);
}

async function restrictStaging() {
  const staging = (await fs.readdir(managed)).find(entry => entry.startsWith('.download-'));
  if (!staging) throw Error('synthetic staging directory missing');
  await fs.chmod(path.join(managed, staging), 0o500);
  return path.join(managed, staging);
}

async function gameSaveFixture() {
  const save = path.join(root, 'prefix', 'drive_c', 'users', 'synthetic', 'save');
  await fs.mkdir(save, { recursive: true });
  const file = path.join(save, 'slot1.sav');
  await fs.writeFile(file, 'synthetic-save-bytes');
  return file;
}

async function seedWorkingBackend() {
  const directory = path.join(managed, 'releases', 'old');
  await fs.mkdir(directory, { recursive: true });
  for (const file of ['xodus-cli', 'xodus-service', 'LICENSE']) await fs.writeFile(path.join(directory, file), elf(), { mode: file === 'LICENSE' ? 0o644 : 0o755 });
  const pointer = { commit: backendLock.commit, binaryPath: path.join(directory, 'xodus-cli'), builtAt: new Date().toISOString(),
    linuxRunPatch: backendLock.compatibility, recipeSha256: backendRecipeSha256, version: '0.0.1', delivery: 'release' };
  const bytes = JSON.stringify(pointer, null, 2);
  await fs.writeFile(path.join(managed, 'current.json'), bytes);
  return { pointer: bytes, directory };
}

async function updateRecords(): Promise<Array<Record<string, unknown>>> {
  const { content } = await log.read();
  const lines = content.trim().split('\n').filter(line => line.startsWith('{'));
  return lines.map(line => JSON.parse(line)).filter(row => row.operation === 'update');
}

describe('backend update diagnostics', () => {
  it('records a successful install as fixed stages with no paths, URLs or child output', async () => {
    const fixture = await packageFixture();
    await manager(fetcherFor(fixture).fetcher).update(() => {});
    const records = await updateRecords();
    expect(records.filter(row => row.event === 'start')).toHaveLength(1);
    expect(records.filter(row => row.event === 'diagnostic').map(row => row.stage)).toEqual(expect.arrayContaining(['update-download', 'update-verify', 'update-validate', 'update-activate', 'update-ready']));
    expect(records.filter(row => row.event === 'failure')).toEqual([]);
    expect(records.filter(row => row.event === 'exit')).toEqual([expect.objectContaining({ code: 0 })]);
    const { content } = await log.read();
    expect(content).not.toMatch(/https:|\.tar\.xz|xodus-backends|nexus-backend-update-diagnostics/);
  });

  it('records a failed release lookup with its fixed HTTP status and no response text', async () => {
    const fetcher = vi.fn(async () => new Response('private rate-limit detail', { status: 403 })) as unknown as typeof fetch;
    const selected = manager(fetcher);
    await expect(selected.update(() => {})).rejects.toThrow('HTTP 403');
    const records = await updateRecords();
    expect(records.filter(row => row.event === 'failure')).toEqual([expect.objectContaining({ stage: 'update-discovery', status: 403, committed: false })]);
    const { content } = await log.read();
    expect(content).not.toMatch(/private rate-limit|api\.github/);
  });

  it('records a wrong archive digest as a precommit checksum failure and keeps the old backend usable', async () => {
    const old = await seedWorkingBackend();
    const fixture = await packageFixture({ badDigest: true });
    const selected = manager(fetcherFor(fixture).fetcher);
    await selected.refresh();
    expect(selected.current.available).toBe(true);
    await expect(selected.update(() => {})).rejects.toThrow('SHA-512 verification failed');
    const records = await updateRecords();
    expect(records.filter(row => row.event === 'failure')).toEqual([expect.objectContaining({ stage: 'update-checksum', committed: false })]);
    expect(records.filter(row => row.event === 'exit')).toEqual([expect.objectContaining({ code: -1 })]);
    expect(await fs.readFile(path.join(managed, 'current.json'), 'utf8')).toBe(old.pointer);
    expect((await fs.stat(path.join(old.directory, 'xodus-cli'))).isFile()).toBe(true);
    expect(selected.current.available).toBe(true);
    expect(selected.current.phase).toContain('no new backend was activated');
    expect((await fs.readdir(managed)).some(entry => entry.startsWith('.download-'))).toBe(false);
    const { content } = await log.read();
    expect(content).not.toMatch(/SHA-512 verification|https:|xodus-backends|nexus-backend-update-diagnostics/);
  });

  it('records a missing release asset as a discovery failure before any download', async () => {
    const old = await seedWorkingBackend();
    const fixture = await packageFixture();
    const selected = manager(fetcherFor(fixture, { omitSource: true }).fetcher);
    await selected.refresh();
    await expect(selected.update(() => {})).rejects.toThrow('No compatible Nexus backend release');
    const records = await updateRecords();
    expect(records.filter(row => row.event === 'failure')).toEqual([expect.objectContaining({ stage: 'update-discovery', committed: false })]);
    expect(await fs.readFile(path.join(managed, 'current.json'), 'utf8')).toBe(old.pointer);
    expect(selected.current.available).toBe(true);
    expect(selected.current.phase).toContain('no new backend was activated');
  });

  it('records a failed pointer publication as a precommit commit failure and keeps the verified release', async () => {
    await fs.mkdir(path.join(managed, 'current.json'));
    const fixture = await packageFixture();
    const selected = manager(fetcherFor(fixture).fetcher);
    await expect(selected.update(() => {})).rejects.toMatchObject({ committed: false });
    const records = await updateRecords();
    expect(records.filter(row => row.event === 'failure')).toEqual([expect.objectContaining({ stage: 'update-commit', committed: false })]);
    const release = path.join(managed, 'releases', `${packageName}-${String(fixture.manifest.archiveSha512).slice(0, 16)}`);
    expect((await fs.stat(path.join(release, 'xodus-cli'))).isFile()).toBe(true);
    expect(selected.current.phase).toContain('no new backend was activated');
  });

  it('records an unusable managed path as a bounded storage failure without leaking the path', async () => {
    await fs.rm(managed, { recursive: true, force: true });
    await fs.writeFile(managed, 'not a directory');
    const fixture = await packageFixture();
    const selected = manager(fetcherFor(fixture).fetcher);
    await expect(selected.update(() => {})).rejects.toMatchObject({ committed: false });
    const records = await updateRecords();
    expect(records.filter(row => row.event === 'failure')).toEqual([expect.objectContaining({ stage: 'update-storage', committed: false })]);
    const { content } = await log.read();
    expect(content).not.toContain(root);
    expect(content).not.toMatch(/ENOTDIR|not a directory|xodus-backends/);
  });

  it.skipIf(process.getuid?.() === 0)('records a permission-denied profile path as update-storage without leaking it', async () => {
    const denied = path.join(root, 'readonly-profile');
    await fs.mkdir(denied);
    await fs.chmod(denied, 0o500);
    try {
      const fixture = await packageFixture();
      const restricted = new BackendManager(denied, '', () => {}, () => false, fetcherFor(fixture).fetcher);
      await expect(restricted.update(() => {})).rejects.toMatchObject({ committed: false });
      const records = await updateRecords();
      expect(records.filter(row => row.event === 'failure')).toEqual([expect.objectContaining({ stage: 'update-storage', committed: false })]);
      const { content } = await log.read();
      expect(content).not.toMatch(/readonly-profile|EACCES|xodus-backends/);
    } finally { await fs.chmod(denied, 0o700); }
  });

  it('records a broken transport read as update-download-http, not as local storage', async () => {
    const fixture = await packageFixture();
    const fetcher = fetcherFor(fixture, { archive: () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error('private socket reset')); },
    })) }).fetcher;
    const selected = manager(fetcher);
    await expect(selected.update(() => {})).rejects.toMatchObject({ committed: false });
    const failures = (await updateRecords()).filter(row => row.event === 'failure');
    expect(failures).toEqual([expect.objectContaining({ stage: 'update-download-http', committed: false })]);
    const { content } = await log.read();
    expect(content).not.toMatch(/socket reset|update-storage/);
    expect((await fs.readdir(managed)).some(entry => entry.startsWith('.download-'))).toBe(false);
  });

  it('records a local archive write failure as update-storage, not as transport', async () => {
    const fixture = await packageFixture();
    const fetcher = fetcherFor(fixture, { archive: async () => {
      const staging = (await fs.readdir(managed)).find(entry => entry.startsWith('.download-'));
      if (!staging) throw Error('synthetic staging directory missing');
      await fs.mkdir(path.join(managed, staging, archiveName));
      return new Response(fixture.bytes);
    } }).fetcher;
    const selected = manager(fetcher);
    await expect(selected.update(() => {})).rejects.toMatchObject({ committed: false });
    const failures = (await updateRecords()).filter(row => row.event === 'failure');
    expect(failures).toEqual([expect.objectContaining({ stage: 'update-storage', committed: false })]);
    const { content } = await log.read();
    expect(content).not.toMatch(/EISDIR|update-download-http/);
    expect((await fs.readdir(managed)).some(entry => entry.startsWith('.download-'))).toBe(false);
  });

  it('records a standalone release check failure with its own stage and truthful status', async () => {
    const fetcher = vi.fn(async () => new Response('private rate-limit detail', { status: 403 })) as unknown as typeof fetch;
    const selected = manager(fetcher);
    const status = await selected.checkUpdate();
    expect(status.releaseAvailable).toBe(false);
    expect(status.updateAvailable).toBe(false);
    expect(status.checking).toBe(false);
    expect(status.blockReason).toContain('HTTP 403');
    const failures = (await updateRecords()).filter(row => row.event === 'failure');
    expect(failures).toEqual([expect.objectContaining({ stage: 'update-check-failed', committed: false, status: 403 })]);
    expect((await log.read()).content).not.toMatch(/private rate-limit/);
    expect(await fs.readdir(managed)).toEqual([]);
  });

  it('records a duplicate update attempt as update-blocked without releasing the running reservation', async () => {
    const fixture = await packageFixture();
    const selected = manager(fetcherFor(fixture).fetcher);
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(selected, 'externalDownloadRunning').mockReturnValue(paused.then(() => false));
    const pending = selected.update(() => {}).catch(error => error);
    expect(selected.current.updating).toBe(true);
    await expect(selected.update(() => {})).rejects.toThrow('already running');
    const failures = (await updateRecords()).filter(row => row.event === 'failure');
    expect(failures).toEqual([expect.objectContaining({ stage: 'update-blocked', committed: false })]);
    expect(selected.current.updating).toBe(true);
    release();
    expect(await pending).toBeUndefined();
  });

  it.skipIf(process.getuid?.() === 0)('keeps the checksum failure and user reason when staging cleanup also fails', async () => {
    const old = await seedWorkingBackend();
    const save = await gameSaveFixture();
    const fixture = await packageFixture({ badDigest: true });
    let pulls = 0;
    const fetcher = fetcherFor(fixture, { archive: () => new Response(new ReadableStream({
      async pull(controller) {
        pulls++;
        if (pulls === 1) { controller.enqueue(new Uint8Array(fixture.bytes)); return; }
        // The download is complete; make the owned staging directory impossible
        // to remove so the checksum failure and cleanup failure happen together.
        if (pulls === 2) await restrictStaging();
        controller.close();
      },
    })) }).fetcher;
    const selected = manager(fetcher);
    await selected.refresh();
    expect(selected.current.available).toBe(true);
    const error = await selected.update(() => {}).catch(value => value);
    expect(error).toMatchObject({ committed: false });
    expect(error.message).toContain('SHA-512 verification failed');
    expect(selected.current.blockReason).toContain('SHA-512 verification failed');
    expect(selected.current.phase).toContain('no new backend was activated');
    const rows = await updateRecords();
    expect(rows.filter(row => row.event === 'failure')).toEqual([expect.objectContaining({ stage: 'update-checksum', committed: false })]);
    expect(rows.filter(row => row.event === 'diagnostic' && row.stage === 'update-cleanup')).toHaveLength(1);
    expect(await fs.readFile(path.join(managed, 'current.json'), 'utf8')).toBe(old.pointer);
    expect((await fs.stat(path.join(old.directory, 'xodus-cli'))).isFile()).toBe(true);
    expect(await fs.readFile(save, 'utf8')).toBe('synthetic-save-bytes');
    expect(selected.current.available).toBe(true);
    const { content } = await log.read();
    expect(content).not.toMatch(/EACCES|EPERM|nexus-backend-update-diagnostics|xodus-backends/);
  });

  it.skipIf(process.getuid?.() === 0)('fails an otherwise valid install as update-cleanup without activating it', async () => {
    const old = await seedWorkingBackend();
    const save = await gameSaveFixture();
    const fixture = await packageFixture();
    const selected = manager(fetcherFor(fixture).fetcher);
    await selected.refresh();
    const internals = selected as unknown as { validate(binary: string): Promise<Record<string, boolean>> };
    vi.spyOn(internals, 'validate').mockImplementation(async () => {
      await restrictStaging();
      return { account: true, run: true, streaming: true, login: true, logout: true, download: true, externalAuth: true, packageSelection: true };
    });
    const error = await selected.update(() => {}).catch(value => value);
    expect(error).toMatchObject({ committed: false });
    expect(error.message).toContain('staging area could not be removed');
    expect(selected.current.blockReason).toContain('staging area could not be removed');
    expect(selected.current.phase).toContain('no new backend was activated');
    const rows = await updateRecords();
    expect(rows.filter(row => row.event === 'failure')).toEqual([expect.objectContaining({ stage: 'update-cleanup', committed: false })]);
    expect(rows.filter(row => row.event === 'diagnostic' && row.stage === 'update-cleanup')).toHaveLength(1);
    expect(await fs.readFile(path.join(managed, 'current.json'), 'utf8')).toBe(old.pointer);
    expect((await fs.stat(path.join(old.directory, 'xodus-cli'))).isFile()).toBe(true);
    const release = path.join(managed, 'releases', `${packageName}-${String(fixture.manifest.archiveSha512).slice(0, 16)}`);
    expect((await fs.stat(path.join(release, 'xodus-cli'))).isFile()).toBe(true);
    expect(await fs.readFile(save, 'utf8')).toBe('synthetic-save-bytes');
    expect(selected.current.available).toBe(true);
    const { content } = await log.read();
    expect(content).not.toMatch(/EACCES|EPERM|nexus-backend-update-diagnostics|xodus-backends/);
  });

  it('records a committed activation that needs attention as committed:true', async () => {
    const fixture = await packageFixture();
    const selected = manager(fetcherFor(fixture).fetcher);
    vi.spyOn(selected, 'refresh').mockRejectedValue(Error('synthetic probe failure'));
    await expect(selected.update(() => {})).rejects.toMatchObject({ committed: true });
    const records = await updateRecords();
    expect(records.filter(row => row.event === 'failure')).toEqual([expect.objectContaining({ stage: 'update-confirm', committed: true })]);
    expect(records.filter(row => row.event === 'exit')).toEqual([expect.objectContaining({ code: -1 })]);
    const pointer = JSON.parse(await fs.readFile(path.join(managed, 'current.json'), 'utf8'));
    expect((await fs.stat(path.join(pointer.binaryPath))).isFile()).toBe(true);
    expect(selected.current.phase).toContain('needs attention');
    const { content } = await log.read();
    expect(content).not.toContain('synthetic probe failure');
  });

  it('never stores an unallowlisted stage or a raw reason for an update failure', async () => {
    log.record({ operation: 'update', event: 'failure', stage: 'update-checksum', committed: false, message: 'EACCES ' + root } as never);
    const records = await updateRecords();
    expect(records).toEqual([expect.objectContaining({ event: 'failure', stage: 'update-checksum', committed: false })]);
    const { content } = await log.read();
    expect(content).not.toContain(root);
    expect(content).not.toMatch(/EACCES/);
  });
});
