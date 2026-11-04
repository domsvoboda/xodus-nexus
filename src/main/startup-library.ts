import type { Game } from '../shared/types.js';

type StartupInspection = { game: Game; inspected: Game | undefined };

/** Read only; callers apply every outcome in order after all readers settle. */
export async function inspectStartupLibrary(
  games: readonly Game[], inspect: (directory: string) => Promise<Game>,
): Promise<StartupInspection[]> {
  const snapshot = [...games];
  const results = new Array<StartupInspection>(snapshot.length);
  let next = 0;
  async function read(): Promise<void> {
    while (next < snapshot.length) {
      const index = next++;
      const game = snapshot[index];
      try { results[index] = { game, inspected: await inspect(game.path) }; }
      catch { results[index] = { game, inspected: undefined }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, snapshot.length) }, read));
  return results;
}
