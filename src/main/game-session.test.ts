import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BackendStatus, Game, GameOperation, RuntimeStatus } from '../shared/types.js';

const h = vi.hoisted(() => ({
  inspected: {} as Partial<Game>,
  spawnCalls: [] as { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string }[],
  finish: undefined as ((result: { code: number | null; output: string }) => void) | undefined,
  fail: undefined as ((error: Error) => void) | undefined,
  stop: vi.fn(async () => {}),
  forceStop: vi.fn(async () => {}),
  cleanup: vi.fn(async () => {}),
  wrapperCleanup: vi.fn(async () => {}),
  serviceRelease: vi.fn(async () => {}),
  acquire: vi.fn(),
  cloud: false,
  unbridged: false,
  proton: undefined as undefined | { command: string; compatibilityDataPath: string; stopPrefix: { command: string; args: string[] } },
  localeSync: vi.fn(async () => {}),
  licenseRefresh: vi.fn(async () => undefined),
}));

vi.mock('./store.js', () => ({ inspectGameDirectory: async (directory: string) => ({ id: 'g', path: directory, title: 'Sample', installState: 'ready', executable: 'Game.exe', ...h.inspected }) }));
vi.mock('./proton.js', () => ({
  prepareProtonRunner: async () => h.proton,
  syncPrefixUserLocale: (...args: unknown[]) => h.localeSync(...args as []),
  syncUnrealCultureGameIni: async () => {},
}));
vi.mock('./xodus-service.js', () => ({
  selectedWinePath: (configured: string) => configured,
  cloudSaveRuntime: async () => h.cloud,
  unbridgedCloudSaveRuntime: async () => h.unbridged,
}));
vi.mock('./vc-runtime.js', () => ({ installedVcRuntimeVersion: async () => '14.40.0.0', VC_REDIST_VERSION: '14.40.0.0', versionAtLeast: () => true }));
vi.mock('./game-wrapper.js', () => ({ prepareGameWrapper: async (wine: string) => ({ command: wine, cleanup: h.wrapperCleanup }) }));
vi.mock('./game-content.js', () => ({ GameContent: class { async roots() { return []; } } }));
vi.mock('./license-refresh.js', () => ({ refreshOfflineLicenses: (...args: unknown[]) => h.licenseRefresh(...args as []) }));
vi.mock('./install-queue.js', () => ({ canonicalInstallPath: async (p: string) => p, installPathsOverlap: (a: string, b: string) => a === b }));
vi.mock('./game-process.js', () => ({
  spawnGameProcess: async (command: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd?: string }) => {
    h.spawnCalls.push({ command, args, env: options.env, cwd: options.cwd });
    const result = new Promise<{ code: number | null; output: string }>((resolve, reject) => { h.finish = resolve; h.fail = reject; });
    return { child: { pid: 4242 }, result, stop: h.stop, forceStop: h.forceStop, cleanup: h.cleanup };
  },
}));

import { FORCE_STOP_DELAY_MS, GameSession, licenseCacheDirectory, type GameSessionDeps } from './game-session.js';
import { LINUX_RUN_PATCH } from './backend.js';

const backend: BackendStatus = {
  available: true, binaryPath: '/opt/backend/xodus-cli', linuxRunPatch: LINUX_RUN_PATCH, updating: false,
  capabilities: { licenseCache: true, offlineLaunch: true, run: true } as BackendStatus['capabilities'],
} as BackendStatus;
const runtime = { winePath: '/opt/runtime/wine', updating: false } as RuntimeStatus;

let root: string;
let changes: { operation: GameOperation | undefined; operationId: string; immediate: boolean }[];
let released: number;
let persisted: { id: string; patch: Partial<Game> }[];
let walletCalls: number;

