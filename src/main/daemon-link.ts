import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { DaemonFrame, DaemonState } from '../shared/daemon-protocol.js';
import { DaemonConnection } from './daemon-client.js';

export interface DaemonLinkEvents {
  state: [DaemonState];
  connected: [boolean];
}

export interface DaemonLinkOptions {
  socketPath: string;
  version: string;
  /** Reconnect delays, in order; the last one repeats. */
  backoffMs?: number[];
  connect?: typeof DaemonConnection.connect;
}

/**
 * The launcher's standing connection to its background daemon: subscribes to
 * state, forwards launch and cancel requests and reconnects after the daemon
 * restarts or exits when idle. Never starts the daemon by itself; a
 * socket-activated unit does that on connect.
 */
export class DaemonLink extends EventEmitter<DaemonLinkEvents> {
  private connection: DaemonConnection | undefined;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private current: DaemonState | undefined;
  /** The game this launcher owns; re-claimed after the daemon restarts. */
  private owned: string | undefined;
  private readonly connectImpl: typeof DaemonConnection.connect;

  constructor(private readonly options: DaemonLinkOptions) {
    super();
    this.connectImpl = options.connect ?? DaemonConnection.connect;
  }

  get connected(): boolean { return Boolean(this.connection?.open); }
  get state(): DaemonState | undefined { return this.current; }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    void this.tryConnect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.connection?.close();
    this.connection = undefined;
    this.current = undefined;
  }

  private async tryConnect(): Promise<void> {
    if (this.stopped || this.connection) return;
    try {
      const connection = await this.connectImpl(this.options.socketPath, 5_000);
      this.connection = connection;
      connection.on('frame', frame => this.receive(frame));
      connection.on('close', () => {
        if (this.connection === connection) this.connection = undefined;
        this.current = undefined;
        this.emit('connected', false);
        this.schedule();
      });
      connection.send({ schema: 1, type: 'hello', client: 'electron', version: this.options.version });
      connection.send({ schema: 1, type: 'subscribe' });
      // The daemon restarted under our game: claim it back before its orphan grace ends.
      if (this.owned) connection.send({ schema: 1, type: 'attach', operationId: this.owned });
      this.attempt = 0;
      this.emit('connected', true);
    } catch {
      this.schedule();
    }
  }

  private schedule(): void {
    if (this.stopped || this.timer) return;
    const delays = this.options.backoffMs ?? [1_000, 2_000, 5_000, 15_000, 30_000];
    const delay = delays[Math.min(this.attempt++, delays.length - 1)];
    this.timer = setTimeout(() => { this.timer = undefined; void this.tryConnect(); }, delay);
    this.timer.unref?.();
  }

  private receive(frame: DaemonFrame): void {
    if (frame.type === 'hello' || frame.type === 'state') {
      this.current = frame.state;
      const operation = frame.state.gameOperation;
      if (this.owned && (!operation || operation.id !== this.owned || !['preparing', 'running', 'stopping'].includes(operation.status))) this.owned = undefined;
      this.emit('state', frame.state);
    }
  }

  /**
   * Asks the daemon to run the game; resolves with its operation id once
   * accepted. With `own`, the daemon closes the game when this launcher goes
   * away (Game Mode, where Steam's Exit game ends Nexus).
   */
  async launch(gameId: string, env: Record<string, string>, own = false): Promise<string> {
    const connection = this.require();
    const requestId = randomUUID();
    const answer = connection.next((frame): frame is DaemonFrame & { type: 'accepted' | 'error' } =>
      (frame.type === 'accepted' || frame.type === 'error') && frame.requestId === requestId, 120_000);
    connection.send({ schema: 1, type: 'launch', requestId, gameId, env, attach: own });
    const frame = await answer;
    if (frame.type === 'error') throw new Error(frame.message);
    if (own) this.owned = frame.operationId;
    return frame.operationId;
  }

  async cancel(): Promise<void> {
    const connection = this.require();
    const requestId = randomUUID();
    const answer = connection.next((frame): frame is DaemonFrame & { type: 'error' | 'state' } =>
      (frame.type === 'error' && frame.requestId === requestId) || frame.type === 'state', 15_000);
    connection.send({ schema: 1, type: 'cancel', requestId });
    const frame = await answer;
    if (frame.type === 'error') throw new Error(frame.message);
  }

  /** The daemon exits once idle; socket activation starts the updated build next time. */
  reload(): void {
    try { this.connection?.send({ schema: 1, type: 'reload' }); }
    catch { /* Not connected: nothing to reload. */ }
  }

  private require(): DaemonConnection {
    if (!this.connection?.open) throw new Error('The Nexus background service is not connected.');
    return this.connection;
  }
}
