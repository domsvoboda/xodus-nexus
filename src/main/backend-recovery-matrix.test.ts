import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendManager } from './backend.js';
import { BackendDiagnostics, setBackendDiagnostics } from './backend-diagnostics.js';
import { backendLock, backendPackageName, backendRecipeSha256, compareVersions, minimumBackendVersion, validateBackendManifest } from './backend-package.js';
import { BACKEND_ARCH_SUFFIX, ELF_MACHINE, currentArch } from './arch.js';
import { run } from './process.js';
import { ComponentUpdates, type PreparedComponentUpdate } from './component-updates.js';
import { ComponentUpdateAdmission } from './component-update-admission.js';
import { assertActivityCompatible } from './install-queue.js';

// The synthetic backend binary is never executed; only help/capability parsing
// and install validation are exercised. Real tar/filesystem code is used.
vi.mock('./process.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./process.js')>();
  const help = 'xodus-cli 0.1.0\n  account    Account\n  login    Login\n  logout    Logout\n  download    Download\n  streaming    Streaming\n  run    Run\n  resolve-package    Resolve packages\n\nOptions:\n  --external-webview-stdio  External UI\n';
  return { ...actual, run: vi.fn(async (cmd: string, args: string[], options: object) => {
    if (cmd.endsWith('/xodus-cli')) {
      const bytes = await fs.readFile(cmd).catch(() => Buffer.alloc(64));
      if (bytes[63] === 7) return { code: 127, output: '/private/path/xodus-cli: error while loading shared libraries: libdbus-1.so.3: cannot open shared object file: No such file or directory\n' };
      if (args[0] === 'streaming') return { code: 0, output: '--selected-content-id\n--json\n' };
      if (args[0] === 'run') return { code: 0, output: '--materialize-chain\n' };
      if (args[0] === 'resolve-package') return { code: 0, output: '--json\n' };
      if (args[0] === '--help') return { code: 0, output: help };
      return { code: 0, output: '' };
    }
    if (cmd.endsWith('/xodus-service')) throw new Error('Service must never start in installer tests');
    if (['git', 'cargo', 'rustc', 'protoc'].includes(cmd)) return { code: 1, output: 'Build tool intentionally absent' };
    if (cmd === 'ps') return { code: 0, output: '' };
    return actual.run(cmd, args, options);
  }) };
});

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.ES2022, true);
const names = new Set(['ensureIdle', 'ensureActivityIdle']);
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text))
  .map(node => node.getText(ast)).join('\n');
const register = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'registerIpc') as ts.FunctionDeclaration;
const handlerSource = register.body!.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(ast) === 'ipcMain.handle' && ts.isStringLiteral(node.expression.arguments[0])
  && node.expression.arguments[0].text === 'backend-update').map(node => node.getText(ast)).join('\n');

const arch = currentArch();
const version = backendLock.version;
const sha = (data: Buffer, algorithm = 'sha256') => createHash(algorithm).update(data).digest('hex');
const elf = (marker = 0) => {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  bytes.writeUInt16LE(ELF_MACHINE[arch], 18);
  bytes[63] = marker;
  return bytes;
};

let root: string;
let managed: string;
let log: BackendDiagnostics;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-backend-recovery-matrix-'));
  managed = path.join(root, 'xodus-backends');
  await fs.mkdir(managed, { recursive: true });
  log = new BackendDiagnostics(root);
  setBackendDiagnostics(log);
});
afterEach(async () => {
  setBackendDiagnostics(undefined);
  await log.read().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
});

async function records(): Promise<Array<Record<string, unknown>>> {
  const { content } = await log.read();
  return content.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
}

interface ReleaseFixture {
  manifest: Record<string, unknown>;
  bytes: Buffer;
  packageName: string;
  archive: string;
  tag: string;
  repository: 'domsvoboda/nexus-backend' | 'domsvoboda/xodus-nexus';
}

