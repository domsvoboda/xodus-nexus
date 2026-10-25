import { startXodusService, type XodusServiceSession } from './xodus-service.js';

/** A service session handed to one game launch; `release` returns it to its owner. */
export interface AcquiredService extends XodusServiceSession {
  release(): Promise<void>;
}

/**
 * Who owns `xodus-service` lifetimes. The launcher starts one per game and
 * stops it afterwards; a background daemon can keep a warm session instead.
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
