import { spawnTracked, type RunOptions, type RunResult } from './process.js';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, promises as fs } from 'node:fs';
import { externalLauncherEnvironment } from './launcher-environment.js';
import { observeBackendCommand } from './backend-diagnostics.js';
import { OutputTail } from './output-tail.js';

export interface GameLifecycle {
  /** Generated Proton runner control; its environment targets one game prefix. */
  stopPrefix?: { command: string; args: string[] };
  /**
   * Send the game's stdout and stderr to this file instead of pipes and follow
   * it. The daemon uses this so the game outlives the daemon without a broken
   * pipe, and a restarted daemon keeps reading the same output.
   */
  outputFile?: string;
}

export interface GameProcess {
  child: ChildProcess;
  result: Promise<RunResult>;
  stop(): Promise<void>;
  forceStop(): Promise<void>;
  cleanup(): Promise<void>;
}

export async function spawnGameProcess(
  command: string,
  args: string[],
  options: RunOptions,
  lifecycle: GameLifecycle = {},
): Promise<GameProcess> {
  const grouped = process.platform === 'linux';
  const tracked = lifecycle.outputFile ? await spawnToFile(command, args, options, grouped, lifecycle.outputFile) : spawnTracked(command, args, {
    ...options, detached: grouped,
    // The managed runner waits for this prefix's Wine processes. Only then is
    // it safe to stop waiting for pipes inherited by non-Wine helpers. Legacy
    // direct-Wine launches retain their previous output/lifetime behavior.
    outputDrainMs: lifecycle.stopPrefix ? 1_000 : options.outputDrainMs,
  });
  let prefixStop: Promise<void> | undefined;
  const signal = (kind: NodeJS.Signals) => {
    if (grouped && tracked.child.pid) {
      try { process.kill(-tracked.child.pid, kind); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    } else if (tracked.child.exitCode === null && tracked.child.signalCode === null) tracked.child.kill(kind);
  };
  const drainGroup = async () => {
    signal('SIGTERM');
    if (!grouped || !tracked.child.pid) return;
    const until = Date.now() + 1_000;
    while (Date.now() < until) {
      try { process.kill(-tracked.child.pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error; }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    signal('SIGKILL');
  };
  const stopPrefix = () => prefixStop ??= new Promise<void>((resolve, reject) => {
    if (!lifecycle.stopPrefix) { resolve(); return; }
    execFile(lifecycle.stopPrefix.command, lifecycle.stopPrefix.args, {
      env: externalLauncherEnvironment(options.env), timeout: 5_000, maxBuffer: 16_384,
    }, (error) => error ? reject(new Error(`Could not stop the game's Wine prefix: ${error.message}`)) : resolve());
  });
  return {
    ...tracked,
    stop: async () => { signal('SIGINT'); },
    forceStop: async () => {
      // Wine services detach from the launch process group. Stop only the
      // managed game prefix, never the user's default/global wineserver.
      try { await stopPrefix(); }
      finally { await drainGroup(); }
    },
    cleanup: drainGroup,
  };
}

/** `spawnTracked` with the output going to an append-mode file that is followed instead of piped. */
async function spawnToFile(command: string, args: string[], options: RunOptions, detached: boolean, file: string): Promise<{ child: ChildProcess; result: Promise<RunResult> }> {
  await fs.writeFile(file, '', { mode: 0o600 });
  const fd = openSync(file, 'a');
  let child: ChildProcess;
  try {
    child = spawn(command, args, { cwd: options.cwd, env: externalLauncherEnvironment(options.env), shell: false, detached, stdio: ['ignore', fd, fd] });
  } finally { closeSync(fd); }
  observeBackendCommand(child, command, args);
  const chunks: string[] = [];
  const max = options.maxOutput ?? 2_000_000;
  let length = 0;
  const tail = new OutputTail(file, line => {
    options.onLine?.(line);
    chunks.push(`${line}\n`);
    length += line.length + 1;
    while (length > max && chunks.length > 1) length -= chunks.shift()!.length;
  }, { from: 0 }).start();
  const result = new Promise<RunResult>((resolve, reject) => {
    child.once('error', error => { tail.stop(); reject(error); });
    child.once('exit', code => { void tail.drain().then(() => resolve({ code: code ?? -1, output: chunks.join('') })); });
  });
  return { child, result };
}
