import { execFile } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

export const CLOSE_WAIT_MS = 30_000;
export const STOP_WAIT_MS = 8_000;

/** The process verbs a graceful close needs, as `GameProcess` provides them. */
export interface Closable {
  result: Promise<unknown>;
  stop(): Promise<void>;
  forceStop(): Promise<void>;
}

export interface GracefulOptions {
  /** `nexus-close-window` binary; undefined skips straight to signals. */
  helper?: string;
  env: NodeJS.ProcessEnv;
  log(line: string): void;
  closeWaitMs?: number;
  stopWaitMs?: number;
  run?: (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<number | null>;
}

const defaultRun = (file: string, args: string[], env: NodeJS.ProcessEnv) => new Promise<number | null>(resolve => {
  execFile(file, args, { env, timeout: 15_000, maxBuffer: 65_536 }, error => {
    if (!error) { resolve(0); return; }
    const code = (error as unknown as { code?: unknown }).code;
    resolve(typeof code === 'number' ? code : null);
  });
});

/** The helper shipped beside the launcher binary for this CPU, if the build carried one. */
export async function bundledCloseHelper(execPath = process.execPath, arch = process.arch): Promise<string | undefined> {
  const override = process.env.XODUS_NEXUS_CLOSE_HELPER;
  const candidates = override ? [override] : [path.join(path.dirname(execPath), 'resources', 'tools', arch === 'arm64' ? 'aarch64' : 'x86_64', 'nexus-close-window')];
  for (const candidate of candidates) {
    try { await fs.access(candidate, constants.X_OK); return candidate; }
    catch { /* Not bundled in this build. */ }
  }
  return undefined;
}

function settled(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([promise.then(() => true, () => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), ms))]);
}

/**
 * Asks the game to close like a user would (WM_CLOSE through the X11 helper),
 * so the Xbox runtime inside Wine uninitialises and flushes its cloud saves;
 * only then falls back to the interrupt and the prefix kill the launcher uses.
 */
export async function closeGracefully(game: Closable, launchId: string, options: GracefulOptions): Promise<'closed' | 'stopped' | 'forced'> {
  const run = options.run ?? defaultRun;
  if (options.helper) {
    const code = await run(options.helper, ['--launch-id', launchId, '--timeout-ms', '5000'], options.env);
    if (code === 0) {
      options.log('Asked the game window to close; waiting for the runtime to finish.');
      if (await settled(game.result, options.closeWaitMs ?? CLOSE_WAIT_MS)) return 'closed';
      options.log('The game did not close in time; interrupting it.');
    } else options.log(code === 1 ? 'No game window to close yet; interrupting the launch.' : `The close helper failed (exit ${code ?? 'unknown'}); interrupting the game.`);
  } else options.log('No close helper in this build; interrupting the game.');
  await game.stop().catch(error => options.log(`Interrupt failed: ${(error as Error).message}`));
  if (await settled(game.result, options.stopWaitMs ?? STOP_WAIT_MS)) return 'stopped';
  options.log('Forcing the game to stop.');
  await game.forceStop().catch(error => options.log(`Force stop failed: ${(error as Error).message}`));
  return 'forced';
}
