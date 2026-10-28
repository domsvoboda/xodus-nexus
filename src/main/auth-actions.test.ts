import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';

// Exercise the actual main-process actions without Electron, keyring or accounts.
const source = readFileSync('src/main/index.ts', 'utf8');
const actions = transpileModule(source.slice(source.indexOf('async function runAuth('), source.indexOf('\nasync function startInstall(')),
  { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;

function fixture(code = 0) {
  const tracked = { child: {}, result: Promise.resolve({ code, output: '' }) };
  const context = createContext({
    ensureIdle: vi.fn(), requireBackend: vi.fn(() => '/synthetic/backend'), randomUUID: () => 'synthetic',
    accountRefresh: { invalidate: vi.fn() }, accountLibrary: { reset: vi.fn() },
    xboxSocial: { close: vi.fn() },
    nativeSocialBeforeAuth:[],resetNativeSocial:vi.fn(),
    gameActivities: { select: vi.fn() }, gameAchievements: { select: vi.fn() },
    authState: { running: false, stored: true }, emitSnapshot: vi.fn(),
    backend: { current: { capabilities: { externalAuth: true } } },
    prepareSystemWallet: vi.fn(async () => {}), fallbackAuthViewFactory: vi.fn(() => ({})),
    authViewFactory: vi.fn(), browserAuthViewFactory: vi.fn(), mainWindow: undefined,
    shutdownStarted: false, accountProfile: { select: vi.fn(async () => {}) },
    startAuthTransport: vi.fn(() => tracked), spawnTracked: vi.fn(() => tracked),
    emitLog: vi.fn(), operations: new Map(), refreshAccount: vi.fn(async () => {}), authJob: undefined,
    revokeOffline: vi.fn(async () => {}),
  });
  runInContext(actions, context);
  return context;
}

describe('explicit account actions', () => {
  it('fully signs out once with device reset, invalidates caches and refreshes account status', async () => {
    const context = fixture();
    await runInContext("requestAuth('logout')", context);
    expect(context.spawnTracked).toHaveBeenCalledOnce();
    expect(context.spawnTracked).toHaveBeenCalledWith('/synthetic/backend', ['logout', '--device'], expect.any(Object));
    expect(context.startAuthTransport).not.toHaveBeenCalled();
    expect(context.prepareSystemWallet).not.toHaveBeenCalled();
    expect(context.accountLibrary.reset).toHaveBeenCalledOnce();
    expect(context.xboxSocial.close).toHaveBeenCalledOnce();
    expect(context.gameActivities.select).toHaveBeenCalledOnce();
    expect(context.gameAchievements.select).toHaveBeenCalledOnce();
    expect(context.refreshAccount).toHaveBeenCalledWith(false, true);
    expect(context.revokeOffline).toHaveBeenCalledOnce(); expect(context.revokeOffline).toHaveBeenCalledWith('sign-out');
    expect(context.revokeOffline.mock.invocationCallOrder[0]).toBeLessThan(context.refreshAccount.mock.invocationCallOrder[0]);
    expect(context.authState).toMatchObject({ running: false, lastAction: 'logout', lastResult: 'success' });
    expect(context.operations.size).toBe(0);
    expect(context.authJob).toBeUndefined();
  });
  it.each([1, 2])('does not silently retry plain logout or report success after backend exit %s', async code => {
    const context = fixture(code);
    await expect(runInContext("requestAuth('logout')", context)).rejects.toThrow(`exited with code ${code}`);
    expect(context.spawnTracked).toHaveBeenCalledOnce();
    expect(context.spawnTracked).toHaveBeenCalledWith('/synthetic/backend', ['logout', '--device'], expect.any(Object));
    expect(context.refreshAccount).not.toHaveBeenCalled();
    // A failed device reset still drops offline licenses: the user asked to sign out.
    expect(context.revokeOffline).toHaveBeenCalledOnce(); expect(context.revokeOffline).toHaveBeenCalledWith('sign-out');
    expect(context.authState).toMatchObject({ running: false, lastResult: 'failed' });
    expect(context.operations.size).toBe(0);
    expect(context.authJob).toBeUndefined();
  });
  it('keeps Sign in again on the existing transport without resetting device identity', async () => {
    const context = fixture();
    await runInContext("requestAuth('login')", context);
    expect(context.prepareSystemWallet).toHaveBeenCalledOnce();
    expect(context.startAuthTransport).toHaveBeenCalledOnce();
    expect(context.xboxSocial.close).toHaveBeenCalledOnce();
    expect(context.startAuthTransport).toHaveBeenCalledWith('/synthetic/backend', expect.any(Object));
    expect(context.spawnTracked).not.toHaveBeenCalled();
    expect(context.revokeOffline).not.toHaveBeenCalled();
    expect(context.authState).toMatchObject({ running: false, lastAction: 'login', lastResult: 'success' });
  });
  it('rejects sign-out while another operation requires credentials', async () => {
    const context = fixture();
    context.ensureIdle.mockImplementation(() => { throw Error('A game is running.'); });
    await expect(runInContext("requestAuth('logout')", context)).rejects.toThrow('A game is running');
    expect(context.spawnTracked).not.toHaveBeenCalled();
    expect(context.accountLibrary.reset).not.toHaveBeenCalled();
    expect(context.xboxSocial.close).not.toHaveBeenCalled();
    expect(context.authJob).toBeUndefined();
  });
  it('does not spawn logout if the launcher starts closing while account caches clear', async () => {
    const context = fixture();
    context.accountProfile.select.mockImplementation(async () => { context.shutdownStarted = true; });
    await expect(runInContext("requestAuth('logout')", context)).rejects.toThrow('launcher is closing');
    expect(context.spawnTracked).not.toHaveBeenCalled();
    expect(context.authState.running).toBe(false);
    expect(context.authJob).toBeUndefined();
  });
  it('rejects overlapping requests instead of resetting the device twice', async () => {
    const context = fixture();
    let finish!: () => void;
    context.accountProfile.select.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const first = runInContext("requestAuth('logout')", context);
    await vi.waitFor(() => expect(context.accountProfile.select).toHaveBeenCalledOnce());
    await expect(runInContext("requestAuth('logout')", context)).rejects.toThrow('already in progress');
    finish(); await first;
    expect(context.spawnTracked).toHaveBeenCalledOnce();
  });
});
