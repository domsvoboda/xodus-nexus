import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { stripAnsi } from '../shared/utils.js';
import { externalLauncherEnvironment } from './launcher-environment.js';
import { observeBackendCommand } from './backend-diagnostics.js';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onLine?: (line: string) => void;
  maxOutput?: number;
  /** Keep structured stdout separate from stderr diagnostics; line callbacks still see both. */
  stdoutOnly?: boolean;
  /** Give a game its own Linux process group; downloads retain their defaults. */
  detached?: boolean;
  /** Optional bounded drain after the child exits but inherited pipes stay open. */
  outputDrainMs?: number;
}

export interface RunResult {
  code: number;
  output: string;
}

/** Short backend reads that renew account tickets while they run. */
const ACCOUNT_READS = new Set(['profile', 'library', 'achievements', 'account', 'activity', 'subscription', 'social', 'friends']);
const accountReads = new Set<Promise<unknown>>();

/** Waits for running account reads, so an account switch cannot overlap their ticket renewals. */
export async function waitForAccountReads(timeoutMs = 25_000): Promise<void> {
  if (!accountReads.size) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled([...accountReads]),
    new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); }),
  ]);
  if (timer) clearTimeout(timer);
}

export function spawnTracked(command: string, args: string[], options: RunOptions = {}): {
  child: ChildProcessWithoutNullStreams;
  result: Promise<RunResult>;
} {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: externalLauncherEnvironment(options.env),
    shell: false,
    detached: options.detached ?? false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  observeBackendCommand(child, command, args);
  const chunks: string[] = [];
  const max = options.maxOutput ?? 2_000_000;
  let chunksLength = 0;
  const readers: { consume: (chunk: Buffer) => void; finish: () => void }[] = [];
  const reader = (stdout: boolean) => {
    let buffered = '';
    const decoder = new StringDecoder('utf8');
    const consume = (chunk: Buffer) => {
    // Escape sequences and UTF-8 characters can straddle pipe reads. Split
    // complete terminal frames first, then remove ANSI, not per raw chunk.
    const text = decoder.write(chunk);
    buffered += text;
    const lines = buffered.split(/[\r\n]/);
    buffered = lines.pop() ?? '';
    for (const raw of lines) {
      const line = stripAnsi(raw).trimEnd();
      if (line) options.onLine?.(line);
    }
    if (buffered.length > 64_000) buffered = buffered.slice(-64_000);
    if (stdout || !options.stdoutOnly) {
      const clean = stripAnsi(text);
      chunks.push(clean);
      chunksLength += clean.length;
      while (chunksLength > max && chunks.length > 1) chunksLength -= chunks.shift()!.length;
    }
    };
    const result = { consume, finish: () => {
      buffered += decoder.end();
      if (buffered.trim()) options.onLine?.(stripAnsi(buffered).trimEnd());
      buffered = '';
    } };
    readers.push(result); return result;
  };
  child.stdout.on('data', reader(true).consume);
  child.stderr.on('data', reader(false).consume);
  const result = new Promise<RunResult>((resolve, reject) => {
    let finished = false;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      if (drain) clearTimeout(drain);
      readers.forEach(reader => reader.finish());
      resolve({ code: code ?? -1, output: chunks.join('') });
    };
    child.once('error', (error) => {
      finished = true;
      if (drain) clearTimeout(drain);
      reject(error);
    });
    child.once('exit', (code) => {
      if (options.outputDrainMs === undefined || finished) return;
      drain = setTimeout(() => {
        // Only selected callers opt in. An inherited pipe is not evidence that
        // its original process is still alive; retain the real exit status.
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
        finish(code);
      }, options.outputDrainMs);
    });
    child.once('close', (code) => {
      finish(code);
    });
  });
  if (ACCOUNT_READS.has(args[0] ?? '')) {
    const settled = result.then(() => undefined, () => undefined);
    accountReads.add(settled);
    void settled.then(() => accountReads.delete(settled));
  }
  return { child, result };
}

export async function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return spawnTracked(command, args, options).result;
}
