import os from 'node:os';
import path from 'node:path';
import type { ConnectivityStatus, Game, GameOperation } from '../shared/types.js';
import type { DaemonErrorCode, DaemonState } from '../shared/daemon-protocol.js';
import { StateStore } from '../main/store.js';
import { BackendManager } from '../main/backend.js';
import { RuntimeManager } from '../main/runtime.js';
import { ConnectivityMonitor } from '../main/connectivity.js';
import { KeyringSupport } from '../main/keyring.js';
import { GameSession, type ActiveGame } from '../main/game-session.js';
import { WarmServiceSessions } from '../main/service-sessions.js';
import { readAccount } from '../main/account-refresh.js';
import { closeGracefully, type Closable } from './graceful.js';
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

type Running = { kind: 'launched'; active: ActiveGame } | { kind: 'adopted'; game: AdoptedGame; finished: Promise<void> };

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
  private clientEnvironment: NodeJS.ProcessEnv = {};
  private preparing = false;
  private running: Running | undefined;
  private ownerId: string | undefined;
  private cancelWhenStarted = false;
  private closing = false;
  private inspected: DaemonState['inspected'];
  private lastBackendRefresh = 0;
  private account: { stored: boolean | null; username?: string } = { stored: null };
  private accountReadAt = 0;
  private accountError: string | undefined;
  private orphanTimer: ReturnType<typeof setTimeout> | undefined;
  private maintenance: ReturnType<typeof setInterval> | undefined;
  private readonly stateListeners = new Set<(state: DaemonState) => void>();
  private readonly logListeners = new Set<(operationId: string, line: string) => void>();
  private readonly exitListeners = new Set<(operationId: string, code: number | null, status: 'complete' | 'failed') => void>();

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
      onChange: () => this.publish(),
      onLog: (operationId, line) => { for (const listener of this.logListeners) listener(operationId, line); },
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
    if (this.maintenance) clearInterval(this.maintenance);
    if (this.orphanTimer) clearTimeout(this.orphanTimer);
    this.connectivity.stop();
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
    };
  }

  onState(listener: (state: DaemonState) => void): () => void { this.stateListeners.add(listener); return () => this.stateListeners.delete(listener); }
  onLog(listener: (operationId: string, line: string) => void): () => void { this.logListeners.add(listener); return () => this.logListeners.delete(listener); }
  onExit(listener: (operationId: string, code: number | null, status: 'complete' | 'failed') => void): () => void { this.exitListeners.add(listener); return () => this.exitListeners.delete(listener); }

  async launch(request: LaunchRequest, ownerId?: string): Promise<{ operationId: string }> {
    if (this.busy) throw new DaemonError('busy', 'Another game is already starting or running.');
    this.preparing = true;
    this.ownerId = ownerId;
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
      await this.refreshAccount();
      // The close helper finds the game's windows by this id (see recovery.ts and graceful.ts).
      this.clientEnvironment = { ...request.env, XODUS_NEXUS_LAUNCH_ID: `game-${request.gameId}` };
      this.inspected = undefined;
      const active = await this.session.launch(request.gameId);
      this.running = { kind: 'launched', active };
      this.inspected = this.captureInspection(active.gameId);
      await this.persist();
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
    if (running.kind === 'launched') { await this.session.cancel(); return; }
    running.game.operation.status = 'stopping';
    running.game.operation.phase = 'Stopping Xodus and Wine…';
    this.publish();
    await running.game.stop();
    setTimeout(() => { if (this.running === running) void running.game.forceStop().catch(error => this.options.log(`Force stop failed: ${(error as Error).message}`)); }, 8_000).unref?.();
  }

  /** A reconnecting client takes ownership of the running game it names. */
  attach(operationId: string, ownerId: string): boolean {
    const current = this.running?.kind === 'launched' ? this.running.active.operationId : this.running?.game.operation.id;
    if (!current || current !== operationId) return false;
    this.ownerId = ownerId;
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
    operation.phase = 'Closing the game…';
    this.publish();
    this.options.log(`Closing ${operation.title}: ${reason}.`);
    const outcome = await closeGracefully(game, operation.id, {
      helper: this.options.closeHelper, env: running.kind === 'launched' ? this.clientEnvironment : running.game.record.env,
      log: line => { this.options.log(line); for (const listener of this.logListeners) listener(operation.id, line); },
    });
    this.options.log(`${operation.title} ${outcome === 'closed' ? 'closed on request' : outcome === 'stopped' ? 'stopped on interrupt' : 'was forced to stop'}.`);
  }

  private finished(ownerId: string | undefined): void {
    this.running = undefined;
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
        const finished = game.result.then(async () => {
          for (const listener of this.exitListeners) listener(game.operation.id, null, 'complete');
          game.dispose();
          await this.services.sweep().catch(() => undefined);
        });
        this.running = { kind: 'adopted', game, finished };
        void finished.finally(() => this.finished(undefined));
        this.options.log(`Re-attached to the running game ${record.game.title}; waiting for its Steam client to reconnect.`);
        this.orphanTimer = setTimeout(() => { if (this.running === this.running && !this.ownerId) void this.close('no Steam client reclaimed it after the restart'); }, this.options.orphanGraceMs ?? 60_000);
        this.orphanTimer.unref?.();
      } else this.options.log(`The previous game ${record.game.title} is no longer running.`);
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    const record: SessionRecord = { schema: 1 };
    const running = this.running;
    const pgid = running?.kind === 'launched' ? running.active.process.child.pid : undefined;
    if (running?.kind === 'launched' && pgid) {
      const { active } = running;
      record.game = {
        operationId: active.operationId, gameId: active.gameId, title: active.operation.title, pgid,
        logPath: active.operation.logPath, startedAt: active.operation.startedAt, stopPrefix: active.stopPrefix,
        env: Object.fromEntries(Object.entries(this.clientEnvironment).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      };
    } else if (running?.kind === 'adopted') record.game = running.game.record;
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

  private requireBackend(command: 'run'): string {
    const status = this.backend.current;
    if (!status.available || !status.binaryPath) throw new DaemonError('backend-unavailable', 'The Xodus backend is unavailable.');
    if (!status.capabilities[command]) throw new DaemonError('backend-unavailable', `The active Xodus backend does not support the ${command} command.`);
    return status.binaryPath;
  }

  private async checkWallet(): Promise<void> {
    const status = await new KeyringSupport(this.clientEnvironment).check();
    if (!status.gameMode || status.state === 'ready' || status.state === 'unavailable') return;
    throw new DaemonError('wallet-locked', `The system wallet is not ready (${status.state}). Open Nexus once to unlock it.`);
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
