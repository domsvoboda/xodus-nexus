import { spawnTracked } from './process.js';
import { offlinePermissionFailure, parseOfflinePermissions } from '../shared/offline-permissions.js';
import type { OfflinePermissions } from '../shared/types.js';

type Runner = (args: string[]) => Promise<{ code: number | null; output: string; log: string[] }>;

/** Runs `xodus-cli offline-pc`; stdout carries the JSON, stderr the diagnostics. */
export function backendRunner(binary: string, timeoutMs = 90_000): Runner {
  return async (args) => {
    const log: string[] = [];
    const tracked = spawnTracked(binary, ['offline-pc', ...args], { maxOutput: 200_000, stdoutOnly: true, onLine: (line) => { if (log.length < 64) log.push(line); } });
    const timer = setTimeout(() => tracked.child.kill('SIGKILL'), timeoutMs); timer.unref();
    try {
      const result = await tracked.result;
      return { code: result.code, output: result.output, log };
    } finally { clearTimeout(timer); }
  };
}

function settle(result: { code: number | null; output: string; log: string[] }, changing: boolean): OfflinePermissions {
  const failure = offlinePermissionFailure(result.log);
  let status: OfflinePermissions | undefined;
  try { status = parseOfflinePermissions(result.output); } catch (error) { if (result.code === 0) throw error; }
  if (changing && status && !status.requestSuccess) throw Error(failure ?? 'Microsoft did not apply the change.');
  if (result.code !== 0) {
    if (changing && status && !status.requestSuccess) {
      throw Error(failure ?? 'Microsoft did not apply the change.');
    }
    throw Error(failure ?? `The offline-permission request failed (xodus-cli exited with code ${result.code ?? 'unknown'}).`);
  }
  if (!status) throw Error('The backend returned no offline-permission status.');
  return status;
}

/** With a license cache the backend itself removes the stored offline
 * licenses whenever Microsoft reports this device as not designated. */
const cacheArgs = (licenseCache?: string) => licenseCache ? ['--license-cache', licenseCache] : [];

/** Reads whether this device is the account's designated offline PC. */
export async function readOfflinePermissions(run: Runner, licenseCache?: string): Promise<OfflinePermissions> {
  return settle(await run(cacheArgs(licenseCache)), false);
}

/** Changes the designation. The caller confirms with the user first; Microsoft
 * counts every change against a yearly limit. */
export async function changeOfflinePermissions(run: Runner, enabled: boolean, licenseCache?: string): Promise<OfflinePermissions> {
  const result = settle(await run(['--set', enabled ? 'true' : 'false', '--confirm', ...cacheArgs(licenseCache)]), true);
  if (result.enabled !== enabled) throw Error('Microsoft did not apply the change.');
  return result;
}
