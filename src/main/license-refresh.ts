import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnTracked } from './process.js';

/** Renew the stored offline licenses at most this often; a lease lasts 30 days. */
export const LICENSE_REFRESH_INTERVAL_MS = 24 * 60 * 60_000;
const TIMEOUT_MS = 180_000;
/** Marks the last renewal that reached Microsoft; the backend only reads `*.json` entries. */
const STAMP = '.last-refresh';

/** `xodus-cli license-refresh` stdout, schema 1. */
export interface LicenseRefreshSummary {
  checked: number;
  renewed: number;
  onlineOnly: number;
  refused: number;
  failed: number;
  unreachable: boolean;
  earliestExpiresAt: number | null;
}

type Runner = (binary: string, args: string[]) => Promise<{ code: number | null; output: string }>;

const defaultRunner: Runner = async (binary, args) => {
  const tracked = spawnTracked(binary, args, { maxOutput: 200_000, stdoutOnly: true });
  const timer = setTimeout(() => tracked.child.kill('SIGKILL'), TIMEOUT_MS); timer.unref();
  try { return await tracked.result; } finally { clearTimeout(timer); }
};

export function parseLicenseRefresh(output: string): LicenseRefreshSummary | undefined {
  for (const line of output.split('\n').reverse()) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.schema !== 1) continue;
      const count = (key: string) => (typeof value[key] === 'number' ? value[key] : 0) as number;
      return {
        checked: count('checked'), renewed: count('renewed'), onlineOnly: count('onlineOnly'), refused: count('refused'), failed: count('failed'),
        unreachable: value.unreachable === true,
        earliestExpiresAt: typeof value.earliestExpiresAt === 'number' ? value.earliestExpiresAt : null,
      };
    } catch { /* Not the summary line. */ }
  }
  return undefined;
}

/**
 * Renews the offline licenses stored in `cacheDirectory` once a day while
 * Microsoft is reachable, so games not launched online within the 30-day
 * lease keep offline permission. Never throws; returns undefined when skipped.
 */
export async function refreshOfflineLicenses(binary: string, cacheDirectory: string, log: (line: string) => void,
  now = Date.now(), runner: Runner = defaultRunner): Promise<LicenseRefreshSummary | undefined> {
  const names = await fs.readdir(cacheDirectory).catch(() => [] as string[]);
  if (!names.some(name => name.endsWith('.json'))) return undefined;
  const stamp = path.join(cacheDirectory, STAMP);
  const last = await fs.stat(stamp).then(stat => stat.mtimeMs, () => 0);
  if (last <= now && now - last < LICENSE_REFRESH_INTERVAL_MS) return undefined;
  let result: { code: number | null; output: string };
  try { result = await runner(binary, ['license-refresh', '--license-cache', cacheDirectory]); }
  catch (error) { log(`Offline license renewal could not start: ${(error as Error).message}`); return undefined; }
  const summary = parseLicenseRefresh(result.output);
  if (!summary) { log(`Offline license renewal failed (xodus-cli exited with code ${result.code ?? 'unknown'}).`); return undefined; }
  if (summary.unreachable) { log('Offline license renewal: Microsoft is unreachable; trying again after the next online game session.'); return summary; }
  await fs.writeFile(stamp, '', { mode: 0o600 }).catch(() => undefined);
  const until = summary.earliestExpiresAt ? `; offline play now valid until at least ${new Date(summary.earliestExpiresAt * 1000).toISOString().slice(0, 10)}` : '';
  const removed = summary.onlineOnly + summary.refused;
  log(`Offline license renewal: ${summary.renewed} of ${summary.checked} renewed${removed ? `, ${removed} removed` : ''}${summary.failed ? `, ${summary.failed} failed` : ''}${until}.`);
  return summary;
}
