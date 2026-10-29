import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConnectivityStatus, Game, GameOperation } from '../shared/types.js';
import type { DaemonErrorCode, DaemonState, InviteAction } from '../shared/daemon-protocol.js';
import { StateStore } from '../main/store.js';
import { BackendManager } from '../main/backend.js';
import { RuntimeManager } from '../main/runtime.js';
import { ConnectivityMonitor } from '../main/connectivity.js';
import { KeyringSupport, type KeyringActions } from '../main/keyring.js';
import { startSessionKeyring } from '../main/keyring-session.js';
import { WalletUnlocker } from '../main/keyring-unlock.js';
import { GameSession, type ActiveGame } from '../main/game-session.js';
import { WarmServiceSessions } from '../main/service-sessions.js';
import { readAccount } from '../main/account-refresh.js';
import { GameLogReducer } from '../main/game-log.js';
import { GameContent } from '../main/game-content.js';
import { hasIncompleteUpdate } from '../main/installation-state.js';
import { assertOfflineAccessReady, licenseCacheDirectory, offlineAccessRevoked, revokeOfflineAccess } from '../main/offline-access.js';
import { OutputTail } from '../main/output-tail.js';
import { GameInviteBridge } from '../main/game-invite-bridge.js';
import { XboxTitlePresence } from '../main/xbox-title-presence.js';
import { closeGracefully, keepSteamFocus, type Closable } from '../main/graceful-close.js';
import { AdoptedGame, adoptService, SessionStateFile, type SessionRecord } from './recovery.js';

export class DaemonError extends Error {
  constructor(readonly code: DaemonErrorCode, message: string) { super(message); this.name = 'DaemonError'; }
}

export interface LaunchRequest { gameId: string; env: Record<string, string>; cwd?: string }

export interface ControllerOptions {
  userData: string;
  home: string;
  /** `$XDG_RUNTIME_DIR/xodus-nexus/<profileId>`: service sessions and the recovery state file live here. */
  runtimeRoot: string;
  log(line: string): void;
  /** Path of the `nexus-close-window` helper, when this build carries one. */
  closeHelper?: string;
  /** Re-validate the backend binary at most this often between launches. */
  backendRefreshMs?: number;
  accountCheckMs?: number;
  /** Without an owner this long after a restart, an adopted game is closed. */
  orphanGraceMs?: number;
}

/** A network interface besides loopback is up; Electron's `net.isOnline` equivalent. */
export function interfaceOnline(): boolean {
  return Object.values(os.networkInterfaces()).some(entries => entries?.some(entry => !entry.internal));
}

/**
 * The Store market for DLC discovery: the configured one, or for "neutral" the
 * country of the session's locale (Electron asks the OS the same way).
 */
