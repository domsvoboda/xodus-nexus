import { expect, it } from 'vitest';
import { DownloadProgress, PROGRESS_PREFIX } from './download-progress.js';
const record = (patch: Record<string, unknown> = {}) => PROGRESS_PREFIX + JSON.stringify({
  schema: 1, event: 'progress', sequence: 1, phase: 'downloading',
  completedBytes: 25, totalBytes: 100, bytesPerSecond: 1048576,
  paused: false, canPause: true, ...patch,
});
it('uses real aggregate bytes only, rejecting log text and stale records', () => {
  const progress = new DownloadProgress();
  expect(progress.update(record())).toMatchObject({ progress: 25, transferRate: '1.00 MiB/s', canPause: true });
  expect(progress.update('game.bin 1 MiB/1 MiB 100%')).toBeUndefined();
  expect(progress.update(record())).toBeUndefined();
  expect(progress.update(record({ sequence: 2, completedBytes: 50 }))?.progress).toBe(50);
});
it('represents unknown totals honestly and waits for actual process success at the end', () => {
  const progress = new DownloadProgress();
  expect(progress.update(record({ phase: 'initializing', totalBytes: null, completedBytes: 0, canPause: false }))?.progress).toBeNull();
  expect(progress.update(record({ sequence: 2, completedBytes: 100, phase: 'finalizing', canPause: false }))?.progress).toBe(99.9);
  expect(progress.terminal).toBeUndefined();
  progress.update(record({ sequence: 3, phase: 'complete', completedBytes: 100, canPause: false }));
  expect(progress.terminal).toBe('complete');
  expect(progress.update(record({ sequence: 4 }))).toBeUndefined();
});
it.each([{ schema: 2 }, { sequence: -1 }, { completedBytes: -1 }, { totalBytes: 5 }, { totalBytes: '100' }, { completedBytes: Number.MAX_SAFE_INTEGER + 1 }, { bytesPerSecond: 'NaN' }, { phase: 'invented' }])('ignores malformed or unsupported data %j', patch => {
  expect(new DownloadProgress().update(record(patch))).toBeUndefined();
});
it('keeps pause and failure distinct from completion', () => {
  const progress = new DownloadProgress();
  expect(progress.update(record({ paused: true }))).toMatchObject({ status: 'paused', progress: 25, transferRate: undefined });
  expect(progress.update(record({ sequence: 2, paused: false }))?.status).toBe('running');
  progress.update(record({ sequence: 3, phase: 'failed', canPause: false }));
  expect(progress.terminal).toBe('failed');
});

it('separates verified local reuse from network bytes and validates both counters', () => {
  expect(new DownloadProgress().update(record({ networkBytes: 5, reusedBytes: 20 }))).toMatchObject({
    downloadedBytes: 25, networkBytes: 5, reusedBytes: 20, phase: 'Updating files from local data and downloads',
  });
  for (const patch of [{networkBytes:-1},{reusedBytes:'20'},{reusedBytes:Number.MAX_SAFE_INTEGER+1}]) {
    expect(new DownloadProgress().update(record(patch))).toBeUndefined();
  }
});