function deps(overrides: Partial<GameSessionDeps> = {}): GameSessionDeps {
  const game: Game = { id: 'g', path: path.join(root, 'game'), title: 'Sample', installState: 'ready', executable: 'Game.exe' } as Game;
  return {
    store: { games: [game], downloads: [], settings: { winePath: path.join(root, 'wine'), runtimeRoot: path.join(root, 'data', 'runtime'), market: 'US' } },
    backend: () => backend,
    runtime: () => runtime,
    requireBackend: () => backend.binaryPath!,
    paths: { userData: path.join(root, 'userData'), home: path.join(root, 'home') },
    environment: () => ({ PATH: '/usr/bin', STEAM_VAR: 'kept' }),
    connectivity: { check: async () => ({ state: 'online' as const }) },
    account: () => ({ stored: true, username: 'player@example.com' }),
    ensureWallet: async () => { walletCalls++; },
    displayGuard: () => { released--; return () => { released++; }; },
    services: { acquire: h.acquire },
    persistGame: async (id, patch) => { persisted.push({ id, patch }); },
    onChange: (operation, operationId, immediate) => changes.push({ operation, operationId, immediate }),
    ...overrides,
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-game-session-'));
  await fs.mkdir(path.join(root, 'game'));
  await fs.writeFile(path.join(root, 'wine'), '#!/bin/sh\n', { mode: 0o755 });
  changes = []; released = 0; persisted = []; walletCalls = 0;
  h.spawnCalls = []; h.inspected = {}; h.cloud = false; h.unbridged = false; h.proton = undefined;
  h.stop.mockClear(); h.forceStop.mockClear(); h.cleanup.mockClear(); h.wrapperCleanup.mockClear(); h.serviceRelease.mockClear(); h.localeSync.mockClear(); h.licenseRefresh.mockClear();
  h.acquire.mockReset();
  h.acquire.mockImplementation(async () => ({ socketPath: '/run/x/xodus.sock', bridgePort: 4321, bridgeKey: 'k'.repeat(64), stop: async () => {}, release: h.serviceRelease }));
});
afterEach(async () => { vi.useRealTimers(); await fs.rm(root, { recursive: true, force: true }); });