/** A tiny synthetic release whose bytes never leave this fixture. */
async function releaseFixture(releaseVersion = version, legacy = false): Promise<ReleaseFixture> {
  const name = backendPackageName(releaseVersion, arch);
  const archive = `${name}.tar.xz`;
  const build = path.join(root, 'build', `${releaseVersion}-${legacy ? 'legacy' : 'modern'}`);
  const bundle = path.join(build, name);
  await fs.mkdir(bundle, { recursive: true });
  for (const file of ['xodus-cli', 'xodus-service', 'LICENSE'])
    await fs.writeFile(path.join(bundle, file), file === 'LICENSE' ? Buffer.from('synthetic license fixture') : elf(), { mode: file === 'LICENSE' ? 0o644 : 0o755 });
  const files: Record<string, string> = {};
  for (const file of ['xodus-cli', 'xodus-service', 'LICENSE']) files[file] = sha(await fs.readFile(path.join(bundle, file)));
  expect((await run('tar', ['-cJf', path.join(build, archive), '-C', build, name])).code).toBe(0);
  const bytes = await fs.readFile(path.join(build, archive));
  const common = { authUi: 'electron', version: releaseVersion, commit: backendLock.commit, recipeSha256: backendRecipeSha256,
    compatibility: backendLock.compatibility, platform: 'linux', arch, archive, archiveSha512: sha(bytes, 'sha512'), files };
  // Schema 1 is the published legacy layout; schema 2 is the current one.
  const manifest = legacy ? { schema: 1, ...common } : { schema: 2, sourceRepository: 'domsvoboda/nexus-backend', ...common };
  return { manifest, bytes, packageName: name, archive, tag: `backend-v${releaseVersion}`,
    repository: legacy ? 'domsvoboda/xodus-nexus' : 'domsvoboda/nexus-backend' };
}

function fetcherFor(fixture: ReleaseFixture) {
  const requests: string[] = [];
  const url = (asset: string) => `https://github.com/${fixture.repository}/releases/download/${fixture.tag}/${asset}`;
  const assets = [fixture.archive, `${fixture.packageName}.manifest.json`, `${fixture.packageName}.sha512sum`,
    `${fixture.packageName}-source.tar.xz`, `${fixture.packageName}-source.sha512sum`];
  const release = () => new Response(JSON.stringify([{ tag_name: fixture.tag,
    assets: assets.map(asset => ({ name: asset, browser_download_url: url(asset) })) }]));
  const fetcher = vi.fn(async (input: URL | RequestInfo) => {
    const target = String(input); requests.push(target);
    if (target.includes('/repos/domsvoboda/nexus-backend/releases?'))
      return fixture.repository === 'domsvoboda/nexus-backend' ? release() : new Response('[]');
    if (target.includes('/repos/domsvoboda/xodus-nexus/releases?'))
      return fixture.repository === 'domsvoboda/xodus-nexus' ? release() : new Response('[]');
    if (target.includes('/releases?')) return new Response('[]');
    if (target.endsWith('.manifest.json')) return new Response(JSON.stringify(fixture.manifest));
    if (target.endsWith('.sha512sum')) return new Response(`${fixture.manifest.archiveSha512}  ${fixture.archive}\n`);
    if (target.endsWith(fixture.archive)) return new Response(fixture.bytes);
    return new Response('synthetic source fixture bytes');
  });
  return { fetcher: fetcher as unknown as typeof fetch, requests };
}

function manager(fetcher: typeof fetch) { return new BackendManager(root, '', () => {}, () => false, fetcher); }

async function seedInstalled(installedVersion: string, options: { unusable?: boolean } = {}) {
  const directory = path.join(managed, 'releases', installedVersion.replace(/\./g, '-'));
  await fs.mkdir(directory, { recursive: true });
  const cli = path.join(directory, 'xodus-cli');
  await fs.writeFile(cli, elf(options.unusable ? 7 : 0), { mode: 0o755 });
  await fs.writeFile(path.join(directory, 'xodus-service'), elf(), { mode: 0o755 });
  await fs.writeFile(path.join(directory, 'LICENSE'), 'synthetic old license', { mode: 0o644 });
  const pointer = { commit: backendLock.commit, binaryPath: cli, builtAt: new Date().toISOString(),
    linuxRunPatch: backendLock.compatibility, recipeSha256: backendRecipeSha256, version: installedVersion, delivery: 'release' };
  const bytes = JSON.stringify(pointer, null, 2);
  await fs.writeFile(path.join(managed, 'current.json'), bytes);
  return { directory, pointer: bytes };
}

