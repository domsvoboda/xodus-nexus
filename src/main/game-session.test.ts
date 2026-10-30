import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BackendStatus, Game, GameOperation, RuntimeStatus } from '../shared/types.js';

const h = vi.hoisted(() => ({
  inspected: {} as Partial<Game>,
  spawnCalls: [] as { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string }[],
  finish: undefined as ((result: { code: number | null; output: string }) => void) | undefined,
  cleanup: vi.fn(async () => {}),
  wrapperCleanup: vi.fn(async () => {}),
  serviceRelease: vi.fn(async () => {}),
  acquire: vi.fn(),
  cloud: false,
  unbridged: false,
  offlineRuntime: true,
  inviteRuntime: false,
  discovery: false,
  proton: undefined as undefined | { command: string; compatibilityDataPath: string; stopPrefix: { command: string; args: string[] } },
  localeSync: vi.fn(async () => {}),
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
  offlineIdentityRuntime: async () => h.offlineRuntime,
  storeDiscoveryRuntime: async () => h.discovery,
  gameInviteRuntime: async () => h.inviteRuntime,
}));
vi.mock('./game-locale.js', async (original) => ({ ...await original<typeof import('./game-locale.js')>(), installedGameTitleId: async () => '6a1b2c3d' }));
vi.mock('./vc-runtime.js', () => ({ installedVcRuntimeVersion: async () => '14.40.0.0', VC_REDIST_VERSION: '14.40.0.0', versionAtLeast: () => true }));
vi.mock('./game-wrapper.js', () => ({ prepareGameWrapper: async (wine: string) => ({ command: wine, cleanup: h.wrapperCleanup }) }));
vi.mock('./install-queue.js', () => ({ canonicalInstallPath: async (p: string) => p, installPathsOverlap: (a: string, b: string) => a === b }));
vi.mock('./game-process.js', () => ({
  spawnGameProcess: async (command: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd?: string }) => {
    h.spawnCalls.push({ command, args, env: options.env, cwd: options.cwd });
    const result = new Promise<{ code: number | null; output: string }>((resolve) => { h.finish = resolve; });
    return { child: { pid: 4242 }, result, stop: async () => {}, forceStop: async () => {}, cleanup: h.cleanup };
  },
}));

