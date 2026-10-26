import type { InstallChoice } from './types.js';

export function installByteLabel(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isSafeInteger(bytes) || bytes < 0) return 'Unavailable';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/** Catalog maxima are estimates, not a reservation or a completed-file check. */
export function estimatedInstallBytes(choice: Pick<InstallChoice, 'downloadBytes' | 'installBytes'> | undefined): number | undefined {
  const values = [choice?.downloadBytes, choice?.installBytes].filter((value): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
  return values.length ? Math.max(...values) : undefined;
}