type Files = Record<string, string>;
async function gameFixtures(): Promise<Files> {
  const files = {
    game: path.join(root, 'games', 'Synthetic Game', 'content.bin'),
    save: path.join(root, 'prefixes', 'synthetic', 'drive_c', 'save', 'slot1.sav'),
    ini: path.join(root, 'prefixes', 'synthetic', 'drive_c', 'settings.ini'),
  };
  for (const file of Object.values(files)) await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(files.game, 'synthetic-game-bytes');
  await fs.writeFile(files.save, 'synthetic-save-bytes');
  await fs.writeFile(files.ini, 'synthetic=1\n');
  return files;
}
async function bytesOf(files: Files): Promise<Record<string, Buffer>> {
  return Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, file]) => [key, await fs.readFile(file)])));
}
async function expectBytes(files: Files, before: Record<string, Buffer>): Promise<void> {
  for (const [key, file] of Object.entries(files)) expect((await fs.readFile(file)).equals(before[key]), key).toBe(true);
}

async function componentPlan(backend: BackendManager, fetcher: typeof fetch) {
  const prepared: PreparedComponentUpdate[] = [await backend.prepareComponentUpdate(() => {})];
  const admission = new ComponentUpdateAdmission(() => {});
  const updates = new ComponentUpdates(admission, async () => prepared, () => {}, () => false);
  return { updates, prepared, admission };
}

