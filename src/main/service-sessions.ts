import { socketReady, startXodusService, type XodusServiceSession } from './xodus-service.js';

/** A service session handed to one game launch; `release` returns it to its owner. */
export interface AcquiredService extends XodusServiceSession {
  release(): Promise<void>;
}

export interface ServiceSessionStatus {
  warm: boolean;
  startedAt?: string;
  lastUsedAt?: string;
}

/**
 * Who owns `xodus-service` lifetimes. The launcher starts one per game and
 * stops it afterwards; the background daemon keeps a warm session instead.
 */
export interface ServiceSessions {
  acquire(backendBinary: string, userData: string, onStatus: (message: string) => void, signal?: AbortSignal): Promise<AcquiredService>;
}

/** Today's behaviour: a fresh service per launch, stopped when the game exits. */
export class EphemeralServiceSessions implements ServiceSessions {
  constructor(private readonly start: typeof startXodusService = startXodusService) {}

  async acquire(backendBinary: string, userData: string, onStatus: (message: string) => void, signal?: AbortSignal): Promise<AcquiredService> {
    const session = await this.start(backendBinary, userData, onStatus, signal);
    return { ...session, release: () => session.stop() };
  }
}

export const WARM_SESSION_IDLE_MS = 30 * 60_000;

interface WarmEntry { session: XodusServiceSession; binary: string; startedAt: string; lastUsedAt: string; inUse: number }

/**
 * The daemon's warm session: one signed-in `xodus-service` reused across
 * launches, so a Play after the first skips the sign-in wait. It is stopped
 * after `idleMs` without a game, when the backend binary changes, or when its
 * socket stops answering.
 */
export class WarmServiceSessions implements ServiceSessions {
  private entry: WarmEntry | undefined;
  private starting: Promise<WarmEntry> | undefined;

  constructor(
    private readonly options: { idleMs?: number; now?: () => number; start?: typeof startXodusService; ready?: typeof socketReady; log?: (line: string) => void } = {},
  ) {}

  get status(): ServiceSessionStatus {
    return this.entry ? { warm: true, startedAt: this.entry.startedAt, lastUsedAt: this.entry.lastUsedAt } : { warm: false };
  }

  /** The live session's socket, for daemon-side requests such as update checks. */
  get socketPath(): string | undefined { return this.entry?.session.socketPath; }
  get current(): XodusServiceSession | undefined { return this.entry?.session; }
  get binary(): string | undefined { return this.entry?.binary; }

  async acquire(backendBinary: string, userData: string, onStatus: (message: string) => void, signal?: AbortSignal): Promise<AcquiredService> {
    const entry = await this.obtain(backendBinary, userData, onStatus, signal);
    entry.inUse++;
    entry.lastUsedAt = this.stamp();
    let released = false;
    return {
      ...entry.session,
      stop: () => this.stopAll(),
      release: async () => {
        if (released) return;
        released = true;
        entry.inUse = Math.max(0, entry.inUse - 1);
        entry.lastUsedAt = this.stamp();
      },
    };
  }

  /** Takes over a session that outlived a previous daemon process. */
  adopt(session: XodusServiceSession, binary: string, startedAt: string): void {
    this.entry = { session, binary, startedAt, lastUsedAt: this.stamp(), inUse: 0 };
  }

  /** Stops a session nobody has used for `idleMs`; returns true when it did. */
  async sweep(): Promise<boolean> {
    const entry = this.entry;
    if (!entry || entry.inUse > 0) return false;
    const idle = (this.options.now ?? Date.now)() - Date.parse(entry.lastUsedAt);
    if (idle < (this.options.idleMs ?? WARM_SESSION_IDLE_MS)) return false;
    await this.stopAll();
    return true;
  }

  /** Confirms the socket still answers; a dead service is forgotten. */
  async healthy(): Promise<boolean> {
    const entry = this.entry;
    if (!entry) return false;
    if (await (this.options.ready ?? socketReady)(entry.session.socketPath)) return true;
    this.options.log?.('The warm account service stopped answering; it will be restarted on the next launch.');
    this.entry = undefined;
    await entry.session.stop().catch(() => undefined);
    return false;
  }

  async stopAll(): Promise<void> {
    const entry = this.entry;
    this.entry = undefined;
    if (entry) await entry.session.stop();
  }

  private async obtain(binary: string, userData: string, onStatus: (message: string) => void, signal?: AbortSignal): Promise<WarmEntry> {
    if (this.starting) return this.starting;
    const entry = this.entry;
    if (entry) {
      if (entry.binary === binary && await (this.options.ready ?? socketReady)(entry.session.socketPath)) {
        onStatus('Reusing the warm Xodus account service.');
        return entry;
      }
      this.options.log?.(entry.binary === binary ? 'The warm account service is gone; starting a new one.' : 'The backend changed; restarting the account service.');
      this.entry = undefined;
      await entry.session.stop().catch(() => undefined);
    }
    this.starting = (this.options.start ?? startXodusService)(binary, userData, onStatus, signal).then(session => {
      const fresh: WarmEntry = { session, binary, startedAt: this.stamp(), lastUsedAt: this.stamp(), inUse: 0 };
      this.entry = fresh;
      return fresh;
    }).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private stamp(): string { return new Date((this.options.now ?? Date.now)()).toISOString(); }
}