export function daemonMarket(configured: string, env: NodeJS.ProcessEnv): string {
  if (configured.toLowerCase() !== 'neutral') return configured;
  for (const value of [env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    const country = value?.match(/^[a-z]{2,3}_([A-Z]{2})(?:[.@]|$)/)?.[1];
    if (country) return country;
  }
  return 'US';
}

export interface InviteNotice { notice: 'choose' | 'invitation'; game: string; sender?: string }

/** How long a launch waits for the previous game to finish closing; above graceful.ts's close and stop waits. */
const CLOSE_QUEUE_MS = 45_000;

type Running ={ kind: 'launched'; active: ActiveGame } | { kind: 'adopted'; game: AdoptedGame; finished: Promise<void> };

/**
 * The daemon's one game at a time: the launch core with daemon adapters (the
 * client's environment, a check-only wallet, no display inhibitor), a warm
 * account service, ownership by the client connection that asked, graceful
 * close when that client dies, and enough durable state to re-adopt a running
 * game and service after the daemon itself restarts.
 */
export class GameController {
  readonly store: StateStore;
  readonly backend: BackendManager;
  readonly runtime: RuntimeManager;
  readonly connectivity: ConnectivityMonitor;
  readonly services: WarmServiceSessions;
  private readonly session: GameSession;
  private readonly stateFile: SessionStateFile;
  private readonly walletUnlocker = new WalletUnlocker();
  private clientEnvironment: NodeJS.ProcessEnv = {};
  private preparing = false;
  private running: Running | undefined;
  private ownerId: string | undefined;
  /** The running game belongs to a client (even one that has since gone): it must not outlive it. */
  private ownedGame = false;
  private cancelWhenStarted = false;
  private closing = false;
  private inspected: DaemonState['inspected'];
  private lastBackendRefresh = 0;
  private account: { stored: boolean | null; username?: string } = { stored: null };
  private accountReadAt = 0;
  private accountError: string | undefined;
  private orphanTimer: ReturnType<typeof setTimeout> | undefined;
  /** The running game's invitation bridge; its UI is the launcher's Friends view. */
  private inviteBridge: GameInviteBridge | undefined;
  private stopped = false;
  /** Ends the running game's STEAM_GAME marker, which also hands the screen back to Steam. */
  private stopFocus: (() => void) | undefined;
  private maintenance: ReturnType<typeof setInterval> | undefined;
  private readonly stateListeners = new Set<(state: DaemonState) => void>();
  private readonly logListeners = new Set<(operationId: string, line: string) => void>();
  private readonly exitListeners = new Set<(operationId: string, code: number | null, status: 'complete' | 'failed') => void>();
  private readonly inviteListeners = new Set<(notice: InviteNotice) => void>();

  constructor(private readonly options: ControllerOptions) {
    this.store = new StateStore(options.userData);
    this.stateFile = new SessionStateFile(path.join(options.runtimeRoot, 'state.json'));
    const emitLog = (scope: string, line: string) => options.log(`[${scope}] ${line}`);
    this.runtime = new RuntimeManager(this.store.settings.runtimeRoot, emitLog, () => this.busy);
    this.backend = new BackendManager(options.userData, this.store.settings.externalXodusRoot, emitLog, () => this.busy);
    this.connectivity = new ConnectivityMonitor({ interfaceOnline, onChange: () => this.publish() });
    this.services = new WarmServiceSessions({ log: options.log });
    const self = this;
    this.session = new GameSession({
      store: { get games() { return self.store.games; }, get downloads() { return self.store.downloads; }, get settings() { return self.store.settings; } },
      backend: () => this.backend.current,
      runtime: () => this.runtime.current,
      requireBackend: (command) => this.requireBackend(command),
      // Service sessions live in the runtime directory: a crashed daemon leaves nothing under userData.
      paths: { userData: options.runtimeRoot, home: options.home },
      environment: () => this.clientEnvironment,
      connectivity: this.connectivity,
      account: () => this.account,
      ensureWallet: () => this.checkWallet(),
      displayGuard: () => () => {},
      services: this.services,
      // Check only: the launcher records the interrupted update in state.json when it next looks.
      incompleteUpdate: (game) => hasIncompleteUpdate(game.path),
      licenseCache: () => this.offlineLicenseCache(),
      // Public catalog relations only; the account library (owned bundles) is
      // the launcher's, as it is before its Library page has loaded.
      content: (dataRoot) => {
        const content = new GameContent(dataRoot);
        return { roots: (game) => content.roots(game), relatedProducts: (game) => content.relatedProducts(game, {}, daemonMarket(this.store.settings.market, { ...process.env, ...this.clientEnvironment })) };
      },
      inviteBridge: (operationId, game, titleId, log) => this.startInvites(operationId, game.title, titleId, log),
      onChange: () => this.publish(),
      onLog: (operationId, line) => { for (const listener of this.logListeners) listener(operationId, line); },
      outputToFile: true,
    });
  }

  async start(): Promise<void> {
    await this.store.load();
    this.runtime.setRoot(this.store.settings.runtimeRoot);
    await this.backend.refresh();
    this.lastBackendRefresh = Date.now();
    await this.runtime.refresh();
    this.connectivity.start();
    await this.recover();
    this.maintenance = setInterval(() => void this.maintain(), 60_000);
    this.maintenance.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.maintenance) clearInterval(this.maintenance);
    if (this.orphanTimer) clearTimeout(this.orphanTimer);
    this.connectivity.stop();
    await this.walletUnlocker.stop();
    const running = this.running;
    if (running) {
      await this.close('the background service is stopping');
      await Promise.race([running.kind === 'launched' ? running.active.finished : running.finished, new Promise<void>(resolve => setTimeout(resolve, 60_000))]);
    }
    await this.services.stopAll().catch(error => this.options.log(`Account service stop failed: ${(error as Error).message}`));
    await this.stateFile.remove().catch(() => undefined);
  }

  get busy(): boolean { return this.preparing || Boolean(this.running); }
  get owner(): string | undefined { return this.ownerId; }
  /** True while nothing runs and no account service is kept warm: the daemon may exit. */
  get idle(): boolean { return !this.busy && !this.services.status.warm; }

  state(): DaemonState {
    const operation = this.running?.kind === 'adopted' ? this.running.game.operation : this.session.current;
    const service = this.services.status;
    return {
      gameOperation: operation ? structuredClone(operation) : undefined,
      inspected: this.inspected,
      session: { warm: service.warm, startedAt: service.startedAt, lastCheckAt: this.accountReadAt ? new Date(this.accountReadAt).toISOString() : undefined, error: this.accountError },
      connectivity: this.connectivity.current as ConnectivityStatus,
      ...(this.inviteBridge ? { invites: this.inviteBridge.state() } : {}),
    };
  }

  onState(listener: (state: DaemonState) => void): () => void { this.stateListeners.add(listener); return () => this.stateListeners.delete(listener); }
  onLog(listener: (operationId: string, line: string) => void): () => void { this.logListeners.add(listener); return () => this.logListeners.delete(listener); }
  onExit(listener: (operationId: string, code: number | null, status: 'complete' | 'failed') => void): () => void { this.exitListeners.add(listener); return () => this.exitListeners.delete(listener); }
  onInviteNotice(listener: (notice: InviteNotice) => void): () => void { this.inviteListeners.add(listener); return () => this.inviteListeners.delete(listener); }

  /** A Friends UI action on the running game's invitations. */
  invite(action: InviteAction, id: string, xuid?: string): void {
    const bridge = this.inviteBridge;
    if (!bridge || (action === 'friend' ? id !== bridge.id : !id.startsWith(bridge.id + ':'))) throw new Error('The game is no longer running.');
    if (action === 'choose') bridge.choose(id, xuid);
    else if (action === 'cancel') bridge.cancel(id);
    else if (action === 'accept') bridge.accept(id);
    else bridge.invite(xuid);
  }

  /**
   * The game's invitation bridge, as the launcher starts it: valid only while
   * the account that started it is still the stored one. Asking for a friend
   * and a received invitation are announced to the launcher, which shows them.
   */
  private async startInvites(operationId: string, game: string, titleId: string, log: (line: string) => void) {
    const account = this.account.username;
    const current = () => !this.stopped && Boolean(account) && this.account.stored === true && this.account.username === account;
    const announce = (notice: InviteNotice) => { for (const listener of this.inviteListeners) listener(notice); };
    const bridge = new GameInviteBridge(operationId, game, titleId, current, () => this.publish(),
      () => announce({ notice: 'choose', game }), Date.now, sender => announce({ notice: 'invitation', game, sender }), new XboxTitlePresence(current, log));
    try { await bridge.start(); }
    catch (error) { await bridge.stop().catch(() => {}); throw error; }
    this.inviteBridge = bridge;
    return { port: bridge.port, key: bridge.key, stop: async () => { try { await bridge.stop(); } finally { if (this.inviteBridge === bridge) { this.inviteBridge = undefined; this.publish(); } } } };
  }

  async launch(request: LaunchRequest, ownerId?: string): Promise<{ operationId: string }> {
    // Exit game hands the screen back while the last game still closes (and
    // uploads its saves); a launch right after waits for that instead of failing.
    const closingRun = this.closing ? this.running : undefined;
    if (closingRun) {
      this.options.log('Waiting for the last game to finish closing before launching.');
      await Promise.race([closingRun.kind === 'launched' ? closingRun.active.finished : closingRun.finished,
        new Promise<void>(resolve => setTimeout(resolve, CLOSE_QUEUE_MS))]);
    }
    if (this.busy) throw new DaemonError('busy', 'Another game is already starting or running.');
    this.preparing = true;
    this.ownerId = ownerId;
    this.ownedGame = Boolean(ownerId);
    this.cancelWhenStarted = false;
    this.closing = false;
    try {
      await this.store.load();
      if (!this.store.games.some(game => game.id === request.gameId)) throw new DaemonError('game-not-found', 'Game not found.');
      if (Date.now() - this.lastBackendRefresh > (this.options.backendRefreshMs ?? 300_000) || !this.backend.current.available) {
        await this.backend.refresh();
        this.lastBackendRefresh = Date.now();
      }
      if (!this.backend.current.available) throw new DaemonError('backend-unavailable', 'The Xodus backend is unavailable. Open Nexus to install or repair it.');
      if (!this.runtime.current.winePath) await this.runtime.refresh();
      // The close helper finds the game's windows by this id (see recovery.ts and graceful.ts).
      this.clientEnvironment = { ...request.env, XODUS_NEXUS_LAUNCH_ID: `game-${request.gameId}` };
      // The account read needs the wallet, so bring it up first.
      await this.checkWallet();
      await this.refreshAccount();
      this.inspected = undefined;
      const active = await this.session.launch(request.gameId);
      this.running = { kind: 'launched', active };
      this.inspected = this.captureInspection(active.gameId);
      await this.persist();
      const stopFocus = keepSteamFocus(this.options.closeHelper, active.operationId, this.clientEnvironment, this.options.log);
      this.stopFocus = stopFocus;
      void active.result.catch(() => undefined).finally(stopFocus);
      void active.result.catch(() => undefined).then(async () => {
        const code = await active.result.then(result => result.code, () => null);
        for (const listener of this.exitListeners) listener(active.operationId, code, active.operation.status === 'failed' ? 'failed' : 'complete');
      });
      void active.finished.finally(() => this.finished(ownerId));
      if (this.cancelWhenStarted) { this.cancelWhenStarted = false; void this.close('its Steam client went away before it started'); }
      return { operationId: active.operationId };
    } finally { this.preparing = false; this.publish(); }
  }

  async cancel(): Promise<void> {
    const running = this.running;
    if (!running) {
      if (this.session.current && this.session.current.status === 'preparing') throw new Error('Xodus is still preparing; try stopping again in a moment.');
      throw new Error('No game launch is currently active.');
    }
    // Stop closes the game like Exit game does, so the runtime still uploads its
    // saves; pressing Stop again while it closes forces it.
    if (!this.closing) { void this.close('stopped from Nexus'); return; }
    this.options.log('Stop pressed again; forcing the game to stop.');
    this.publish();
    const game: Closable = running.kind === 'launched' ? running.active.process : running.game;
    await game.forceStop().catch(error => this.options.log(`Force stop failed: ${(error as Error).message}`));
  }

  /** A reconnecting client takes ownership of the running game it names. */
  attach(operationId: string, ownerId: string): boolean {
    const current = this.running?.kind === 'launched' ? this.running.active.operationId : this.running?.game.operation.id;
    if (!current || current !== operationId) return false;
    this.ownerId = ownerId;
    this.ownedGame = true;
    this.cancelWhenStarted = false;
    if (this.orphanTimer) { clearTimeout(this.orphanTimer); this.orphanTimer = undefined; }
    void this.persist();
    return true;
  }

  /** Steam killed the thin client: close its game gracefully, keep everything else alive. */
  ownerLost(ownerId: string): void {
    if (this.ownerId !== ownerId) return;
    this.ownerId = undefined;
    void this.persist();
    if (this.running) void this.close('its Steam client went away');
    else if (this.preparing) this.cancelWhenStarted = true;
  }

  private async close(reason: string): Promise<void> {
    const running = this.running;
    if (!running || this.closing) return;
    this.closing = true;
    const game: Closable = running.kind === 'launched' ? running.active.process : running.game;
    const operation = running.kind === 'launched' ? running.active.operation : running.game.operation;
    operation.status = 'stopping';
    operation.phase = 'Closing the game and finishing its cloud saves…';
    this.publish();
    this.options.log(`Closing ${operation.title}: ${reason}.`);
    // Steam already shows the game as exited: give the screen back now and let
    // the game finish (and upload its saves) in the background.
    this.stopFocus?.();
    const outcome = await closeGracefully(game, operation.id, {
      helper: this.options.closeHelper, env: running.kind === 'launched' ? this.clientEnvironment : running.game.record.env,
      log: line => { this.options.log(line); for (const listener of this.logListeners) listener(operation.id, line); },
    });
    this.options.log(`${operation.title} ${outcome === 'closed' ? 'closed on request' : outcome === 'stopped' ? 'stopped on interrupt' : 'was forced to stop'}.`);
  }

  private finished(ownerId: string | undefined): void {
    this.running = undefined;
    this.stopFocus = undefined;
    this.ownedGame = false;
    this.closing = false;
    if (this.ownerId === ownerId) this.ownerId = undefined;
    void this.persist();
    this.publish();
  }

  private async recover(): Promise<void> {
    const record = await this.stateFile.read();
    if (!record) return;
    if (record.service) {
      const session = await adoptService(record.service);
      if (session) { this.services.adopt(session, record.service.binary, record.service.startedAt); this.options.log('Re-attached to the running Xodus account service.'); }
      else this.options.log('The previous account service is gone; a new one starts with the next launch.');
    }
    if (record.game) {
      if (await AdoptedGame.verify(record.game)) {
        const game = new AdoptedGame(record.game);
        // The previous daemon's focus marker exited with it; keep gamescope on the game.
        const stopFocus = keepSteamFocus(this.options.closeHelper, record.game.operationId, record.game.env, this.options.log);
        this.stopFocus = stopFocus;
        void game.result.catch(() => undefined).finally(stopFocus);
        const stopOutput = this.followOutput(record.game);
        const finished = game.result.then(async () => {
          await stopOutput();
          for (const listener of this.exitListeners) listener(game.operation.id, null, 'complete');
          game.dispose();
          await this.services.sweep().catch(() => undefined);
        });
        const running: Running = { kind: 'adopted', game, finished };
        this.running = running;
        void finished.finally(() => this.finished(undefined));
        // A game nobody owned (launched from Nexus in Desktop Mode) simply keeps running.
        this.ownedGame = record.game.owned !== false;
        if (this.ownedGame) {
          this.options.log(`Re-attached to the running game ${record.game.title}; waiting for its client to reconnect.`);
          this.orphanTimer = setTimeout(() => { if (this.running === running && !this.ownerId) void this.close('no client reclaimed it after the restart'); }, this.options.orphanGraceMs ?? 60_000);
          this.orphanTimer.unref?.();
        } else this.options.log(`Re-attached to the running game ${record.game.title}.`);
      } else this.options.log(`The previous game ${record.game.title} is no longer running.`);
    }
    await this.persist();
  }

  /**
   * Keeps an adopted game's log going: the game still appends to its output
   * file, so follow it from here on into the same log and to the clients.
   * Returns the finish, which reads what is left once the game has exited.
   */
  private followOutput(record: NonNullable<SessionRecord['game']>): () => Promise<void> {
    const { outputFile, logPath, operationId } = record;
    if (!outputFile || !logPath) return async () => {};
    const log = createWriteStream(logPath, { flags: 'a', encoding: 'utf8' });
    log.on('error', error => this.options.log(`Unable to write launch log ${logPath}: ${error.message}`));
    const write = (line: string) => {
      log.write(`[${new Date().toISOString()}] ${line}\n`);
      for (const listener of this.logListeners) listener(operationId, line);
    };
    const reducer = new GameLogReducer(write, record.env.XODUS_NEXUS_VERBOSE_LOGS === '1' || Boolean(this.store.settings.verboseLogs));
    write('Re-attached after the background service restarted; output from the restart itself may be missing.');
    const tail = new OutputTail(outputFile, line => reducer.push(line)).start();
    return async () => {
      await tail.drain();
      reducer.flush();
      write('The game has exited.');
      await new Promise<void>(resolve => log.end(resolve));
    };
  }

  private async persist(): Promise<void> {
    const record: SessionRecord = { schema: 1 };
    const running = this.running;
    const pgid = running?.kind === 'launched' ? running.active.process.child.pid : undefined;
    if (running?.kind === 'launched' && pgid) {
      const { active } = running;
      record.game = {
        operationId: active.operationId, gameId: active.gameId, title: active.operation.title, pgid,
        logPath: active.operation.logPath, outputFile: active.outputFile, startedAt: active.operation.startedAt, stopPrefix: active.stopPrefix,
        env: Object.fromEntries(Object.entries(this.clientEnvironment).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
        owned: this.ownedGame,
      };
    } else if (running?.kind === 'adopted') record.game = { ...running.game.record, owned: this.ownedGame };
    const service = this.services.status;
    const live = this.services.current;
    const pid = live?.pid;
    if (service.warm && live && pid) {
      record.service = { pid, socketPath: live.socketPath, bridgePort: live.bridgePort, bridgeKey: live.bridgeKey, runtimeDir: live.runtimeDir, binary: this.services.binary ?? '', startedAt: service.startedAt ?? new Date().toISOString() };
    }
    if (!record.game && !record.service) { await this.stateFile.remove().catch(() => undefined); return; }
    await this.stateFile.write(record).catch(error => this.options.log(`Could not save recovery state: ${(error as Error).message}`));
  }

  /** Once a minute: drop a dead or long-idle account service, confirm the account while warm. */
  private async maintain(): Promise<void> {
    if (this.busy) return;
    if (!this.services.status.warm) return;
    if (!await this.services.healthy()) { await this.persist(); this.publish(); return; }
    if (await this.services.sweep()) { this.options.log('Stopped the idle account service.'); await this.persist(); this.publish(); return; }
    if (Date.now() - this.accountReadAt > (this.options.accountCheckMs ?? 15 * 60_000)) {
      await this.refreshAccount(true);
      if (this.account.stored === false) { this.options.log('No stored account any more; stopping the account service.'); await this.services.stopAll(); await this.persist(); }
      this.publish();
    }
  }

  private publish(): void {
    const state = this.state();
    for (const listener of this.stateListeners) listener(state);
  }

  /** The signed-in account names the runtime's offline identity cache; read-only, never a sign-in. */
  private async refreshAccount(force = false): Promise<void> {
    const binary = this.backend.current.binaryPath;
    if (!binary || !this.backend.current.capabilities.account) { this.account = { stored: null }; return; }
    if (!force && Date.now() - this.accountReadAt < (this.options.accountCheckMs ?? 15 * 60_000) && this.account.stored === true) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const result = await readAccount(binary, controller.signal);
      const line = result.output.split('\n').map(entry => entry.trim()).reverse().find(entry => entry.startsWith('{'));
      const parsed = JSON.parse(line ?? '') as { stored?: unknown; username?: unknown };
      this.account = parsed.stored === true && typeof parsed.username === 'string' && parsed.username.trim() ? { stored: true, username: parsed.username.trim() } : { stored: false };
      this.accountReadAt = Date.now();
      this.accountError = undefined;
    } catch (error) {
      this.accountError = (error as Error).message;
      this.options.log(`Account read failed: ${this.accountError}`);
      this.account = { stored: null };
    } finally { clearTimeout(timer); }
  }

  /** The license cache for the launch, after the same revocation checks the launcher makes. */
  private async offlineLicenseCache(): Promise<string | undefined> {
    const root = path.dirname(this.store.settings.runtimeRoot);
    if (await offlineAccessRevoked(root)) await revokeOfflineAccess(root);
    await assertOfflineAccessReady(root);
    return this.backend.current.capabilities.licenseCache ? licenseCacheDirectory(root) : undefined;
  }

  private requireBackend(command: 'run'): string {
    const status = this.backend.current;
    if (!status.available || !status.binaryPath) throw new DaemonError('backend-unavailable', 'The Xodus backend is unavailable.');
    if (!status.capabilities[command]) throw new DaemonError('backend-unavailable', `The active Xodus backend does not support the ${command} command.`);
    return status.binaryPath;
  }

  /**
   * Starts or unlocks the session wallet the way the launcher does, so a Steam
   * launch stays on the daemon path; only a wallet that still is not ready
   * (a password prompt that needs the launcher window) hands over to Electron.
   */
  private async checkWallet(): Promise<void> {
    const keyring = new KeyringSupport(this.clientEnvironment, undefined, process.platform, undefined, this.walletActions());
    let status = await keyring.check();
    if (!status.gameMode || status.state === 'ready' || status.state === 'unavailable') return;
    this.options.log(`The system wallet is ${status.state}; starting it for this session.`);
    status = await keyring.start();
    if (status.state === 'ready') { this.options.log('The system wallet is ready.'); return; }
    throw new DaemonError('wallet-locked', `The system wallet is not ready (${status.state}). Open Nexus once to unlock it.`);
  }

  private walletActions(): KeyringActions {
    const commands = () => this.backend.current.capabilities.commands;
    const binary = () => this.backend.current.binaryPath;
    return {
      startProvider: (provider, environment, owned) => startSessionKeyring(provider, environment, owned,
        commands().includes('keyring-session-stop') ? binary() : undefined),
      canUnlock: () => Boolean(binary()) && commands().includes('keyring-unlock'),
      // No launcher window to parent the provider's dialog; an empty-password wallet needs none.
      unlock: () => { const path = binary(); return path ? this.walletUnlocker.unlock(path) : Promise.resolve('unavailable'); },
    };
  }

  /** The launch re-inspected the install; Electron persists what changed. */
  private captureInspection(gameId: string): DaemonState['inspected'] {
    const game = this.store.games.find(entry => entry.id === gameId);
    if (!game) return undefined;
    const patch: Partial<Game> = { installState: game.installState, installMessage: game.installMessage, executable: game.executable, antiCheat: game.antiCheat, vcRedistEncrypted: game.vcRedistEncrypted, storeId: game.storeId };
    return { gameId, patch };
  }
}

export type { GameOperation };