describe('GameSession', () => {
  it('prepares, spawns with the composed environment and cleans up after exit', async () => {
    h.cloud = true;
    const session = new GameSession(deps());
    const active = await session.launch('g');
    expect(persisted).toEqual([{ id: 'g', patch: expect.objectContaining({ installState: 'ready', executable: 'Game.exe' }) }]);
    expect(walletCalls).toBe(1);
    expect(h.spawnCalls).toHaveLength(1);
    const [spawned] = h.spawnCalls;
    expect(spawned.command).toBe(backend.binaryPath);
    expect(spawned.args.slice(0, 2)).toEqual(['run', path.join(root, 'game')]);
    expect(spawned.args).toContain('--license-cache');
    expect(spawned.args).toContain(licenseCacheDirectory(path.join(root, 'data')));
    expect(spawned.args).not.toContain('--offline');
    expect(spawned.env).toMatchObject({ STEAM_VAR: 'kept', XODUS_SOCKET: '/run/x/xodus.sock', XODUS_BRIDGE_PORT: '4321', XODUS_BRIDGE_KEY: 'k'.repeat(64), XODUS_SAVE_SYNC: 'auto' });
    expect(spawned.env.XODUS_ACCOUNT_HASH).toMatch(/^[0-9a-f]+$/);
    expect(spawned.env.XODUS_FORCE_OFFLINE).toBeUndefined();
    expect(active.operation.status).toBe('running');
    expect(session.current).toBe(active.operation);
    expect(session.running).toBe(active);
    expect(released).toBe(-1);
    expect(changes.filter(change => change.immediate && change.operation === active.operation).length).toBeGreaterThanOrEqual(2);
    h.finish!({ code: 0, output: '' });
    await active.finished;
    expect(active.operation.status).toBe('complete');
    expect(active.operation.phase).toBe('The game has exited.');
    expect(active.operation.finishedAt).toBeDefined();
    expect(h.serviceRelease).toHaveBeenCalledTimes(1);
    expect(h.cleanup).toHaveBeenCalledTimes(1);
    expect(h.wrapperCleanup).toHaveBeenCalledTimes(1);
    expect(released).toBe(0);
    expect(session.running).toBeUndefined();
    const log = await vi.waitFor(() => fs.readFile(active.operation.logPath!, 'utf8'));
    expect(log).toContain('Game: Sample');
    expect(log).toContain('cloud saves: enabled');
    expect(log).toContain('exited with code 0');
  });

  it('renews the stored offline licenses after an online session only when the backend can', async () => {
    const refreshing = { ...backend, capabilities: { ...backend.capabilities, licenseRefresh: true } } as BackendStatus;
    const online = await new GameSession(deps({ backend: () => refreshing })).launch('g');
    expect(h.licenseRefresh).not.toHaveBeenCalled();
    h.finish!({ code: 0, output: '' });
    await online.finished;
    await vi.waitFor(() => expect(h.licenseRefresh).toHaveBeenCalledTimes(1));
    expect(h.licenseRefresh.mock.calls[0]).toEqual([backend.binaryPath, licenseCacheDirectory(path.join(root, 'data')), expect.any(Function)]);

    const offline = await new GameSession(deps({ backend: () => refreshing, connectivity: { check: async () => ({ state: 'offline' }) } })).launch('g');
    h.finish!({ code: 0, output: '' });
    await offline.finished;
    const older = await new GameSession(deps()).launch('g');
    h.finish!({ code: 0, output: '' });
    await older.finished;
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(h.licenseRefresh).toHaveBeenCalledTimes(1);
  });

  it('launches offline with the forced-offline runtime flag when Microsoft is unreachable', async () => {
    const session = new GameSession(deps({ connectivity: { check: async () => ({ state: 'offline', reason: 'No network interface is connected.' }) } }));
    const active = await session.launch('g');
    const [spawned] = h.spawnCalls;
    expect(spawned.args).toContain('--offline');
    expect(spawned.env.XODUS_FORCE_OFFLINE).toBe('1');
    expect(spawned.env.XODUS_SOCKET).toBeUndefined();
    expect(h.acquire).not.toHaveBeenCalled();
    expect(active.operation.log.some(line => line.includes('launching offline'))).toBe(true);
    h.finish!({ code: 0, output: '' });
    await active.finished;
  });

  it('reports a failed exit with the backend tail and marks a stopped game complete', async () => {
    const session = new GameSession(deps());
    const active = await session.launch('g');
    h.finish!({ code: 3, output: 'line one\nfatal: boom\n' });
    await active.finished;
    expect(active.operation.status).toBe('failed');
    expect(active.operation.error).toBe('Xodus run exited with code 3: line one | fatal: boom');

    const second = new GameSession(deps());
    const stopped = await second.launch('g');
    await second.cancel();
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(stopped.operation.status).toBe('stopping');
    h.finish!({ code: 130, output: '' });
    await stopped.finished;
    expect(stopped.operation.status).toBe('complete');
    expect(stopped.operation.phase).toContain('Forced shutdown may leave unsynchronized saves');
  });

  it('force-stops a game that ignores the stop request and never after it exited', async () => {
    vi.useFakeTimers();
    const session = new GameSession(deps());
    const active = await session.launch('g');
    await session.cancel();
    await vi.advanceTimersByTimeAsync(FORCE_STOP_DELAY_MS - 1);
    expect(h.forceStop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.forceStop).toHaveBeenCalledTimes(1);
    h.finish!({ code: 137, output: '' });
    await active.finished;

    const quick = new GameSession(deps());
    const exited = await quick.launch('g');
    await quick.cancel();
    h.finish!({ code: 0, output: '' });
    await exited.finished;
    await vi.advanceTimersByTimeAsync(FORCE_STOP_DELAY_MS + 1);
    expect(h.forceStop).toHaveBeenCalledTimes(1);
  });

  it('refuses to cancel before the process exists and restores running when the stop fails', async () => {
    const session = new GameSession(deps());
    await expect(session.cancel()).rejects.toThrow('No game launch is currently active.');
    const active = await session.launch('g');
    h.stop.mockRejectedValueOnce(new Error('kill failed'));
    await expect(session.cancel()).rejects.toThrow('kill failed');
    expect(active.operation.status).toBe('running');
    h.finish!({ code: 0, output: '' });
    await active.finished;
  });

  it('releases the service, wrapper and display when preparation fails after the service started', async () => {
    h.cloud = true;
    const session = new GameSession(deps({ account: () => { throw new Error('account unavailable'); } }));
    await expect(session.launch('g')).rejects.toThrow('account unavailable');
    expect(h.serviceRelease).toHaveBeenCalledTimes(1);
    expect(h.wrapperCleanup).toHaveBeenCalledTimes(1);
    expect(h.spawnCalls).toHaveLength(0);
    expect(released).toBe(0);
    expect(session.current).toBeUndefined();
    expect(session.running).toBeUndefined();
    const last = changes.at(-1)!;
    expect(last.operation).toBeUndefined();
    expect(last.operationId).toBe('game-g');
    await vi.waitFor(async () => expect(await fs.readFile(path.join(root, 'data', 'logs', 'g-latest.log'), 'utf8')).toContain('Preparation error: account unavailable'));
  });

  it('rejects unready installs, missing wine and unbridged cloud runtimes before any side effect', async () => {
    h.inspected = { installState: 'missing', installMessage: 'Game.exe is missing.' };
    await expect(new GameSession(deps()).launch('g')).rejects.toThrow('Game.exe is missing.');
    h.inspected = {};
    await expect(new GameSession(deps()).launch('missing')).rejects.toThrow('Game not found.');
    const absentWine = deps(); absentWine.store.settings.winePath = path.join(root, 'nowhere');
    await expect(new GameSession(absentWine).launch('g')).rejects.toThrow('The selected Wine runtime is unavailable');
    h.unbridged = true;
    await expect(new GameSession(deps()).launch('g')).rejects.toThrow('without the required service bridge');
    expect(walletCalls).toBe(0);
    expect(h.spawnCalls).toHaveLength(0);
  });

  it('blocks play while the game is still downloading and works without a persistence hook', async () => {
    const busy = deps();
    busy.store = { ...busy.store, downloads: [{ id: 'd', gameId: 'g', status: 'running', destination: path.join(root, 'elsewhere') } as never] };
    await expect(new GameSession(busy).launch('g')).rejects.toThrow('Finish or cancel this game');
    const session = new GameSession(deps({ persistGame: undefined }));
    const active = await session.launch('g');
    expect(persisted).toEqual([]);
    h.finish!({ code: 0, output: '' });
    await active.finished;
  });

  it('uses the prepared Proton runner, syncs the prefix locale and forwards the prefix stop control', async () => {
    h.proton = { command: path.join(root, 'runner'), compatibilityDataPath: path.join(root, 'data', 'compatdata', 'g'), stopPrefix: { command: path.join(root, 'runner'), args: ['--nexus-stop-prefix'] } };
    const withLocale = deps();
    withLocale.store.games[0].locale = 'de-DE';
    await fs.writeFile(path.join(root, 'game', 'MicrosoftGame.config'), '<Game><Resources><Resource Language="de-DE"/><Resource Language="en-US"/></Resources></Game>');
    const session = new GameSession(withLocale);
    const active = await session.launch('g');
    const [spawned] = h.spawnCalls;
    expect(spawned.args[2]).toBe(path.join(root, 'runner'));
    expect(spawned.env.WINEPREFIX).toBeUndefined();
    expect(h.localeSync).toHaveBeenCalledTimes(1);
    expect(h.localeSync.mock.calls[0][1]).toBe(path.join(root, 'data', 'compatdata', 'g', 'pfx'));
    expect(active.operation.log.some(line => line.includes('Proton prefix:'))).toBe(true);
    h.finish!({ code: 0, output: '' });
    await active.finished;
  });
});
