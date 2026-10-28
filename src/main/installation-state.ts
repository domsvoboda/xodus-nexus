import { promises as fs } from 'node:fs';
import path from 'node:path';

// Shared on-disk protocol with the backend, not tied to queue history/profile.
export const INCOMPLETE_UPDATE_MARKER = '.nexus-update-incomplete-v1';
export const INCOMPLETE_UPDATE_MESSAGE = 'An update was interrupted. Resume the update before playing.';

export async function hasIncompleteUpdate(root: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(root, INCOMPLETE_UPDATE_MARKER));
    return true; // Invalid/symlink markers must not accidentally unblock a game.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw Error('The installation update state could not be checked. Check access to the game folder.');
  }
}
