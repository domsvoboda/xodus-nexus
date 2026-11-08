import { readFileSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendManager } from './backend.js';
import { BackendDiagnostics, setBackendDiagnostics } from './backend-diagnostics.js';
import { backendHttpStatus } from './backend-releases.js';
import { backendLock, backendRecipeSha256 } from './backend-package.js';
import { ELF_MACHINE, currentArch } from './arch.js';
import { ComponentUpdates, type PreparedComponentUpdate } from './component-updates.js';
import { ComponentUpdateAdmission } from './component-update-admission.js';

// Real tar/filesystem code is not needed here, but backend refresh and update
// discovery must never execute a real backend, account or network request.
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

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.ES2022, true);
const names = new Set(['discoverComponent', 'prepareComponentUpdates']);
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text))
  .map(node => node.getText(ast)).join('\n');
const register = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'registerIpc') as ts.FunctionDeclaration;
const routes = new Set(['component-updates-plan', 'component-updates-apply']);
const handlerSource = register.body!.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(ast) === 'ipcMain.handle' && ts.isStringLiteral(node.expression.arguments[0])
  && routes.has(node.expression.arguments[0].text)).map(node => node.getText(ast)).join('\n');

const elf = () => {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  bytes.writeUInt16LE(ELF_MACHINE[currentArch()], 18);
  return bytes;
};

let root: string;
let managed: string;
let log: BackendDiagnostics;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-component-update-diagnostics-'));
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
async function componentRecords(): Promise<Array<Record<string, unknown>>> {
  return (await records()).filter(row => row.operation === 'component-update');
}
async function updateRecords(): Promise<Array<Record<string, unknown>>> {
  return (await records()).filter(row => row.operation === 'update');
}

async function seedManagedBackend() {
  const directory = path.join(managed, 'releases', 'old');
  await fs.mkdir(directory, { recursive: true });
  for (const file of ['xodus-cli', 'xodus-service', 'LICENSE'])
    await fs.writeFile(path.join(directory, file), elf(), { mode: file === 'LICENSE' ? 0o644 : 0o755 });
  const pointer = { commit: backendLock.commit, binaryPath: path.join(directory, 'xodus-cli'), builtAt: new Date().toISOString(),
    linuxRunPatch: backendLock.compatibility, recipeSha256: backendRecipeSha256, version: backendLock.version, delivery: 'release' };
  const bytes = JSON.stringify(pointer, null, 2);
  await fs.writeFile(path.join(managed, 'current.json'), bytes);
  return { pointer: bytes, directory };
}

function manager(fetcher: typeof fetch) {
  return new BackendManager(root, '', () => {}, () => false, fetcher);
}

