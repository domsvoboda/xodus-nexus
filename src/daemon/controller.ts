import os from 'node:os';
import path from 'node:path';
import type { ConnectivityStatus, Game } from '../shared/types.js';
import type { DaemonErrorCode, DaemonState } from '../shared/daemon-protocol.js';
import { StateStore } from '../main/store.js';
import { BackendManager } from '../main/backend.js';
import { RuntimeManager } from '../main/runtime.js';
import { ConnectivityMonitor } from '../main/connectivity.js';
import { KeyringSupport } from '../main/keyring.js';
import { GameSession, type ActiveGame } from '../main/game-session.js';
import { EphemeralServiceSessions } from '../main/service-sessions.js';
import { readAccount } from '../main/account-refresh.js';

export class DaemonError extends Error {
  constructor(readonly code: DaemonErrorCode, message: string) { super(message); this.name = 'DaemonError'; }
}

export interface LaunchRequest { gameId: string; env: Record<string, string>; cwd?: string }

export interface ControllerOptions {
  userData: string;
  home: string;
  log(line: string): void;
  /** Re-validate the backend binary at most this often between launches. */
  backendRefreshMs?: number;
}

/** A network interface besides loopback is up; Electron's `net.isOnline` equivalent. */
export function interfaceOnline(): boolean {
  return Object.values(os.networkInterfaces()).some(entries => entries?.some(entry => !entry.internal));
}

/**
 * The daemon's one game at a time: the launch core with daemon adapters (the
 * client's environment, a check-only wallet, no display inhibitor) plus
 * ownership of the game by the client connection that asked for it.
 */
export class GameController {
  readonly store: StateStore;
  readonly backend: BackendManager;
  readonly runtime: RuntimeManager;
  readonly connectivity: ConnectivityMonitor;
  private readonly session: GameSession;
  private clientEnvironment: NodeJS.ProcessEnv = {};
  private preparing = false;
  private ownerId: string | undefined;
  private cancelWhenStarted = false;
  private inspected: DaemonState['inspected'];
  private lastBackendRefresh = 0;
  private account: { stored: boolean | null; username?: string } = { stored: null };
  private accountReadAt = 0;
  private readonly stateListeners = new Set<(state: DaemonState) => void>();
  private readonly logListeners = new Set<(operationId: string, line: string) => void>();
  private readonly exitListeners = new Set<(operationId: string, code: number | null, status: 'complete' | 'failed') => void>();

