import type { DownloadTask, Game } from '../shared/types.js';

/**
 * Completion timestamp for a genuinely new successful installation only.
 *
 * Repairs and updates keep the existing value, imports never get one, and an
 * incomplete result or an unknown legacy timestamp is left absent instead of
 * being replaced by the inspection clock.
 */
export function newInstallationTime(
  existing: Game | undefined,
  status: DownloadTask['status'],
  installState: Game['installState'],
  finishedAt: string | undefined,
): string | undefined {
  if (existing || status !== 'complete' || installState !== 'ready' || !finishedAt) return;
  if (!Number.isFinite(Date.parse(finishedAt))) return;
  return finishedAt;
}
