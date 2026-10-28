import type { DownloadTask } from '../shared/types.js';
export const PROGRESS_PREFIX = 'NEXUS_PROGRESS ';
const phases = {
  initializing: 'Preparing download', metadata: 'Reading package metadata',
  downloading: 'Downloading and extracting game files', finalizing: 'Finalizing installation',
  complete: 'Installation complete', failed: 'Installation failed',
} as const;
const counter = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Machine-readable v1 records only: never infer percentages from log text. */
export class DownloadProgress {
  private sequence = -1;
  terminal?: 'complete' | 'failed';

  update(line: string): Partial<DownloadTask> | undefined {
    if (!line.startsWith(PROGRESS_PREFIX) || line.length > 4096 || this.terminal) return;
    let value: Record<string, unknown>;
    try { value = JSON.parse(line.slice(PROGRESS_PREFIX.length)); } catch { return; }
    if (!value || value.schema !== 1 || value.event !== 'progress' ||
        !counter(value.sequence) || value.sequence <= this.sequence ||
        typeof value.phase !== 'string' || !Object.hasOwn(phases, value.phase) ||
        !counter(value.completedBytes) || !(value.totalBytes === null || counter(value.totalBytes)) ||
        value.totalBytes !== null && value.completedBytes > value.totalBytes ||
        value.networkBytes !== undefined && !counter(value.networkBytes) ||
        value.reusedBytes !== undefined && !counter(value.reusedBytes) ||
        !counter(value.bytesPerSecond) || typeof value.paused !== 'boolean' || typeof value.canPause !== 'boolean') return;
    this.sequence = value.sequence;
    const phase = value.phase as keyof typeof phases;
    if (phase === 'complete' || phase === 'failed') this.terminal = phase;
    const progress = typeof value.totalBytes === 'number' && value.totalBytes > 0
      ? Math.min(99.9, value.completedBytes / value.totalBytes * 100) : null;
    const rate = value.bytesPerSecond;
    return {
      progress, downloadedBytes: value.completedBytes, totalBytes: value.totalBytes ?? undefined,
      networkBytes: value.networkBytes as number | undefined, reusedBytes: value.reusedBytes as number | undefined,
      transferRate: value.paused || rate === 0 ? undefined : `${(rate / 1048576).toFixed(2)} MiB/s`,
      phase: value.paused ? 'Paused' : phase === 'downloading' && value.reusedBytes !== undefined ? 'Updating files from local data and downloads' : phases[phase],
      status: value.paused ? 'paused' : 'running',
      canPause: value.canPause && phase === 'downloading', controlPending: false,
    };
  }
}