  constructor(private readonly options: ControllerOptions) {
    this.store = new StateStore(options.userData);
    const emitLog = (scope: string, line: string) => options.log(`[${scope}] ${line}`);
    this.runtime = new RuntimeManager(this.store.settings.runtimeRoot, emitLog, () => this.busy);
    this.backend = new BackendManager(options.userData, this.store.settings.externalXodusRoot, emitLog, () => this.busy);
    this.connectivity = new ConnectivityMonitor({ interfaceOnline, onChange: () => this.publish() });
    const self = this;
    this.session = new GameSession({
      store: { get games() { return self.store.games; }, get downloads() { return self.store.downloads; }, get settings() { return self.store.settings; } },
      backend: () => this.backend.current,
      runtime: () => this.runtime.current,
      requireBackend: (command) => this.requireBackend(command),
      paths: { userData: options.userData, home: options.home },
      environment: () => this.clientEnvironment,
      connectivity: this.connectivity,
      account: () => this.account,
      ensureWallet: () => this.checkWallet(),
      displayGuard: () => () => {},
      services: new EphemeralServiceSessions(),
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
  }

  async stop(): Promise<void> {
    this.connectivity.stop();
    const active = this.session.running;
    if (!active) return;
    await this.session.cancel().catch(error => this.options.log(`Stop on shutdown failed: ${(error as Error).message}`));
    await Promise.race([active.finished, new Promise<void>(resolve => setTimeout(resolve, 20_000))]);
  }

  get busy(): boolean { return this.preparing || Boolean(this.session.running); }
  get running(): ActiveGame | undefined { return this.session.running; }
  get owner(): string | undefined { return this.ownerId; }

  state(): DaemonState {
    const operation = this.session.current;
    return {
      gameOperation: operation ? structuredClone(operation) : undefined,
      inspected: this.inspected,
      session: { warm: false },
      connectivity: this.connectivity.current as ConnectivityStatus,
    };
  }

  onState(listener: (state: DaemonState) => void): () => void { this.stateListeners.add(listener); return () => this.stateListeners.delete(listener); }
  onLog(listener: (operationId: string, line: string) => void): () => void { this.logListeners.add(listener); return () => this.logListeners.delete(listener); }
  onExit(listener: (operationId: string, code: number | null, status: 'complete' | 'failed') => void): () => void { this.exitListeners.add(listener); return () => this.exitListeners.delete(listener); }

  async launch(request: LaunchRequest, ownerId?: string): Promise<ActiveGame> {
    if (this.busy) throw new DaemonError('busy', 'Another game is already starting or running.');
    this.preparing = true;
    this.ownerId = ownerId;
    this.cancelWhenStarted = false;
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
      this.clientEnvironment = { ...request.env };
      this.inspected = undefined;
      const active = await this.session.launch(request.gameId);
      this.inspected = this.captureInspection(active.gameId);
      void active.result.catch(() => undefined).then(async () => {
        const operation = active.operation;
        const code = await active.result.then(result => result.code, () => null);
        for (const listener of this.exitListeners) listener(active.operationId, code, operation.status === 'failed' ? 'failed' : 'complete');
      });
      void active.finished.finally(() => { if (this.ownerId === ownerId) this.ownerId = undefined; this.publish(); });
      if (this.cancelWhenStarted) {
        this.cancelWhenStarted = false;
        void this.session.cancel().catch(error => this.options.log(`Stop after owner loss failed: ${(error as Error).message}`));
      }
      return active;
    } finally { this.preparing = false; this.publish(); }
  }

  async cancel(): Promise<void> {
    await this.session.cancel();
  }

  /** A reconnecting client takes ownership of the running game it names. */
  attach(operationId: string, ownerId: string): boolean {
    const active = this.session.running;
    if (!active || active.operationId !== operationId) return false;
    this.ownerId = ownerId;
    this.cancelWhenStarted = false;
    return true;
  }

  /** Steam killed the thin client: close its game, keep everything else alive. */
  ownerLost(ownerId: string): void {
    if (this.ownerId !== ownerId) return;
    this.ownerId = undefined;
    if (this.session.running) {
      this.options.log('The game\'s Steam client went away; stopping the game.');
      void this.session.cancel().catch(error => this.options.log(`Stop after owner loss failed: ${(error as Error).message}`));
    } else if (this.preparing) this.cancelWhenStarted = true;
  }

  private publish(): void {
    const state = this.state();
    for (const listener of this.stateListeners) listener(state);
  }

  /** The signed-in account names the runtime's offline identity cache; read-only, never a sign-in. */
  private async refreshAccount(): Promise<void> {
    const binary = this.backend.current.binaryPath;
    if (!binary || !this.backend.current.capabilities.account) { this.account = { stored: null }; return; }
    if (Date.now() - this.accountReadAt < 15 * 60_000 && this.account.stored === true) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const result = await readAccount(binary, controller.signal);
      const line = result.output.split('\n').map(entry => entry.trim()).reverse().find(entry => entry.startsWith('{'));
      const parsed = JSON.parse(line ?? '') as { stored?: unknown; username?: unknown };
      this.account = parsed.stored === true && typeof parsed.username === 'string' && parsed.username.trim() ? { stored: true, username: parsed.username.trim() } : { stored: false };
      this.accountReadAt = Date.now();
    } catch (error) {
      this.options.log(`Account read failed: ${(error as Error).message}`);
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

