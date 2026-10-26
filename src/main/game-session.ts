import { constants, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { BackendStatus, ConnectivityStatus, DownloadTask, Game, GameOperation, RuntimeStatus } from '../shared/types.js';
import { inspectGameDirectory } from './store.js';
import { prefixUserLocale, prepareProtonRunner, syncPrefixUserLocale, syncUnrealCultureGameIni } from './proton.js';
import { isNexusTool } from './steam-tool.js';
import { applyPrefixSettings } from './wine-registry.js';
import { accountCacheKey } from './offline-identity.js';
import { bindOfflineAccess, licenseCacheDirectory, type OfflineRevocation } from './offline-access.js';
import { cloudSaveRuntime, gameInviteRuntime, selectedWinePath, storeDiscoveryRuntime, unbridgedCloudSaveRuntime } from './xodus-service.js';
import { GameLogReducer, gameLoggingEnvironment, gameWindowEnvironment } from './game-log.js';
import { installedVcRuntimeVersion, VC_REDIST_VERSION, versionAtLeast } from './vc-runtime.js';
import { spawnGameProcess, type GameProcess } from './game-process.js';
import { gameLocaleEnvironment, installedGameLocales, installedGameTitleId, supportedGameLocale } from './game-locale.js';
import { antiCheatEnvironment } from './anti-cheat.js';
import { gameLaunchArguments, preparedGameWine } from './game-launch.js';
import { prepareGameWrapper, type GameWrapper } from './game-wrapper.js';
import { canonicalInstallPath, installPathsOverlap } from './install-queue.js';
import { GameContent } from './game-content.js';
import { contentLicenseFailure } from '../shared/content-license.js';
import type { AcquiredService, ServiceSessions } from './service-sessions.js';
import { protonRootOf } from './proton-layout.js';
import { forwardedWrappers, launchViewDirectory, prepareSteamOverlay, steamCompatData, steamCompatMounts, steamProtonCommand, writeSteamLauncher, writeWrappedLauncher } from './steam-compat.js';
import { profileIdOf } from '../shared/profile-id.js';

export { licenseCacheDirectory };

export async function gameLocales(game: Game): Promise<string[]> {
  return installedGameLocales(game.path);
}

export async function gameTitleId(game: Game): Promise<string | undefined> {
  return installedGameTitleId(game.path);
}

/** The state a launch reads; writes go through `persistGame`, so one process owns `state.json`. */
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
  /** Managed DLC/content for the data root; a new `GameContent` when absent. */
  content?(dataRoot: string): GameContent;
  /** Related Store products (DLC hints) for the runtime's discovery; absent where the account library is not loaded. */
  relatedProducts?(game: Game, content: GameContent): Promise<string[]>;
  /** Starts the game's invitation bridge; absent where there is no Friends UI to accept them. */
  inviteBridge?(operationId: string, game: Game, titleId: string, log: (line: string) => void): Promise<InviteBridgeHandle>;
  /** Stored offline data was removed before the launch, e.g. another account left it behind. */
  onOfflineRevoked?(reason: OfflineRevocation): void;
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

export interface LaunchOptions {
  /** Steam's `%command%` from the shortcut: a Proton there runs the game instead of the Nexus runtime. */
  steamCommand?: string[];
}

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

  async launch(id: string, options: LaunchOptions = {}): Promise<ActiveGame> {
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
    const locale = supportedGameLocale(game.locale ?? '');
    const titleId = await gameTitleId(game).catch(() => undefined);
    const runtime = deps.runtime();
    const backend = deps.backend();
    const wine = selectedWinePath(store.settings.winePath, store.settings.runtimeRoot, runtime.winePath);
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
    const owner = deps.account();
    if (owner.stored === true && owner.username && await bindOfflineAccess(dataRoot, owner.username)) deps.onOfflineRevoked?.('account-changed');
    const licenseCache = backend.capabilities.licenseCache ? licenseCacheDirectory(dataRoot) : undefined;
    const selectedProton = steamProtonCommand(options.steamCommand);
    // The "Xodus Nexus" entry in Steam's dropdown is the Nexus runtime itself.
    const nexusTool = Boolean(selectedProton && await isNexusTool(selectedProton.protonRoot));
    const steamProton = nexusTool ? undefined : selectedProton;
    if (steamProton && !backend.capabilities.fullView) throw new Error("Steam's compatibility tool needs a newer Xodus backend. Update the backend in Settings, or clear the compatibility tool for this game in Steam.");
    const args = gameLaunchArguments(inspected, wine, store.settings.market, backend.linuxRunPatch,
      licenseCache, offlineLaunch && Boolean(licenseCache && backend.capabilities.offlineLaunch));
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
    if (steamProton) writeLaunchLog(`Compatibility tool: Steam's ${steamProton.protonRoot}`);
    else if (nexusTool) writeLaunchLog('Compatibility tool: Xodus Nexus (the Nexus runtime)');
    writeLaunchLog(`Connectivity: ${reachability.state}${reachability.reason ? ` (${reachability.reason})` : ''}; offline launch: ${offlineLaunch ? 'yes' : 'no'}`);
    changed(true);
    let service: AcquiredService | undefined;
    let inviteBridge: InviteBridgeHandle | undefined;
    let launchWrapper: GameWrapper | undefined;
    let releaseDisplay = () => {};
    try {
      if (game.launchTools?.dualSenseCompatibility) writeLaunchLog('DualSense compatibility mode enabled for this game (054c:0ce6).');
      await deps.ensureWallet();
      const legacyPrefixRoot = path.join(dataRoot, 'prefixes', game.id);
      const compatibilityDataPath = path.join(dataRoot, 'compatdata', game.id);
      const steamRoot = path.join(deps.paths.home, '.steam', 'root');
      // Steam's Proton: Steam owns the prefix, Nexus adds its runtime overlay
      // and runs the game from a full private launch view (no Wine file maps).
      const steamPrefix = steamProton ? (await steamCompatData(baseEnvironment)).prefix : undefined;
      const overlay = steamProton ? await prepareSteamOverlay(steamProton, protonRootOf(wine), baseEnvironment, addGameLog) : undefined;
      const viewDirectory = steamProton ? await launchViewDirectory(baseEnvironment, profileIdOf(deps.paths.userData)) : undefined;
      const gameWine = steamProton ? await writeSteamLauncher(path.join(dataRoot, 'launch-wrappers', 'steam', game.id), steamProton) : wine;
      launchWrapper = await prepareGameWrapper(gameWine, game.launchTools, path.join(dataRoot, 'launch-wrappers'), baseEnvironment, game.path);
      const protonRunner = steamProton ? undefined : await prepareProtonRunner(wine, compatibilityDataPath, steamRoot, launchWrapper.command, store.settings.shaderCacheLimitGiB);
      const wineCommand = protonRunner?.command ?? wine;
      args[2] = preparedGameWine(protonRunner, launchWrapper.command);
      // The shortcut's launch wrappers (armada-game-launch, gamemoderun, …) run
      // around the game itself, so per-game settings reach its real process.
      // With Steam's Proton they are already part of the Steam launcher.
      const wrappers = steamProton ? [] : forwardedWrappers(options.steamCommand ?? []);
      if (wrappers.length) {
        args[2] = await writeWrappedLauncher(path.join(dataRoot, 'launch-wrappers', 'steam', game.id), wrappers, args[2]);
        addGameLog(`Running the game inside the shortcut's launch wrappers: ${wrappers.join(' ')}`);
      }
      if (viewDirectory) args.splice(args.indexOf('--materialize-chain') + 1, 0, '--materialize-all', '--view-dir', viewDirectory);
      // The Nexus runtime's launcher puts its PlayFab Game Saves adapter in its
      // own views; for another Proton the backend stages it in the full view.
      if (overlay && baseEnvironment.NEXUS_PLAYFAB_ADAPTER !== '0') {
        const adapter = await overlay.playfabAdapter();
        if (adapter && backend.capabilities.playfabAdapter) args.splice(args.indexOf('--view-dir') + 2, 0, '--playfab-adapter', adapter);
        else addGameLog('The PlayFab Game Saves adapter is unavailable for this compatibility tool; games that need it may not find their saves.');
      }
      const gamePrefix = steamPrefix ?? (protonRunner ? path.join(compatibilityDataPath, 'pfx') : legacyPrefixRoot);
      if (inspected.vcRedistEncrypted) {
        if (!protonRunner && !steamPrefix) throw new Error('This encrypted VC++ prerequisite requires a Proton prefix. Select Xodus Runtime in Settings.');
        const installed = await installedVcRuntimeVersion(gamePrefix);
        if (!installed || !versionAtLeast(installed, VC_REDIST_VERSION)) {
          throw new Error(`VC++ runtime ${installed ?? 'not found'} is too old for this encrypted installer. Right-click the game and choose Install / update VC++, then press Play.`);
        }
        addGameLog(`VC++ runtime ${installed} verified; launching the original package executable from a temporary decrypted launch view.`);
      }
      const environment = antiCheatEnvironment(gameLocaleEnvironment(gameWindowEnvironment(gameLoggingEnvironment(protonRunner || steamProton
        ? { ...baseEnvironment }
        : { ...baseEnvironment, WINEPREFIX: legacyPrefixRoot, WINEARCH: 'win64' }, verboseLogs)), locale));
      // Never inherit another title's discovery list. Hints are scoped public
      // metadata, not licenses, and cannot make an optional lookup block Play.
      delete environment.NEXUS_RELATED_PRODUCT_IDS;
      delete environment.NEXUS_INVITE_PORT;
      delete environment.NEXUS_INVITE_KEY;
      const content = deps.content?.(dataRoot) ?? new GameContent(dataRoot);
      if (deps.relatedProducts && await storeDiscoveryRuntime(wine)) {
        const related = await deps.relatedProducts(game, content).catch(() => {
          addGameLog('Additional DLC discovery unavailable. Continuing with package-declared content.');
          return [] as string[];
        });
        if (related.length) environment.NEXUS_RELATED_PRODUCT_IDS = related.join(',');
      }
      if (overlay && viewDirectory) {
        Object.assign(environment, overlay.environment);
        environment.STEAM_COMPAT_MOUNTS = steamCompatMounts(baseEnvironment, [await canonicalInstallPath(game.path), viewDirectory]);
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
      if (locale) addGameLog(`Selected game language: ${locale}.`);
      if (steamPrefix) {
        // No Windows helper can run outside Steam's own launch here: the same
        // settings go straight into the prefix's registry files.
        await applyPrefixSettings(steamPrefix, {
          gamingServices: baseEnvironment.NEXUS_GAMING_SERVICES_VERSION_OVERRIDE !== '0',
          resetLocale: Boolean(locale?.includes('-')) && await prefixUserLocale(steamPrefix) !== locale,
        }, addGameLog);
      } else await syncPrefixUserLocale(wineCommand, gamePrefix, locale, environment, addGameLog);
      await syncUnrealCultureGameIni(gamePrefix, game.path, titleId, locale, addGameLog);
      if (cloudRuntime) {
        service = await deps.services.acquire(binary, deps.paths.userData, addGameLog);
        environment.XODUS_SOCKET = service.socketPath;
        environment.XODUS_BRIDGE_PORT = String(service.bridgePort);
        environment.XODUS_BRIDGE_KEY = service.bridgeKey;
        environment.XODUS_SAVE_SYNC = 'auto';
        addGameLog('Xbox cloud save preview is enabled. Saves may download from and upload to the account cloud.');
      }
      if (deps.inviteBridge && titleId && /^[a-f0-9]{1,8}$/i.test(titleId) && await gameInviteRuntime(wine)) {
        try {
          inviteBridge = await deps.inviteBridge(operationId, game, String(parseInt(titleId, 16)), addGameLog);
          environment.NEXUS_INVITE_PORT = String(inviteBridge.port);
          environment.NEXUS_INVITE_KEY = inviteBridge.key;
        } catch { addGameLog('Optional game invitations are unavailable for this launch.'); }
      }
      // Names the account for the runtime's offline identity cache (an opaque key, never the username).
      const account = deps.account();
      if (account.stored === true && account.username) environment.XODUS_ACCOUNT_HASH = accountCacheKey(account.username);
      if (steamPrefix) addGameLog(`Steam Proton prefix: ${steamPrefix}`);
      else if (protonRunner) addGameLog(`Proton prefix: ${protonRunner.compatibilityDataPath}/pfx`);
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
      const invites = inviteBridge;
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
        releaseDisplay();
        if (this.forceTimer) { clearTimeout(this.forceTimer); this.forceTimer = undefined; }
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
      releaseDisplay();
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
