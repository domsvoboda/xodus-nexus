import type { Game } from '../shared/types.js';
import { LINUX_RUN_PATCH } from './backend.js';

/** The prepared runner owns WINEPREFIX and runtime libraries, even without tools. */
export function preparedGameWine(runner: { command: string; launchCommand?: string } | undefined, fallback: string): string {
  return runner?.launchCommand ?? runner?.command ?? fallback;
}

/** One package launch policy. Runtime/backend, never title names, own compatibility. */
export function gameLaunchArguments(
  game: Pick<Game, 'path' | 'executable'>,
  wine: string,
  market: string,
  backendPatch: string | undefined,
  licenseCache?: string,
  offline = false,
): string[] {
  if (backendPatch !== LINUX_RUN_PATCH) {
    throw new Error('Play requires the current managed Xodus backend. Update the backend in Settings.');
  }
  if (!game.executable?.trim()) throw new Error('The package manifest has no launch executable.');
  const args = ['run', game.path, wine, '--exe', game.executable, '--materialize-chain'];
  if (market) args.push('--market', market);
  // Only backends advertising the flag receive it; older ones keep online-only launches.
  if (licenseCache) args.push('--license-cache', licenseCache);
  // The launcher already found Microsoft unreachable: the backend skips its
  // online steps instead of waiting for each connect timeout in turn.
  if (offline) args.push('--offline');
  return args;
}