import { GameSession, type GameSessionDeps } from './game-session.js';
import { LINUX_RUN_PATCH } from './backend.js';
import { INCOMPLETE_UPDATE_MESSAGE } from './installation-state.js';

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
    environment: () => ({ PATH: '/usr/bin', STEAM_VAR: 'kept', XODUS_FORCE_OFFLINE: '1', XODUS_OFFLINE_IDENTITY: 'use', NEXUS_INVITE_PORT: '1' }),
    connectivity: { check: async () => ({ state: 'online' as const }) },
    account: () => ({ stored: true, username: 'player@example.com' }),
    ensureWallet: async () => { walletCalls++; },
    displayGuard: () => { released--; return () => { released++; }; },
    services: { acquire: h.acquire },
    persistGame: async (id, patch) => { persisted.push({ id, patch }); },
    licenseCache: async () => path.join(root, 'data', 'license-cache'),
    content: () => ({ roots: async () => [] }),
    onChange: (operation, operationId, immediate) => changes.push({ operation, operationId, immediate }),
    ...overrides,
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-game-session-'));
  await fs.mkdir(path.join(root, 'game'));
  await fs.writeFile(path.join(root, 'wine'), '#!/bin/sh\n', { mode: 0o755 });
  changes = []; released = 0; persisted = []; walletCalls = 0;
  h.spawnCalls = []; h.inspected = {}; h.cloud = false; h.unbridged = false; h.offlineRuntime = true; h.inviteRuntime = false; h.discovery = false; h.proton = undefined;
  h.cleanup.mockClear(); h.wrapperCleanup.mockClear(); h.serviceRelease.mockClear(); h.localeSync.mockClear();
  h.acquire.mockReset();
  h.acquire.mockImplementation(async () => ({ socketPath: '/run/x/xodus.sock', bridgePort: 4321, bridgeKey: 'k'.repeat(64), stop: async () => {}, release: h.serviceRelease }));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('GameSession', () => {
  it('prepares, spawns with the composed environment and cleans up after exit', async () => {
    h.cloud = true;
    const attached: { id: string; pid: number | undefined }[] = [];
    let detached = 0;
    const session = new GameSession(deps({ attachGame: (game, pid) => { attached.push({ id: game.id, pid }); return () => { detached++; }; } }));
    const active = await session.launch('g');
    expect(persisted).toEqual([{ id: 'g', patch: expect.objectContaining({ installState: 'ready', executable: 'Game.exe' }) }]);
    expect(walletCalls).toBe(1);
    expect(h.spawnCalls).toHaveLength(1);
    const [spawned] = h.spawnCalls;
    expect(spawned.command).toBe(backend.binaryPath);
    expect(spawned.args.slice(0, 2)).toEqual(['run', path.join(root, 'game')]);
    expect(spawned.args).toContain('--license-cache');
    expect(spawned.args).toContain(path.join(root, 'data', 'license-cache'));
    expect(spawned.args).not.toContain('--offline');
    expect(spawned.env).toMatchObject({ STEAM_VAR: 'kept', XODUS_SOCKET: '/run/x/xodus.sock', XODUS_BRIDGE_PORT: '4321', XODUS_BRIDGE_KEY: 'k'.repeat(64), XODUS_SAVE_SYNC: 'auto' });
    expect(spawned.env.XODUS_ACCOUNT_HASH).toMatch(/^[0-9a-f]+$/);
    // A shell's stale offline mode and invitation endpoint never reach the game.
    expect(spawned.env.XODUS_FORCE_OFFLINE).toBeUndefined();
    expect(spawned.env.XODUS_OFFLINE_IDENTITY).toBeUndefined();
    expect(spawned.env.NEXUS_INVITE_PORT).toBeUndefined();
    expect(spawned.env.XODUS_NEXUS_LAUNCH_ID).toBe('game-g');
    expect(attached).toEqual([{ id: 'g', pid: 4242 }]);
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
    expect(detached).toBe(1);
    expect(session.running).toBeUndefined();
    const log = await vi.waitFor(() => fs.readFile(active.operation.logPath!, 'utf8'));
    expect(log).toContain('Game: Sample');
    expect(log).toContain('cloud saves: enabled');
    expect(log).toContain('exited with code 0');
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

  it('refuses an offline launch without an offline-capable runtime and passes no license cache to it online', async () => {
    h.offlineRuntime = false;
    const licenseCache = vi.fn(async () => '/cache');
    await expect(new GameSession(deps({ licenseCache, connectivity: { check: async () => ({ state: 'offline' }) } })).launch('g')).rejects.toThrow('Offline play requires a compatible Nexus backend and runtime');
    const active = await new GameSession(deps({ licenseCache })).launch('g');
    expect(h.spawnCalls[0].args).not.toContain('--license-cache');
    expect(licenseCache).not.toHaveBeenCalled();
    h.finish!({ code: 0, output: '' });
    await active.finished;
  });

  it('refuses to play an interrupted update before inspecting the installation', async () => {
    const session = new GameSession(deps({ incompleteUpdate: async () => true }));
    await expect(session.launch('g')).rejects.toThrow(INCOMPLETE_UPDATE_MESSAGE);
    expect(persisted).toEqual([]);
    expect(h.spawnCalls).toHaveLength(0);
  });

  it('reports a failed exit with the backend tail and marks a stopped game complete', async () => {
    const session = new GameSession(deps());
    const active = await session.launch('g');
    h.finish!({ code: 3, output: 'line one\nfatal: boom\n' });
    await active.finished;
    expect(active.operation.status).toBe('failed');
    expect(active.operation.error).toBe('Xodus run exited with code 3: line one | fatal: boom');

    const stopped = await new GameSession(deps()).launch('g');
    stopped.operation.status = 'stopping';
    h.finish!({ code: 130, output: '' });
    await stopped.finished;
    expect(stopped.operation.status).toBe('complete');
    expect(stopped.operation.phase).toContain('Forced shutdown may leave unsynchronized saves');
  });

  it('starts the invitation bridge, adds DLC hints and reports why invitations are unavailable', async () => {
    h.inviteRuntime = true; h.discovery = true;
    const reasons: (string | undefined)[] = [];
    const stop = vi.fn(async () => {});
    const inviteBridge = vi.fn(async () => ({ port: 5150, key: 'invite-key', stop }));
    const session = new GameSession(deps({
      inviteBridge,
      onInviteAvailability: reason => reasons.push(reason),
      content: () => ({ roots: async () => ['/data/content/dlc'], relatedProducts: async () => ['9NBLGGH4R315', '9P1J8S7CCWWT'] }),
    }));
    const active = await session.launch('g');
    expect(inviteBridge).toHaveBeenCalledWith('game-g', expect.objectContaining({ id: 'g' }), String(0x6a1b2c3d), expect.any(Function));
    expect(h.spawnCalls[0].env).toMatchObject({ NEXUS_INVITE_PORT: '5150', NEXUS_INVITE_KEY: 'invite-key', NEXUS_RELATED_PRODUCT_IDS: '9NBLGGH4R315,9P1J8S7CCWWT', XODUS_CONTENT_ROOTS: 'Z:\\data\\content\\dlc' });
    expect(reasons).toEqual([undefined, undefined]);
    h.finish!({ code: 0, output: '' });
    await active.finished;
    expect(stop).toHaveBeenCalledTimes(1);

    h.inviteRuntime = false;
    const without = await new GameSession(deps({ onInviteAvailability: reason => reasons.push(reason) })).launch('g');
    expect(reasons.at(-1)).toContain('does not support game invitations');
    h.finish!({ code: 0, output: '' });
    await without.finished;

    h.inviteRuntime = true;
    const failing = await new GameSession(deps({ inviteBridge: async () => { throw new Error('port in use'); }, onInviteAvailability: reason => reasons.push(reason) })).launch('g');
    expect(reasons.at(-1)).toContain('could not be started');
    expect(h.spawnCalls.at(-1)!.env.NEXUS_INVITE_PORT).toBeUndefined();
    h.finish!({ code: 0, output: '' });
    await failing.finished;
  });

  it('ties the game window to its artwork and still launches when the identity fails', async () => {
    h.inspected = { coverDataUrl: 'data:image/png;base64,AA==' };
    const windowIdentity = vi.fn(async () => 'xodus-nexus-game-profile-g');
    const active = await new GameSession(deps({ windowIdentity, environment: () => ({ PATH: '/usr/bin', WINE_APPLICATION_ID: 'stale' }) })).launch('g');
    expect(windowIdentity).toHaveBeenCalledWith(expect.objectContaining({ id: 'g', installState: 'ready' }), 'data:image/png;base64,AA==');
    expect(h.spawnCalls[0].env.WINE_APPLICATION_ID).toBe('xodus-nexus-game-profile-g');
    h.finish!({ code: 0, output: '' });
    await active.finished;

    const failing = await new GameSession(deps({ windowIdentity: async () => { throw new Error('no icon'); } })).launch('g');
    expect(h.spawnCalls[1].env.WINE_APPLICATION_ID).toBeUndefined();
    expect(failing.operation.log).toContain('Game window icon unavailable.');
    h.finish!({ code: 0, output: '' });
    await failing.finished;
  });

  it('releases the service, wrapper and display when preparation fails after the service started', async () => {
    h.cloud = true;
    const session = new GameSession(deps({ account: (() => {
      // The first read binds offline data before preparation; fail the one after the service started.
      let reads = 0;
      return () => { if (++reads > 1) throw new Error('account unavailable'); return { stored: null }; };
    })() }));
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

  it('blocks play while the game is still downloading', async () => {
    const busy = deps();
    busy.store = { ...busy.store, downloads: [{ id: 'd', gameId: 'g', status: 'running', destination: path.join(root, 'elsewhere') } as never] };
    await expect(new GameSession(busy).launch('g')).rejects.toThrow('Finish or cancel this game');
    expect(h.spawnCalls).toHaveLength(0);
  });

  it('uses the prepared Proton runner and syncs the prefix locale', async () => {
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
