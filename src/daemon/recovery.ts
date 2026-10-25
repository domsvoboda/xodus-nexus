import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GameOperation } from '../shared/types.js';
import { socketReady, startXodusBridge, type XodusServiceSession } from '../main/xodus-service.js';
import type { Closable } from './graceful.js';

/** What a restarted daemon needs to pick up a game and a service it did not spawn. */
export interface SessionRecord {
  schema: 1;
  game?: {
    operationId: string;
    gameId: string;
    title: string;
    pgid: number;
    logPath?: string;
    startedAt: string;
    stopPrefix?: { command: string; args: string[] };
    env: Record<string, string>;
  };
  service?: {
    pid: number;
    socketPath: string;
    bridgePort: number;
    bridgeKey: string;
    runtimeDir?: string;
    binary: string;
    startedAt: string;
  };
}

/** `state.json` beside the socket: rewritten atomically on every change, removed on a clean exit. */
export class SessionStateFile {
  constructor(readonly file: string) {}

  async read(): Promise<SessionRecord | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as SessionRecord;
      return parsed && parsed.schema === 1 ? parsed : undefined;
    } catch { return undefined; }
  }

  async write(record: SessionRecord): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}`;
    try {
      await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, this.file);
    } finally { await fs.rm(temporary, { force: true }); }
  }

  async remove(): Promise<void> { await fs.rm(this.file, { force: true }); }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** The process belongs to this user and still carries the launch id we gave it. */
export async function processCarries(pid: number, variable: string, value: string): Promise<boolean> {
  try {
    const stat = await fs.stat(`/proc/${pid}`);
    if (process.getuid && stat.uid !== process.getuid()) return false;
    const environ = await fs.readFile(`/proc/${pid}/environ`);
    return environ.toString('utf8').split('\0').includes(`${variable}=${value}`);
  } catch { return false; }
}

/** Members of a process group, from /proc; empty when none is left. */
async function groupMembers(pgid: number): Promise<number[]> {
  const members: number[] = [];
  let entries: string[];
  try { entries = await fs.readdir('/proc'); } catch { return members; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = await fs.readFile(`/proc/${entry}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === pgid) members.push(Number(entry));
    } catch { /* Exited meanwhile. */ }
  }
  return members;
}

/**
 * A game the previous daemon spawned. It cannot be `wait`ed, so its exit is
 * polled; stopping uses the process group and the stored prefix control, the
 * same verbs the launcher's `GameProcess` offers.
 */
export class AdoptedGame implements Closable {
  readonly operation: GameOperation;
  readonly result: Promise<{ code: number | null; output: string }>;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(readonly record: NonNullable<SessionRecord['game']>, private readonly pollMs = 500) {
    this.operation = {
      id: record.operationId, gameId: record.gameId, title: record.title, kind: 'launch', status: 'running',
      phase: 'Re-attached to the running game after the background service restarted.', log: [], logPath: record.logPath, startedAt: record.startedAt,
    };
    let finish!: (result: { code: number | null; output: string }) => void;
    this.result = new Promise(resolve => { finish = resolve; });
    this.timer = setInterval(() => {
      if (alive(this.record.pgid)) return;
      void groupMembers(this.record.pgid).then(members => {
        if (members.length) return;
        clearInterval(this.timer);
        this.operation.status = this.operation.status === 'stopping' ? 'complete' : 'complete';
        this.operation.phase = 'The game has exited.';
        this.operation.finishedAt = new Date().toISOString();
        finish({ code: null, output: '' });
      });
    }, pollMs);
    this.timer.unref?.();
  }

  /** Verifies the leader is alive, ours, and carries the launch id before adopting. */
  static async verify(record: NonNullable<SessionRecord['game']>): Promise<boolean> {
    if (!alive(record.pgid)) return false;
    if (await processCarries(record.pgid, 'XODUS_NEXUS_LAUNCH_ID', record.operationId)) return true;
    for (const pid of await groupMembers(record.pgid)) if (await processCarries(pid, 'XODUS_NEXUS_LAUNCH_ID', record.operationId)) return true;
    return false;
  }

  private signal(kind: NodeJS.Signals): void {
    try { process.kill(-this.record.pgid, kind); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }

  async stop(): Promise<void> { this.signal('SIGINT'); }

  async forceStop(): Promise<void> {
    const control = this.record.stopPrefix;
    if (control) {
      await new Promise<void>(resolve => execFile(control.command, control.args, { env: this.record.env, timeout: 5_000, maxBuffer: 16_384 }, () => resolve()));
    }
    this.signal('SIGTERM');
    const until = Date.now() + 1_000;
    while (Date.now() < until) {
      if (!alive(this.record.pgid) && !(await groupMembers(this.record.pgid)).length) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    this.signal('SIGKILL');
  }

  dispose(): void { clearInterval(this.timer); }
}

/** Rebinds the loopback bridge a running game already uses to a service that outlived the daemon. */
export async function adoptService(record: NonNullable<SessionRecord['service']>): Promise<XodusServiceSession | undefined> {
  if (!alive(record.pid) || !await socketReady(record.socketPath)) return undefined;
  let bridge: Awaited<ReturnType<typeof startXodusBridge>>;
  try { bridge = await startXodusBridge(record.socketPath, { port: record.bridgePort, key: record.bridgeKey }); }
  catch { return undefined; }
  let stopped = false;
  return {
    socketPath: record.socketPath, bridgePort: bridge.port, bridgeKey: bridge.key, pid: record.pid, runtimeDir: record.runtimeDir, startedAt: record.startedAt,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await bridge.stop();
      try { process.kill(record.pid, 'SIGINT'); } catch { /* Already gone. */ }
      const until = Date.now() + 4_000;
      while (Date.now() < until && alive(record.pid)) await new Promise(resolve => setTimeout(resolve, 100));
      if (alive(record.pid)) { try { process.kill(record.pid, 'SIGTERM'); } catch { /* Already gone. */ } }
      if (record.runtimeDir) await fs.rm(record.runtimeDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
