import { createConnection } from 'node:net';
import type { ConnectivityStatus } from '../shared/types.js';

/** The first hosts a launch contacts: Microsoft account tickets and Xbox tokens. */
export const CONNECTIVITY_HOSTS = ['login.live.com', 'xsts.auth.xboxlive.com'];
export const PROBE_TIMEOUT_MS = 3_000;
const REFRESH_INTERVAL_MS = 30_000;
const FRESH_FOR_MS = 10_000;

export type HostProbe = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

/**
 * TCP reachability of one host: true once the connection is established. DNS
 * failures, refused or unreachable connects and a hung connect (a LAN without
 * a route to the internet) are all false. Nothing is sent.
 */
export function probeHost(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection({ host, port });
    // Socket inactivity alone does not bound a stalled DNS lookup.
    const deadline = setTimeout(() => finish(false), timeoutMs);
    deadline.unref?.();
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * Conservative verdict: offline only when no network interface is up or every
 * probed host is unreachable. A single reachable host keeps the online path,
 * which refreshes licenses and tokens; a wrong "offline" would skip both.
 */
export function classifyConnectivity(interfaceOnline: boolean, reachable: boolean[], checkedAt: string): ConnectivityStatus {
  if (!interfaceOnline) return { state: 'offline', checkedAt, reason: 'No network interface is connected.' };
  if (!reachable.length) return { state: 'unknown', checkedAt };
  if (reachable.some(Boolean)) return { state: 'online', checkedAt };
  return { state: 'offline', checkedAt, reason: `Microsoft sign-in hosts did not answer within ${PROBE_TIMEOUT_MS / 1000} seconds.` };
}

export interface ConnectivityMonitorOptions {
  /** Electron's `net.isOnline()`: false when no interface is up. */
  interfaceOnline: () => boolean;
  probe?: HostProbe;
  hosts?: string[];
  onChange?: () => void;
  now?: () => number;
  intervalMs?: number;
}

/**
 * Keeps a recent reachability verdict for the launcher. The header shows it
 * and a launch consults it before spawning the backend, so an offline launch
 * skips the online steps instead of waiting for each of their timeouts.
 */
export class ConnectivityMonitor {
  current: ConnectivityStatus = { state: 'unknown' };
  private readonly probe: HostProbe;
  private readonly hosts: string[];
  private readonly interfaceOnline: () => boolean;
  private readonly onChange: () => void;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<ConnectivityStatus> | undefined;
  private checkedAtMs = 0;

  constructor(options: ConnectivityMonitorOptions) {
    this.probe = options.probe ?? probeHost;
    this.hosts = options.hosts ?? CONNECTIVITY_HOSTS;
    this.interfaceOnline = options.interfaceOnline;
    this.onChange = options.onChange ?? (() => {});
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? REFRESH_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    void this.check(true);
    this.timer = setInterval(() => { void this.check(true); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The current verdict, re-probed when it is older than ten seconds or forced. */
  async check(force = false): Promise<ConnectivityStatus> {
    if (this.pending) return this.pending;
    if (!force && this.current.state !== 'unknown' && this.now() - this.checkedAtMs < FRESH_FOR_MS) return this.current;
    this.pending = this.refresh().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async refresh(): Promise<ConnectivityStatus> {
    let interfaceOnline = true;
    try { interfaceOnline = this.interfaceOnline(); } catch { /* Treat an unavailable answer as "an interface may be up". */ }
    const reachable = interfaceOnline
      ? await Promise.all(this.hosts.map(host => this.probe(host, 443, PROBE_TIMEOUT_MS).catch(() => false)))
      : [];
    const checkedAtMs = this.now();
    const next = classifyConnectivity(interfaceOnline, reachable, new Date(checkedAtMs).toISOString());
    const changed = next.state !== this.current.state;
    this.current = next;
    this.checkedAtMs = checkedAtMs;
    if (changed) this.onChange();
    return next;
  }
}