/** The actual registerIpc backend-update statement in its production gates. */
function backendUpdateHandler(backend: BackendManager) {
  const handlers = new Map<string, Function>();
  const ctx: any = {
    ipcMain: { handle: (name: string, handler: Function) => handlers.set(name, handler) },
    backend, emitSnapshot: vi.fn(), refreshAccount: vi.fn(async () => {}),
    runtime: { busy: false, current: { updating: false }, assertSettingsReservation: vi.fn() },
    componentUpdateAdmission: new ComponentUpdateAdmission(() => ctx.ensureActivityIdle()),
    offlinePermissionChanging: false, keyringSupport: { busy: false }, authState: { running: false }, authJob: undefined,
    shutdownStarted: false, downloadCancellations: new Set(), preparingInstall: false, preparingContent: false,
    preparingLaunch: false, finalizingGame: false, launcherUpdater: { busy: false }, checkingGameUpdates: false,
    gameRemovalInProgress: false, gameOperation: undefined, operations: new Map(), store: { downloads: [] },
    installQueue: { size: 0 }, assertActivityCompatible,
    backendDiagnostic: (record: unknown) => log.record(record as never),
  };
  runInNewContext(ts.transpileModule(functions + '\n' + handlerSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  return { handlers, ctx };
}

describe('backend recovery matrix with the actual update preparation path', () => {
  it.each([
    ['0.2.13', 'installed below the launcher minimum'],
    ['0.2.14', 'installed at the launcher minimum'],
  ])('prepares and applies recovery from %s (%s) without a capability admission cycle', async installedVersion => {
    const files = await gameFixtures(), before = await bytesOf(files);
    const seeded = await seedInstalled(installedVersion);
    const release = await releaseFixture(), { fetcher } = fetcherFor(release);
    const backend = manager(fetcher);
    expect(await backend.refresh()).toMatchObject({ available: true, version: installedVersion, source: 'managed' });
    expect(await backend.checkUpdate()).toMatchObject({ releaseAvailable: true, updateAvailable: true, blockReason: undefined });
    const { updates, prepared } = await componentPlan(backend, fetcher);
    expect(prepared[0].item).toMatchObject({ id: 'backend', component: 'backend', state: 'ready', currentVersion: installedVersion, targetVersion: version });

    const plan = await updates.plan();
    const result = await updates.apply(plan.id);
    expect(result.items[0]).toMatchObject({ id: 'backend', outcome: 'updated', committed: true });
    expect(backend.current).toMatchObject({ available: true, version, source: 'managed', updateAvailable: false });
    expect(JSON.parse(await fs.readFile(path.join(managed, 'current.json'), 'utf8')).version).toBe(version);
    expect((await fs.stat(seeded.directory)).isDirectory()).toBe(true);
    expect((await records()).filter(row => row.operation === 'component-update')).toEqual([]);
    await expectBytes(files, before);
  });

  it('recovers from an installed below-minimum backend through the actual backend-update IPC handler', async () => {
    const files = await gameFixtures(), before = await bytesOf(files);
    const seeded = await seedInstalled('0.2.13');
    const release = await releaseFixture(), { fetcher } = fetcherFor(release);
    const backend = manager(fetcher);
    expect(await backend.refresh()).toMatchObject({ available: true, version: '0.2.13' });
    expect(await backend.checkUpdate()).toMatchObject({ releaseAvailable: true, updateAvailable: true });
    const { handlers, ctx } = backendUpdateHandler(backend);

    await handlers.get('backend-update')!();

    expect(backend.current).toMatchObject({ available: true, version, source: 'managed' });
    expect(ctx.refreshAccount).toHaveBeenCalledOnce();
    expect(JSON.parse(await fs.readFile(path.join(managed, 'current.json'), 'utf8')).version).toBe(version);
    expect(seeded.pointer).not.toBe(await fs.readFile(path.join(managed, 'current.json'), 'utf8'));
    expect((await fs.stat(seeded.directory)).isDirectory()).toBe(true);
    expect((await records()).filter(row => row.operation === 'component-update')).toEqual([]);
    await expectBytes(files, before);
  });

  it('offers and performs a direct install when the backend is missing, and does not auto-install it in a component plan', async () => {
    const files = await gameFixtures(), before = await bytesOf(files);
    const release = await releaseFixture(), { fetcher } = fetcherFor(release);
    const backend = manager(fetcher);
    expect(await backend.refresh()).toMatchObject({ available: false, source: 'none' });
    expect(await backend.checkUpdate()).toMatchObject({ releaseAvailable: true, updateAvailable: true });
    // Update all deliberately skips an absent backend instead of guessing an
    // install destination; the Settings Install action remains available.
    const { prepared, updates } = await componentPlan(backend, fetcher);
    expect(prepared[0].item).toMatchObject({ state: 'skipped' });
    const plan = await updates.plan();
    const result = await updates.apply(plan.id);
    expect(result.items[0].outcome).toBe('skipped');
    expect(backend.current.available).toBe(false);
    await expect(fs.readFile(path.join(managed, 'current.json'))).rejects.toThrow();

    const { handlers } = backendUpdateHandler(backend);
    await handlers.get('backend-update')!();
    expect(backend.current).toMatchObject({ available: true, version });
    await expectBytes(files, before);
  });

  it('recovers an unusable installed backend through the actual IPC handler and keeps the old release', async () => {
    const files = await gameFixtures(), before = await bytesOf(files);
    const seeded = await seedInstalled('0.2.14', { unusable: true });
    const release = await releaseFixture(), { fetcher } = fetcherFor(release);
    const backend = manager(fetcher);
    const broken = await backend.refresh();
    expect(broken.available).toBe(false);
    expect(broken.blockReason).toContain('D-Bus runtime library is missing');
    expect(await backend.checkUpdate()).toMatchObject({ releaseAvailable: true, updateAvailable: true });
    // The component plan must not claim it can repair an unusable managed backend.
    const { prepared } = await componentPlan(backend, fetcher);
    expect(prepared[0].item.state).toBe('skipped');
    expect(prepared[0].item.reason).toContain('Only an installed managed backend release');

    const { handlers } = backendUpdateHandler(backend);
    await handlers.get('backend-update')!();
    expect(backend.current).toMatchObject({ available: true, version, source: 'managed' });
    expect((await fs.stat(seeded.directory)).isDirectory()).toBe(true);
    await expectBytes(files, before);
  });

  it('reports a current backend as unchanged and never downloads or replaces it', async () => {
    const files = await gameFixtures(), before = await bytesOf(files);
    const seeded = await seedInstalled(version);
    const release = await releaseFixture(), { fetcher, requests } = fetcherFor(release);
    const backend = manager(fetcher);
    expect(await backend.refresh()).toMatchObject({ available: true, version });
    expect(await backend.checkUpdate()).toMatchObject({ releaseAvailable: true, updateAvailable: false });
    const { prepared, updates } = await componentPlan(backend, fetcher);
    expect(prepared[0].item.state).toBe('unchanged');
    const plan = await updates.plan();
    const result = await updates.apply(plan.id);
    expect(result.items[0].outcome).toBe('unchanged');
    expect(await fs.readFile(path.join(managed, 'current.json'), 'utf8')).toBe(seeded.pointer);
    expect(requests.some(url => url.endsWith(release.archive))).toBe(false);
    expect((await records()).filter(row => row.operation === 'update')).toEqual([]);
    await expectBytes(files, before);
  });

  it('installs the published minimum version 0.2.14 legacy release from the legacy repository', async () => {
    const files = await gameFixtures(), before = await bytesOf(files);
    await seedInstalled('0.2.13');
    const release = await releaseFixture('0.2.14', true);
    const { fetcher, requests } = fetcherFor(release);
    const backend = manager(fetcher);
    expect(await backend.refresh()).toMatchObject({ available: true, version: '0.2.13' });
    expect(await backend.checkUpdate()).toMatchObject({ releaseAvailable: true, updateAvailable: true });
    const { prepared, updates } = await componentPlan(backend, fetcher);
    expect(prepared[0].item).toMatchObject({ state: 'ready', currentVersion: '0.2.13', targetVersion: '0.2.14' });
    const plan = await updates.plan();
    const result = await updates.apply(plan.id);
    expect(result.items[0]).toMatchObject({ outcome: 'updated', committed: true });
    expect(JSON.parse(await fs.readFile(path.join(managed, 'current.json'), 'utf8')).version).toBe('0.2.14');
    expect(requests.some(target => target.endsWith('/xodus-nexus-backend-0.2.14-linux-x86_64.tar.xz'))).toBe(true);
    await expectBytes(files, before);
  });

  it('accepts the published 0.2.14 legacy manifest as a valid recovery target and keeps 0.2.13 below the minimum', () => {
    // Exact public fields of xodus-nexus-backend-0.2.14-linux-x86_64.manifest.json.
    const published = { schema: 1, version: '0.2.14', commit: '53ea781dcd073e31d7ea68e894134e9c959bff04',
      recipeSha256: 'd2d57ba9ffd973778bb253d64e4d6be8d780ed8434474dab367bf35cf3c9563c', compatibility: 'linux-run-v25',
      authUi: 'electron', platform: 'linux', arch: 'x64', archive: 'xodus-nexus-backend-0.2.14-linux-x86_64.tar.xz',
      archiveSha512: '7b5d8ddfb99245a4e7ed1023a324cb1ed56ddcb35bf0903564ad5a0b26493425bfc133a172973350c59331b012b639f218665a946738161d6a8cd7a1d0f71a21',
      files: { 'xodus-cli': '3938cb1c6f109f4249953270fa241178856e791240376fe96f94fd807fe3c026',
        'xodus-service': '36f299bace488371e1ca6915dee61d69d199e66aa66307561323e1c5ec6dfb50',
        LICENSE: '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986' } };
    expect(compareVersions('0.2.14', minimumBackendVersion)).toBe(0);
    expect(compareVersions('0.2.13', minimumBackendVersion)).toBeLessThan(0);
    expect(backendPackageName('0.2.14', 'x64')).toBe('xodus-nexus-backend-0.2.14-linux-x86_64');
    expect(validateBackendManifest(structuredClone(published), 'x64', 'domsvoboda/xodus-nexus')).toMatchObject({ schema: 1, version: '0.2.14', arch: 'x64' });
    expect(() => validateBackendManifest(structuredClone(published), 'x64', 'domsvoboda/nexus-backend')).toThrow('not a valid compatible release');
  });
});
