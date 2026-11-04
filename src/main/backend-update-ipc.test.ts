import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { ComponentUpdateAdmission } from './component-update-admission.js';
import { BackendDiagnostics } from './backend-diagnostics.js';
import { assertActivityCompatible } from './install-queue.js';

// The actual registerIpc handler statements are transpiled and executed, so the
// production gate and its fixed diagnostic record are under test, not a copy.
const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.ES2022, true);
const names = new Set(['ensureIdle', 'ensureActivityIdle']);
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text)).map(node => node.getText(ast)).join('\n');
const register = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'registerIpc') as ts.FunctionDeclaration;
const routes = new Set(['backend-update', 'backend-check-update']);
const handlerSource = register.body!.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(ast) === 'ipcMain.handle' && ts.isStringLiteral(node.expression.arguments[0])
  && routes.has(node.expression.arguments[0].text)).map(node => node.getText(ast)).join('\n');

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-backend-update-ipc-'));
  roots.push(root);
  const log = new BackendDiagnostics(root);
  const handlers = new Map<string, Function>();
  const ctx: any = {
    authState: { running: false }, authJob: undefined, offlinePermissionChanging: false, keyringSupport: { busy: false },
    shutdownStarted: false, downloadCancellations: new Set(), preparingInstall: false, preparingContent: false,
    preparingLaunch: false, finalizingGame: false, checkingGameUpdates: false, gameRemovalInProgress: false,
    gameOperation: undefined, operations: new Map(), installQueue: { size: 0 }, store: { downloads: [] },
    assertActivityCompatible,
    backend: { current: { available: true, updating: false, releaseAvailable: true, updateAvailable: true },
      update: vi.fn(async () => {}), checkUpdate: vi.fn(async () => ({ available: true })) },
    runtime: { busy: false, current: { updating: false } }, launcherUpdater: { busy: false },
    emitSnapshot: vi.fn(), refreshAccount: vi.fn(async () => {}),
    backendDiagnostic: (record: unknown) => log.record(record as never),
    ipcMain: { handle: (name: string, handler: Function) => handlers.set(name, handler) },
  };
  runInNewContext(ts.transpileModule(functions + '\n' + handlerSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  ctx.componentUpdateAdmission = new ComponentUpdateAdmission(() => ctx.ensureActivityIdle());
  return { ctx, handlers, log };
}

async function records(log: BackendDiagnostics) {
  const { content } = await log.read();
  return content.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
}

it('records update-blocked without touching the backend or releasing another reservation', async () => {
  const { ctx, handlers, log } = await fixture();
  const before = structuredClone(ctx.backend.current);
  const owner = ctx.componentUpdateAdmission.reserve();
  await expect(handlers.get('backend-update')!()).rejects.toThrow('Component updates');
  expect(await records(log)).toEqual([expect.objectContaining({ operation: 'update', event: 'failure', stage: 'update-blocked', committed: false })]);
  expect(ctx.backend.update).not.toHaveBeenCalled();
  expect(ctx.backend.current).toEqual(before);
  expect(ctx.componentUpdateAdmission.busy).toBe(true);
  ctx.componentUpdateAdmission.release(owner);
  expect(ctx.componentUpdateAdmission.busy).toBe(false);
});

it('records update-blocked for another active operation and leaves admission free', async () => {
  const { ctx, handlers, log } = await fixture();
  ctx.preparingLaunch = true;
  const before = structuredClone(ctx.backend.current);
  await expect(handlers.get('backend-update')!()).rejects.toThrow('game launch is already being prepared');
  expect(await records(log)).toEqual([expect.objectContaining({ stage: 'update-blocked', committed: false })]);
  expect(ctx.backend.update).not.toHaveBeenCalled();
  expect(ctx.backend.current).toEqual(before);
  expect(ctx.componentUpdateAdmission.busy).toBe(false);
});

it('does not duplicate start or exit records for a normal IPC update call', async () => {
  const { ctx, handlers, log } = await fixture();
  await handlers.get('backend-update')!();
  expect(ctx.backend.update).toHaveBeenCalledTimes(1);
  expect(ctx.refreshAccount).toHaveBeenCalledTimes(1);
  expect(await records(log)).toEqual([]);
});

it('returns the truthful standalone check status and adds no install record', async () => {
  const { ctx, handlers, log } = await fixture();
  const status = { available: true, checking: false, releaseAvailable: false, updateAvailable: false, blockReason: 'Backend release check failed: Backend download failed (HTTP 403).' };
  ctx.backend.checkUpdate.mockResolvedValueOnce(status);
  expect(await handlers.get('backend-check-update')!()).toEqual(status);
  expect(ctx.emitSnapshot).toHaveBeenCalledTimes(1);
  expect(await records(log)).toEqual([]);
});
