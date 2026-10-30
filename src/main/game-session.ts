import { constants, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { BackendStatus, ConnectivityStatus, DownloadTask, Game, GameOperation, RuntimeStatus } from '../shared/types.js';
import { inspectGameDirectory } from './store.js';
import { prepareProtonRunner, syncPrefixUserLocale, syncUnrealCultureGameIni } from './proton.js';
import { accountCacheKey } from './offline-identity.js';
import { bindOfflineAccess, type OfflineRevocation } from './offline-access.js';
import { cloudSaveRuntime, gameInviteRuntime, offlineIdentityRuntime, selectedWinePath, storeDiscoveryRuntime, unbridgedCloudSaveRuntime } from './xodus-service.js';
import { GameLogReducer, gameLoggingEnvironment, gameWindowEnvironment } from './game-log.js';
import { installedVcRuntimeVersion, VC_REDIST_VERSION, versionAtLeast } from './vc-runtime.js';
import { spawnGameProcess, type GameProcess } from './game-process.js';
import { gameLocaleEnvironment, installedGameLocales, installedGameTitleId, supportedGameLocale } from './game-locale.js';
import { antiCheatEnvironment } from './anti-cheat.js';
import { gameLaunchArguments, preparedGameWine } from './game-launch.js';
import { prepareGameWrapper, type GameWrapper } from './game-wrapper.js';
import { canonicalInstallPath, installPathsOverlap } from './install-queue.js';
import { INCOMPLETE_UPDATE_MESSAGE } from './installation-state.js';
import { contentLicenseFailure } from '../shared/content-license.js';
import type { AcquiredService, ServiceSessions } from './service-sessions.js';

export async function gameLocales(game: Game): Promise<string[]> {
  return installedGameLocales(game.path);
}

export async function gameTitleId(game: Game): Promise<string | undefined> {
  return installedGameTitleId(game.path);
}

/** The state a launch reads; writes go through `persistGame`. */
export interface GameSessionStore {
  readonly games: Game[];
  readonly downloads: DownloadTask[];
  readonly settings: { winePath: string; runtimeRoot: string; market: string; verboseLogs?: boolean; shaderCacheLimitGiB?: number };
}

/** A started game invitation bridge (`GameInviteBridge`), as the runtime reaches it. */
export interface InviteBridgeHandle {
  port: number;
  key: string;
  stop(): Promise<void>;
}

/** Managed DLC and content of the data root, as a launch reads it. */
export interface LaunchContent {
  roots(game: Game): Promise<string[]>;
  relatedProducts?(game: Game): Promise<string[]>;
}

/**
 * Everything a launch needs from the process that hosts it: the launcher's
 * store, windows, wallet prompt and Friends UI. Kept separate so the launch
 * itself can be tested without Electron.
 */
export interface GameSessionDeps {
  store: GameSessionStore;
  backend(): BackendStatus;
  runtime(): RuntimeStatus;
  /** Resolves the `xodus-cli` path once the backend advertises `command`, else throws. */
  requireBackend(command: 'run'): string;
  paths: { userData: string; home: string };
  /** Base environment for the game. */
  environment(): NodeJS.ProcessEnv;
  connectivity?: { check(): Promise<ConnectivityStatus> };
  account(): { stored: boolean | null; username?: string };
  /** Game Mode wallet readiness. */
  ensureWallet(): Promise<void>;
  /** Holds the display awake while the game runs; returns the release. */
  displayGuard(): () => void;
  services: ServiceSessions;
  /** True (after recording it) when an interrupted update must be resumed first. */
  incompleteUpdate?(game: Game): Promise<boolean>;
  /** Stores inspection results. */
  persistGame?(id: string, patch: Partial<Game>): Promise<unknown>;
  /** The license cache to pass the backend once offline access is confirmed ready; undefined without one. */
  licenseCache(): Promise<string | undefined>;
  /** Managed DLC/content for the data root. */
  /** Called once the launch knows whether it is offline, early enough to load owned access meanwhile. */
  content(dataRoot: string, offline: boolean): LaunchContent;
  /** Starts the game's invitation bridge; absent where there is no Friends UI to accept them. */
  inviteBridge?(operationId: string, game: Game, titleId: string, log: (line: string) => void): Promise<InviteBridgeHandle>;
  /** Why invitations are unavailable for this launch, or undefined once they may work. */
  onInviteAvailability?(reason: string | undefined): void;
  /** The window identity (`WINE_APPLICATION_ID`) tying the game window to its installed artwork; undefined where there is none. */
  windowIdentity?(game: Game, coverDataUrl: string | undefined): Promise<string | undefined>;
  /** The game process started; returns the matching detach for its exit. */
  attachGame?(game: Game, pid: number | undefined): () => void;
  /** `operation` is the live object (mutated in place) or undefined once a failed preparation is cleared. */
  onChange(operation: GameOperation | undefined, operationId: string, immediate: boolean): void;
  /** Stored offline data was removed before the launch, e.g. another account left it behind. */
  onOfflineRevoked?(reason: OfflineRevocation): void;
  /** Every reduced log line, in order, for hosts that stream them to a remote client. */
  onLog?(operationId: string, line: string): void;
  /** Route the game's output through a file next to its log, so it survives this host restarting (daemon). */
  outputToFile?: boolean;
}

export interface ActiveGame {
  operationId: string;
  gameId: string;
  operation: GameOperation;
  process: GameProcess;
  service?: AcquiredService;
  /** The prefix stop control of the prepared Proton runner, for a daemon that re-adopts the game after a restart. */
  stopPrefix?: { command: string; args: string[] };
  /** The file the game writes its output to, when `outputToFile` is set. */
  outputFile?: string;
  /** The backend process result, as `GameProcess.result`. */
  result: GameProcess['result'];
  /** Settles after the service, process group, wrapper and log are all cleaned up. */
  finished: Promise<void>;
}

/** One game at a time: preparation, spawn and cleanup, independent of Electron. */
const STEAM_PRELOAD_NOISE = /^ERROR: ld\.so: object '[^']*gameoverlayrenderer\.so' from LD_PRELOAD cannot be preloaded/;

