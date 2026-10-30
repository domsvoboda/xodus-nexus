import { spawnTracked, type RunResult } from './process.js';

/** Read-only account status, never an interactive sign-in or token renewal. */
export async function readAccount(binary: string, signal: AbortSignal): Promise<RunResult> {
  signal.throwIfAborted();
  // Keyring helpers may outlive this read and inherit its output pipes.
  // Drain only after the actual CLI exits, preserving its status and response.
  const tracked = spawnTracked(binary, ['account', '--json'], { maxOutput: 20_000, stdoutOnly: true, outputDrainMs: 250 });
  tracked.child.stdin.end();
  const stop = () => { tracked.child.kill('SIGKILL'); };
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  const timer = setTimeout(stop, 15_000); timer.unref();
  try { return await tracked.result; }
  finally { clearTimeout(timer); signal.removeEventListener('abort', stop); }
}

/** Share same-identity reads and prevent obsolete reads from publishing state. */
export class AccountRefresh {
  private generation = 0;
  private pending?: { key: string; job: Promise<void>; controller: AbortController };

  invalidate(): void { this.generation++; this.pending?.controller.abort(); this.pending = undefined; }

  run<T>(key: string, read: (signal: AbortSignal) => Promise<T>, publish: (value: T) => Promise<void>, current: () => boolean): Promise<void> {
    if (this.pending?.key === key) return this.pending.job;
    this.invalidate();
    const generation = ++this.generation;
    const controller = new AbortController();
    const job = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return read(controller.signal); }).then(async value => {
      if (generation === this.generation && current()) await publish(value);
    }).catch(error => {
      if (generation === this.generation && current()) throw error;
    }).finally(() => { if (this.pending?.job === job) this.pending = undefined; });
    this.pending = { key, job, controller };
    return job;
  }
}