function forbidden(): typeof fetch {
  return vi.fn(async () => new Response('synthetic forbidden response', { status: 403 })) as unknown as typeof fetch;
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

function readyEntry(id: string, component: 'backend' | 'runtime' | 'launcher' = 'backend'): PreparedComponentUpdate {
  return { item: { id, component, label: id, state: 'ready' }, isCurrent: vi.fn(async () => true), apply: vi.fn(async () => ({ committed: true })) };
}

/** The actual registerIpc plan/apply statements plus the actual discovery seam. */
function harness(options: { backend?: unknown; prepareManaged?: () => Promise<unknown>; prepareLauncher?: () => Promise<unknown>; discover?: () => Promise<PreparedComponentUpdate[]> }) {
  const handlers = new Map<string, Function>();
  const ctx: any = {
    ipcMain: { handle: (name: string, handler: Function) => handlers.set(name, handler) },
    backend: options.backend ?? {},
    runtime: { current: { updating: false } },
    launcherUpdater: { prepareComponentUpdate: options.prepareLauncher ?? vi.fn(async () => readyEntry('launcher', 'launcher')) },
    store: { settings: { winePath: '' }, setSettings: vi.fn(async () => {}) },
    emitSnapshot: vi.fn(), refreshAccount: vi.fn(async () => {}),
    prepareManagedComponentUpdates: options.prepareManaged ?? vi.fn(async () => [readyEntry('runtime-standard', 'runtime')]),
    prepareLegacyComponentUpdate: vi.fn(async () => readyEntry('runtime-legacy', 'runtime')),
    backendDiagnostic: (record: unknown) => log.record(record as never),
    backendHttpStatus,
  };
  runInNewContext(ts.transpileModule(functions + '\n' + handlerSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  const admission = new ComponentUpdateAdmission(() => {});
  const updates = new ComponentUpdates(admission, options.discover ?? (() => ctx.prepareComponentUpdates()), () => {}, () => false);
  ctx.componentUpdates = updates;
  return { ctx, handlers, admission, updates };
}

describe('component update orchestration diagnostics', () => {
  it('records one backend plan discovery failure through the actual plan IPC entry, before any install', async () => {
    const files = await gameFixtures(), before = await bytesOf(files);
    const seeded = await seedManagedBackend();
    const backend = manager(forbidden());
    await backend.refresh();
    expect(backend.current).toMatchObject({ available: true, source: 'managed' });
    const { ctx, handlers, admission, updates } = harness({ backend });

    await expect(handlers.get('component-updates-plan')!()).rejects.toThrow('HTTP 403');

    const component = await componentRecords();
    expect(component).toHaveLength(1);
    expect(component[0]).toMatchObject({ operation: 'component-update', event: 'failure', stage: 'plan-discovery', component: 'backend', status: 403 });
    expect(component[0].committed).toBeUndefined();
    expect(await updateRecords()).toEqual([]);
    expect(ctx.prepareManagedComponentUpdates).not.toHaveBeenCalled();
    expect(ctx.launcherUpdater.prepareComponentUpdate).not.toHaveBeenCalled();
    expect(admission.busy).toBe(false);
    expect(updates.current).toEqual({ running: false });
    expect(await fs.readFile(path.join(managed, 'current.json'), 'utf8')).toBe(seeded.pointer);
    expect((await fs.readdir(managed)).filter(name => name.startsWith('.download-'))).toEqual([]);
    await expectBytes(files, before);
  });

  it('records a later component discovery failure without a plan, side effects or retained reservation', async () => {
    const files = await gameFixtures(), before = await bytesOf(files);
    const backendEntry = readyEntry('backend');
    const backendApply = backendEntry.apply;
    const { ctx, handlers, admission, updates } = harness({
      backend: { prepareComponentUpdate: vi.fn(async () => backendEntry) },
      prepareManaged: vi.fn(async () => { throw Error('synthetic runtime discovery failure'); }),
    });

    await expect(handlers.get('component-updates-plan')!()).rejects.toThrow('synthetic runtime discovery failure');

    const component = await componentRecords();
    expect(component).toEqual([expect.objectContaining({ stage: 'plan-discovery', component: 'runtime' })]);
    expect(component[0].status).toBeUndefined();
    expect(backendApply).not.toHaveBeenCalled();
    expect(ctx.launcherUpdater.prepareComponentUpdate).not.toHaveBeenCalled();
    expect(admission.busy).toBe(false);
    expect(updates.current).toEqual({ running: false });
    expect(await updateRecords()).toEqual([]);
    await expectBytes(files, before);
  });

  it('records plan admission rejection once and never touches the other reservation', async () => {
    const discover = vi.fn(async () => [readyEntry('backend')]);
    const { handlers, admission } = harness({ discover });
    const owner = admission.reserve();
    await expect(handlers.get('component-updates-plan')!()).rejects.toThrow('Component updates are in progress.');
    expect(await componentRecords()).toEqual([expect.objectContaining({ stage: 'plan-blocked' })]);
    expect(discover).not.toHaveBeenCalled();
    expect(admission.busy).toBe(true);
    admission.release(owner);
    expect(admission.busy).toBe(false);
    expect(await updateRecords()).toEqual([]);
  });

  it('records apply admission rejection once and keeps the running batch reservation', async () => {
    const entry = readyEntry('backend');
    const { handlers, admission, updates } = harness({ discover: vi.fn(async () => [entry]) });
    const plan = await updates.plan();
    const owner = admission.reserve();
    await expect(handlers.get('component-updates-apply')!({}, plan.id)).rejects.toThrow('Component updates are in progress.');
    expect(await componentRecords()).toEqual([expect.objectContaining({ stage: 'apply-blocked' })]);
    expect(entry.apply).not.toHaveBeenCalled();
    expect(admission.busy).toBe(true);
    admission.release(owner);
    expect(admission.busy).toBe(false);
    expect(await updateRecords()).toEqual([]);
  });

  it('does not duplicate the installer failure, start or exit for a failing backend component', async () => {
    const files = await gameFixtures(), before = await bytesOf(files);
    await seedManagedBackend();
    const backend = manager(forbidden());
    const entry = readyEntry('backend');
    entry.apply = vi.fn(async () => { await backend.update(() => {}); return { committed: true }; });
    const admission = new ComponentUpdateAdmission(() => {});
    const updates = new ComponentUpdates(admission, async () => [entry], () => {}, () => false);

    const plan = await updates.plan();
    const result = await updates.apply(plan.id);

    expect(result.items[0]).toMatchObject({ id: 'backend', outcome: 'failed-before-commit', committed: false });
    expect(await componentRecords()).toEqual([]);
    const update = await updateRecords();
    expect(update.filter(row => row.event === 'start')).toHaveLength(1);
    expect(update.filter(row => row.event === 'failure')).toEqual([expect.objectContaining({ stage: 'update-discovery', committed: false })]);
    expect(update.filter(row => row.event === 'exit')).toEqual([expect.objectContaining({ code: -1 })]);
    expect(admission.busy).toBe(false);
    await expectBytes(files, before);
  });

  it('rejects free-form, unclassified and cross-operation orchestration records', async () => {
    log.record({ operation: 'component-update', event: 'failure', stage: 'plan-discovery', component: 'backend',
      message: 'EACCES /home/synthetic/secret https://example.test/?token=secret-token', path: '/home/synthetic/secret', url: 'https://example.test' } as never);
    log.record({ operation: 'component-update', event: 'failure', stage: 'plan-discovery' } as never);
    log.record({ operation: 'component-update', event: 'failure', stage: 'plan-discovery', component: 'account' } as never);
    log.record({ operation: 'component-update', event: 'failure', stage: 'plan-private', component: 'backend' } as never);
    log.record({ operation: 'component-update', event: 'start', stage: 'plan-blocked' } as never);
    log.record({ operation: 'component-update', event: 'failure', stage: 'plan-blocked' });
    log.record({ operation: 'component-update', event: 'failure', stage: 'apply-blocked', committed: false } as never);
    log.record({ operation: 'component-update', event: 'failure', stage: 'plan-discovery', component: 'runtime', status: 999 } as never);
    log.record({ operation: 'login', event: 'failure', stage: 'plan-discovery', component: 'backend' } as never);
    log.record({ operation: 'component-update', event: 'failure', stage: 'plan-discovery', component: 'launcher', status: 403 });
    const { content } = await log.read();
    const rows = content.trim().split('\n').map(line => JSON.parse(line));
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ stage: 'plan-discovery', component: 'backend' });
    expect(Object.keys(rows[0]).sort()).toEqual(['at', 'backend', 'component', 'event', 'launcher', 'operation', 'source', 'stage']);
    expect(rows[1]).toMatchObject({ stage: 'plan-blocked' });
    expect(rows[1].component).toBeUndefined();
    expect(rows[2]).toMatchObject({ stage: 'apply-blocked' });
    expect(rows[2].committed).toBeUndefined();
    expect(rows[3]).toMatchObject({ stage: 'plan-discovery', component: 'runtime' });
    expect(rows[3].status).toBeUndefined();
    expect(rows[4]).toMatchObject({ stage: 'plan-discovery', component: 'launcher', status: 403 });
    expect(content).not.toMatch(/secret-token|EACCES|home\/synthetic|example\.test|plan-private|"operation":"login"/);
  });
});