export class GameSession {
  private active: ActiveGame | undefined;
  private operation: GameOperation | undefined;

  constructor(private readonly deps: GameSessionDeps) {}

  /** The launch operation this session last created (complete ones included). */
  get current(): GameOperation | undefined { return this.operation; }

  /** The game currently running, if any. */
  get running(): ActiveGame | undefined { return this.active; }

  async launch(id: string): Promise<ActiveGame> {
    const { deps } = this;
    const { store } = deps;
    const game = store.games.find((entry) => entry.id === id);
    if (!game) throw new Error('Game not found.');
    const target = await canonicalInstallPath(game.path);
    for (const task of store.downloads.filter(task => ['running', 'queued', 'paused'].includes(task.status))) {
      if (task.gameId === id || installPathsOverlap(target, await canonicalInstallPath(task.destination))) throw Error('Finish or cancel this game\'s installation before playing it.');
    }
    if (await deps.incompleteUpdate?.(game)) throw Error(INCOMPLETE_UPDATE_MESSAGE);
    const inspected = await inspectGameDirectory(game.path);
    await deps.persistGame?.(id, {
      installState: inspected.installState,
      installMessage: inspected.installMessage,
      updateIncomplete: inspected.updateIncomplete,
      executable: inspected.executable,
      antiCheat: inspected.antiCheat,
      vcRedistEncrypted: inspected.vcRedistEncrypted,
      coverDataUrl: inspected.coverDataUrl,
      storeId: inspected.storeId ?? game.storeId,
    });
    const binary = deps.requireBackend('run');
    if (inspected.installState !== 'ready') throw new Error(inspected.installMessage ?? 'The installation is not ready for Xodus run.');
    const locale = supportedGameLocale(game.locale ?? '');
    const titleId = await gameTitleId(game).catch(() => undefined);
    const backend = deps.backend();
    const wine = selectedWinePath(store.settings.winePath, store.settings.runtimeRoot, deps.runtime().winePath);
    if (!wine) throw new Error('Select a Wine / Proton binary in Settings.');
    try { await fs.access(wine, constants.X_OK); }
    catch { throw new Error(`The selected Wine runtime is unavailable: ${wine}. Select or reinstall Xodus Runtime in Settings.`); }
    const cloudRuntime = await cloudSaveRuntime(wine);
    if (await unbridgedCloudSaveRuntime(wine)) {
      throw new Error('The active runtime has cloud saves without the required service bridge. Update the active runtime in Settings.');
    }
    const dataRoot = path.dirname(store.settings.runtimeRoot);
    // Decide "offline" here, once, from a fresh probe: the backend then skips
    // its ticket, license and PlayFab requests and the runtime signs in from
    // its cached identity, instead of each waiting for its own connect timeout.
    const reachability: ConnectivityStatus = deps.connectivity ? await deps.connectivity.check() : { state: 'unknown' };
    const offlineLaunch = reachability.state === 'offline';
    const content = deps.content(dataRoot, offlineLaunch);
    const owner = deps.account();
    if (owner.stored === true && owner.username && await bindOfflineAccess(dataRoot, owner.username)) deps.onOfflineRevoked?.('account-changed');
    const offlineRuntime = await offlineIdentityRuntime(wine);
    if (offlineLaunch && (!offlineRuntime || !backend.capabilities.offlineLaunch)) {
      throw new Error('Offline play requires a compatible Nexus backend and runtime. Update them in Settings while online.');
    }
    const licenseCache = offlineRuntime ? await deps.licenseCache() : undefined;
    const args = gameLaunchArguments(inspected, wine, store.settings.market, backend.linuxRunPatch,
      licenseCache, offlineLaunch && Boolean(licenseCache && backend.capabilities.offlineLaunch));
    const operationId = `game-${id}`;
    const logDirectory = path.join(dataRoot, 'logs');
    const logPath = path.join(logDirectory, `${id}-latest.log`);
    await fs.mkdir(logDirectory, { recursive: true });
    const launchLog = createWriteStream(logPath, { flags: 'w', encoding: 'utf8' });
    launchLog.on('error', (error) => console.error(`Unable to write launch log ${logPath}:`, error));
    const writeLaunchLog = (line: string) => launchLog.write(`[${new Date().toISOString()}] ${line}\n`);
    deps.onInviteAvailability?.(undefined);
    const operation: GameOperation = {
      id: operationId,
      gameId: id,
      title: game.title,
      kind: 'launch',
      status: 'preparing',
      phase: 'Preparing Proton and Xodus…',
      log: [],
      logPath,
      startedAt: new Date().toISOString(),
    };
    this.operation = operation;
    const owns = () => this.operation === operation;
    const changed = (immediate: boolean) => deps.onChange(operation, operationId, immediate);
    const appendGameLog = (line: string) => {
      writeLaunchLog(line);
      deps.onLog?.(operationId, line);
      if (!owns()) return;
      operation.log.push(line);
      if (operation.log.length > 250) operation.log.splice(0, operation.log.length - 250);
      operation.phase = line.length > 180 ? `${line.slice(0, 177)}…` : line;
      changed(false);
    };
    const baseEnvironment = deps.environment();
    const verboseLogs = baseEnvironment.XODUS_NEXUS_VERBOSE_LOGS === '1' || Boolean(store.settings.verboseLogs);
    const gameLog = new GameLogReducer(appendGameLog, verboseLogs);
    const addGameLog = (line: string) => gameLog.push(line);
    writeLaunchLog(`Game: ${game.title}`);
    writeLaunchLog(`Mode: package manifest; cloud saves: ${cloudRuntime ? 'enabled' : 'not available in active runtime'}; verbose logs: ${verboseLogs ? 'on' : 'off'}`);
    writeLaunchLog(`Backend: ${binary}`);
    writeLaunchLog(`Wine: ${wine}`);
    writeLaunchLog(`Connectivity: ${reachability.state}${reachability.reason ? ` (${reachability.reason})` : ''}; offline launch: ${offlineLaunch ? 'yes' : 'no'}`);
    changed(true);
    let service: AcquiredService | undefined;
    let inviteBridge: InviteBridgeHandle | undefined;
    let launchWrapper: GameWrapper | undefined;
    let releaseDisplay = () => {};
    let detachGame = () => {};
    try {
      if (game.launchTools?.dualSenseCompatibility) writeLaunchLog('DualSense compatibility mode enabled for this game (054c:0ce6).');
      if (game.launchTools?.dualShock4Compatibility) writeLaunchLog('DualShock 4 compatibility mode enabled for this game (v1, v2 and wireless adapter).');
      await deps.ensureWallet();
      const legacyPrefixRoot = path.join(dataRoot, 'prefixes', game.id);
      const compatibilityDataPath = path.join(dataRoot, 'compatdata', game.id);
      const steamRoot = path.join(deps.paths.home, '.steam', 'root');
      launchWrapper = await prepareGameWrapper(wine, game.launchTools, path.join(dataRoot, 'launch-wrappers'), baseEnvironment, game.path);
      const protonRunner = await prepareProtonRunner(wine, compatibilityDataPath, steamRoot, launchWrapper.command, store.settings.shaderCacheLimitGiB);
      const wineCommand = protonRunner?.command ?? wine;
      args[2] = preparedGameWine(protonRunner, launchWrapper.command);
      if (inspected.vcRedistEncrypted) {
        if (!protonRunner) throw new Error('This encrypted VC++ prerequisite requires a Proton prefix. Select Xodus Runtime in Settings.');
        const installed = await installedVcRuntimeVersion(path.join(compatibilityDataPath, 'pfx'));
        if (!installed || !versionAtLeast(installed, VC_REDIST_VERSION)) {
          throw new Error(`VC++ runtime ${installed ?? 'not found'} is too old for this encrypted installer. Right-click the game and choose Install / update VC++, then press Play.`);
        }
        addGameLog(`VC++ runtime ${installed} verified; launching the original package executable from a temporary decrypted launch view.`);
      }
      const environment = antiCheatEnvironment(gameLocaleEnvironment(gameWindowEnvironment(gameLoggingEnvironment(protonRunner
        ? { ...baseEnvironment }
        : { ...baseEnvironment, WINEPREFIX: legacyPrefixRoot, WINEARCH: 'win64' }, verboseLogs)), locale));
      if (deps.windowIdentity) {
        try {
          const identity = await deps.windowIdentity({ ...game, installState: inspected.installState }, inspected.coverDataUrl ?? game.coverDataUrl);
          if (identity) environment.WINE_APPLICATION_ID = identity;
        } catch { addGameLog('Game window icon unavailable.'); }
      }
      // Never inherit another title's discovery list. Hints are scoped public
      // metadata, not licenses, and cannot make an optional lookup block Play.
      delete environment.NEXUS_RELATED_PRODUCT_IDS;
      delete environment.NEXUS_INVITE_PORT;
      delete environment.NEXUS_INVITE_KEY;
      // A shell's stale offline mode or another account must not influence this
      // launch. The backend supplies identity mode only after license validation.
      delete environment.XODUS_OFFLINE_IDENTITY;
      delete environment.XODUS_FORCE_OFFLINE;
      delete environment.XODUS_ACCOUNT_HASH;
      // Lets nexus-close-window find this launch's windows (and only these) to close them like a user would.
      environment.XODUS_NEXUS_LAUNCH_ID = operationId;
      if (content.relatedProducts && await storeDiscoveryRuntime(wine)) {
        const related = await content.relatedProducts(game).catch(() => {
          addGameLog('Additional DLC discovery unavailable. Continuing with package-declared content.');
          return [] as string[];
        });
        if (related.length) environment.NEXUS_RELATED_PRODUCT_IDS = related.join(',');
      }
      const contentRoots = await content.roots(game).catch(error => {
        addGameLog(`Managed content discovery unavailable: ${(error as Error).message}`);
        return [] as string[];
      });
      if (contentRoots.length) environment.XODUS_CONTENT_ROOTS = [environment.XODUS_CONTENT_ROOTS, ...contentRoots.map(root => 'Z:' + root.replaceAll('/', '\\'))].filter(Boolean).join(';');
      if (offlineLaunch) {
        // The runtime treats the network as unreachable at once instead of
        // waiting for its own connect timeouts. Whether it may sign in from its
        // cached identity is the backend's decision, made only after the stored
        // license passed its lease checks.
        environment.XODUS_FORCE_OFFLINE = '1';
        addGameLog(`Microsoft is unreachable (${reachability.reason ?? 'no answer'}); launching offline with the stored license.`);
      }
      if (locale) {
        addGameLog(`Selected game language: ${locale}.`);
      }
      await syncPrefixUserLocale(wineCommand, protonRunner ? path.join(compatibilityDataPath, 'pfx') : legacyPrefixRoot, locale, environment, addGameLog);
      await syncUnrealCultureGameIni(protonRunner ? path.join(compatibilityDataPath, 'pfx') : legacyPrefixRoot, game.path, titleId, locale, addGameLog);
      if (cloudRuntime) {
        service = await deps.services.acquire(binary, deps.paths.userData, addGameLog);
        environment.XODUS_SOCKET = service.socketPath;
        environment.XODUS_BRIDGE_PORT = String(service.bridgePort);
        environment.XODUS_BRIDGE_KEY = service.bridgeKey;
        environment.XODUS_SAVE_SYNC = 'auto';
        addGameLog('Xbox cloud save preview is enabled. Saves may download from and upload to the account cloud.');
      }
      const inviteRuntime = await gameInviteRuntime(wine);
      deps.onInviteAvailability?.(!inviteRuntime ? 'The selected runtime does not support game invitations. Update the runtime and restart the game.' : !titleId ? 'The game has no Xbox title information for invitations.' : undefined);
      if (deps.inviteBridge && titleId && /^[a-f0-9]{1,8}$/i.test(titleId) && inviteRuntime) {
        try {
          inviteBridge = await deps.inviteBridge(operationId, game, String(parseInt(titleId, 16)), addGameLog);
          environment.NEXUS_INVITE_PORT = String(inviteBridge.port);
          environment.NEXUS_INVITE_KEY = inviteBridge.key;
        } catch {
          deps.onInviteAvailability?.('The game invitation connection could not be started. Restart the game to try again.');
          addGameLog('Optional game invitations are unavailable for this launch.');
        }
      }
      // Names the account for the runtime's offline identity cache (an opaque key, never the username).
      const account = deps.account();
      if (account.stored === true && account.username) environment.XODUS_ACCOUNT_HASH = accountCacheKey(account.username);
      if (protonRunner) addGameLog(`Proton prefix: ${protonRunner.compatibilityDataPath}/pfx`);
      else await fs.mkdir(legacyPrefixRoot, { recursive: true });
      const outputFile = deps.outputToFile ? path.join(logDirectory, `${id}-latest.output`) : undefined;
      const tracked = await spawnGameProcess(binary, args, {
        cwd: game.path,
        env: environment,
        onLine: addGameLog,
        maxOutput: 8_000_000,
      }, { stopPrefix: protonRunner?.stopPrefix, outputFile });
      detachGame = deps.attachGame?.(game, tracked.child.pid) ?? detachGame;
      releaseDisplay = deps.displayGuard();
      operation.status = 'running';
      operation.phase = 'Xodus is running; waiting for the game window…';
      changed(true);
      const wrapper = launchWrapper;
      const acquired = service;
      const invites = inviteBridge;
      const finished = tracked.result.then((result) => {
        addGameLog(`The Xodus process exited with code ${result.code}.`);
        if (!owns()) return;
        operation.finishedAt = new Date().toISOString();
        if (result.code === 0 || operation.status === 'stopping') {
          operation.status = 'complete';
          operation.phase = result.code === 0 ? 'The game has exited.' : 'The game was stopped. Forced shutdown may leave unsynchronized saves.';
        } else {
          // Steam's overlay preload warnings are noise in every launch, never the reason.
          const detail = result.output.split('\n').map((line) => line.trim()).filter((line) => line && !STEAM_PRELOAD_NOISE.test(line)).slice(-6).join(' | ');
          operation.status = 'failed';
          operation.error = contentLicenseFailure(result.output.split('\n'))
            ?? `Xodus run exited with code ${result.code}${detail ? `: ${detail.slice(0, 900)}` : '.'}`;
          operation.phase = operation.error;
        }
      }).catch((error) => {
        addGameLog(`Process error: ${(error as Error).message}`);
        if (!owns()) return;
        operation.status = 'failed';
        operation.error = (error as Error).message;
        operation.phase = operation.error;
        operation.finishedAt = new Date().toISOString();
      }).finally(async () => {
        releaseDisplay(); detachGame();
        if (this.active?.operationId === operationId) this.active = undefined;
        try {
          await invites?.stop().catch(() => undefined);
          if (acquired) await acquired.release().catch((error) => addGameLog(`Account service cleanup failed: ${(error as Error).message}`));
          await tracked.cleanup().catch((error) => console.error('Game service cleanup failed:', error));
          await wrapper?.cleanup().catch((error) => console.error('Game wrapper cleanup failed:', error));
          gameLog.flush();
          launchLog.end();
        } finally { changed(true); }
      });
      const active: ActiveGame = { operationId, gameId: id, operation, process: tracked, service, stopPrefix: protonRunner?.stopPrefix, outputFile, result: tracked.result, finished };
      this.active = active;
      return active;
    } catch (error) {
      releaseDisplay(); detachGame();
      await inviteBridge?.stop().catch(() => undefined);
      await launchWrapper?.cleanup().catch(() => undefined);
      if (service) await service.release().catch(() => undefined);
      writeLaunchLog(`Preparation error: ${(error as Error).message}`);
      gameLog.flush();
      launchLog.end();
      if (owns()) this.operation = undefined;
      deps.onChange(undefined, operationId, true);
      throw error;
    }
  }
}
