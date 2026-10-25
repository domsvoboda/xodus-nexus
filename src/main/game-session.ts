import { constants, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { BackendStatus, ConnectivityStatus, DownloadTask, Game, GameOperation, RuntimeStatus } from '../shared/types.js';
import { inspectGameDirectory } from './store.js';
import { prepareProtonRunner, syncPrefixUserLocale, syncUnrealCultureGameIni } from './proton.js';
import { accountCacheKey } from './offline-identity.js';
import { cloudSaveRuntime, selectedWinePath, unbridgedCloudSaveRuntime } from './xodus-service.js';
import { GameLogReducer, gameLoggingEnvironment, gameWindowEnvironment } from './game-log.js';
import { installedVcRuntimeVersion, VC_REDIST_VERSION, versionAtLeast } from './vc-runtime.js';
import { spawnGameProcess, type GameProcess } from './game-process.js';
import { gameLocaleEnvironment, manifestLocales, manifestTitleId, supportedGameLocale } from './game-locale.js';
import { antiCheatEnvironment } from './anti-cheat.js';
import { gameLaunchArguments, preparedGameWine } from './game-launch.js';
import { prepareGameWrapper, type GameWrapper } from './game-wrapper.js';
import { canonicalInstallPath, installPathsOverlap } from './install-queue.js';
import { GameContent } from './game-content.js';
import type { AcquiredService, ServiceSessions } from './service-sessions.js';
import { refreshOfflineLicenses } from './license-refresh.js';

/** Device-bound offline licenses written by `xodus-cli run --license-cache`. */
export function licenseCacheDirectory(dataRoot: string): string { return path.join(dataRoot, 'license-cache'); }

export async function gameLocales(game: Game): Promise<string[]> {
  const xml = await fs.readFile(path.join(game.path, 'MicrosoftGame.config'), 'utf8').catch(() => '');
  return manifestLocales(xml);
}

export async function gameTitleId(game: Game): Promise<string | undefined> {
  const xml = await fs.readFile(path.join(game.path, 'MicrosoftGame.config'), 'utf8').catch(() => '');
  return manifestTitleId(xml);
}

/** The state a launch reads; writes go through `persistGame`, so one process owns `state.json`. */
export interface GameSessionStore {
  readonly games: Game[];
  readonly downloads: DownloadTask[];
  readonly settings: { winePath: string; runtimeRoot: string; market: string; verboseLogs?: boolean };
}

/**
 * Everything a launch needs from its host process. The Electron launcher
 * supplies its windows, power blocker and wallet prompt; a background daemon
 * supplies the client's environment and no-op guards.
 */
export interface GameSessionDeps {
  store: GameSessionStore;
  backend(): BackendStatus;
  runtime(): RuntimeStatus;
  /** Resolves the `xodus-cli` path once the backend advertises `command`, else throws. */
  requireBackend(command: 'run'): string;
  paths: { userData: string; home: string };
  /** Base environment for the game; the daemon forwards the Steam client's. */
  environment(): NodeJS.ProcessEnv;
  connectivity?: { check(): Promise<ConnectivityStatus> };
  account(): { stored: boolean | null; username?: string };
  /** Game Mode wallet readiness; may prompt in Electron, must only check in a daemon. */
  ensureWallet(): Promise<void>;
  /** Holds the display awake while the game runs; returns the release. */
  displayGuard(): () => void;
  services: ServiceSessions;
  /** Stores inspection results. Absent in a process that must not write `state.json`. */
  persistGame?(id: string, patch: Partial<Game>): Promise<unknown>;
  /** `operation` is the live object (mutated in place) or undefined once a failed preparation is cleared. */
  onChange(operation: GameOperation | undefined, operationId: string, immediate: boolean): void;
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

export const FORCE_STOP_DELAY_MS = 8_000;

/** One game at a time: preparation, spawn, cancel and cleanup, host-agnostic. */
export class GameSession {
  private active: ActiveGame | undefined;
  private operation: GameOperation | undefined;
  private forceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: GameSessionDeps) {}

  /** The launch operation this session last created (complete ones included). */
  get current(): GameOperation | undefined { return this.operation; }

  /** The game currently preparing or running, if any. */
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
    const inspected = await inspectGameDirectory(game.path);
    const patch: Partial<Game> = {
      installState: inspected.installState,
      installMessage: inspected.installMessage,
      executable: inspected.executable,
      antiCheat: inspected.antiCheat,
      vcRedistEncrypted: inspected.vcRedistEncrypted,
      coverDataUrl: inspected.coverDataUrl,
      storeId: inspected.storeId ?? game.storeId,
    };
    await deps.persistGame?.(id, patch);
    const binary = deps.requireBackend('run');
    if (inspected.installState !== 'ready') throw new Error(inspected.installMessage ?? 'The installation is not ready for Xodus run.');
    const locale = supportedGameLocale(game.locale ?? '', await gameLocales(game));
    const titleId = await gameTitleId(game);
    const runtime = deps.runtime();
    const backend = deps.backend();
    const wine = selectedWinePath(store.settings.winePath, store.settings.runtimeRoot, runtime.winePath);
    if (!wine) throw new Error('Select a Wine/Xodus Proton binary in Settings.');
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
    const args = gameLaunchArguments(inspected, wine, store.settings.market, backend.linuxRunPatch,
      backend.capabilities.licenseCache ? licenseCacheDirectory(dataRoot) : undefined,
      offlineLaunch && Boolean(backend.capabilities.offlineLaunch));
    const operationId = `game-${id}`;
    const logDirectory = path.join(dataRoot, 'logs');
    const logPath = path.join(logDirectory, `${id}-latest.log`);
    await fs.mkdir(logDirectory, { recursive: true });
    const launchLog = createWriteStream(logPath, { flags: 'w', encoding: 'utf8' });
    launchLog.on('error', (error) => console.error(`Unable to write launch log ${logPath}:`, error));
    const writeLaunchLog = (line: string) => launchLog.write(`[${new Date().toISOString()}] ${line}\n`);
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
    let launchWrapper: GameWrapper | undefined;
    let releaseDisplay = () => {};
    try {
      if (game.launchTools?.dualSenseCompatibility) writeLaunchLog('DualSense compatibility mode enabled for this game (054c:0ce6).');
      await deps.ensureWallet();
      const legacyPrefixRoot = path.join(dataRoot, 'prefixes', game.id);
      const compatibilityDataPath = path.join(dataRoot, 'compatdata', game.id);
      const steamRoot = path.join(deps.paths.home, '.steam', 'root');
      launchWrapper = await prepareGameWrapper(wine, game.launchTools, path.join(dataRoot, 'launch-wrappers'), baseEnvironment, game.path);
      const protonRunner = await prepareProtonRunner(wine, compatibilityDataPath, steamRoot, launchWrapper.command);
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
      const contentRoots = await new GameContent(dataRoot).roots(game).catch(error => {
        addGameLog(`Managed content discovery unavailable: ${(error as Error).message}`);
        return [] as string[];
      });
      if (contentRoots.length) environment.XODUS_CONTENT_ROOTS = [environment.XODUS_CONTENT_ROOTS, ...contentRoots.map(root => 'Z:' + root.replaceAll('/', '\\'))].filter(Boolean).join(';');
      if (offlineLaunch) {
        // The runtime treats the network as unreachable at once and completes
        // the Xbox sign-in from its cached identity (xuser-offline-identity-v1).
        environment.XODUS_FORCE_OFFLINE = '1';
        addGameLog(`Microsoft is unreachable (${reachability.reason ?? 'no answer'}); launching offline with the stored license and the cached Xbox identity.`);
      }
      if (locale) {
        addGameLog(`Selected package language: ${locale}.`);
        await syncPrefixUserLocale(wineCommand, protonRunner ? path.join(compatibilityDataPath, 'pfx') : legacyPrefixRoot, locale, environment, addGameLog);
      }
      await syncUnrealCultureGameIni(protonRunner ? path.join(compatibilityDataPath, 'pfx') : legacyPrefixRoot, game.path, titleId, locale, addGameLog);
      if (cloudRuntime) {
        service = await deps.services.acquire(binary, deps.paths.userData, addGameLog);
        environment.XODUS_SOCKET = service.socketPath;
        environment.XODUS_BRIDGE_PORT = String(service.bridgePort);
        environment.XODUS_BRIDGE_KEY = service.bridgeKey;
        environment.XODUS_SAVE_SYNC = 'auto';
        addGameLog('Xbox cloud save preview is enabled. Saves may download from and upload to the account cloud.');
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
      releaseDisplay = deps.displayGuard();
      operation.status = 'running';
      operation.phase = 'Xodus is running; waiting for the game window…';
      changed(true);
      const wrapper = launchWrapper;
      const acquired = service;
      const finished = tracked.result.then((result) => {
        addGameLog(`The Xodus process exited with code ${result.code}.`);
        if (!owns()) return;
        operation.finishedAt = new Date().toISOString();
        if (result.code === 0 || operation.status === 'stopping') {
          operation.status = 'complete';
          operation.phase = result.code === 0 ? 'The game has exited.' : 'The game was stopped. Forced shutdown may leave unsynchronized saves.';
        } else {
          const detail = result.output.split('\n').map((line) => line.trim()).filter(Boolean).slice(-6).join(' | ');
          operation.status = 'failed';
          operation.error = `Xodus run exited with code ${result.code}${detail ? `: ${detail.slice(0, 900)}` : '.'}`;
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
        releaseDisplay();
        if (this.forceTimer) { clearTimeout(this.forceTimer); this.forceTimer = undefined; }
        if (this.active?.operationId === operationId) this.active = undefined;
        try {
          if (acquired) await acquired.release().catch((error) => addGameLog(`Account service cleanup failed: ${(error as Error).message}`));
          await tracked.cleanup().catch((error) => console.error('Game service cleanup failed:', error));
          await wrapper?.cleanup().catch((error) => console.error('Game wrapper cleanup failed:', error));
          gameLog.flush();
          launchLog.end();
        } finally { changed(true); }
        // After an online session, renew the other games' offline leases too
        // (this launch already renewed its own); at most once a day.
        if (!offlineLaunch && backend.capabilities.licenseCache && backend.capabilities.licenseRefresh) {
          void refreshOfflineLicenses(binary, licenseCacheDirectory(dataRoot), (line) => console.log(line));
        }
      });
      const active: ActiveGame = { operationId, gameId: id, operation, process: tracked, service, stopPrefix: protonRunner?.stopPrefix, outputFile, result: tracked.result, finished };
      this.active = active;
      return active;
    } catch (error) {
      releaseDisplay();
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

  /** Stops the running game; a force stop follows if it ignores the request. */
  async cancel(): Promise<void> {
    const operation = this.operation;
    if (!operation || !['preparing', 'running', 'stopping'].includes(operation.status)) throw new Error('No game launch is currently active.');
    const active = this.active;
    if (!active) throw new Error('Xodus is still preparing; try stopping again in a moment.');
    operation.status = 'stopping';
    operation.phase = 'Stopping Xodus and Wine…';
    try { await active.process.stop(); }
    catch (error) { operation.status = 'running'; this.deps.onChange(operation, operation.id, true); throw error; }
    this.forceTimer ??= setTimeout(() => {
      this.forceTimer = undefined;
      if (this.active === active) void active.process.forceStop().catch((error) => console.error('Could not force-stop game:', error));
    }, FORCE_STOP_DELAY_MS);
    this.forceTimer.unref();
    this.deps.onChange(operation, operation.id, true);
  }
}
