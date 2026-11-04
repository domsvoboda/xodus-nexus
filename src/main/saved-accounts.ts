import { spawnTracked } from './process.js';

/** Saved Store / Game Pass accounts kept by the backend (`saved-accounts`). */
export interface SavedAccounts { accounts: string[]; active?: string; enabled?: boolean }

export const validAccountName = (name: unknown): name is string =>
  typeof name === 'string' && Boolean(name.trim()) && name.length <= 512 && !/[\x00-\x1f\x7f]/.test(name);

async function run(binary: string, args: string[]): Promise<{ code: number | null; output: string }> {
  const tracked = spawnTracked(binary, ['saved-accounts', ...args], { maxOutput: 100_000, stdoutOnly: true, outputDrainMs: 250 });
  tracked.child.stdin.end();
  const timer = setTimeout(() => tracked.child.kill('SIGKILL'), 15_000); timer.unref();
  try { const result = await tracked.result; return { code: result.code, output: result.output }; }
  finally { clearTimeout(timer); }
}

export function parseSavedAccounts(output: string): SavedAccounts | null {
  try {
    const line = output.split('\n').map(entry => entry.trim()).reverse().find(entry => entry.startsWith('{'));
    const value = JSON.parse(line ?? '') as { accounts?: unknown; active?: unknown; enabled?: unknown };
    if (!Array.isArray(value.accounts)) return null;
    return { accounts: [...new Set(value.accounts.filter(validAccountName))].slice(0, 64), active: validAccountName(value.active) ? value.active : undefined, ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}) };
  } catch { return null; }
}

export async function listSavedAccounts(binary: string): Promise<SavedAccounts | null> {
  const result = await run(binary, ['--json']);
  return result.code === 0 ? parseSavedAccounts(result.output) : null;
}

/** Makes a saved account the active Store account, no sign-in and no device reset. */
export async function useSavedAccount(binary: string, name: string): Promise<void> {
  if (!validAccountName(name)) throw new Error('Invalid account.');
  const result = await run(binary, ['--use', name, '--json']);
  if (result.code !== 0) throw new Error('That saved account could not be activated. Sign in to it again.');
}

export async function forgetSavedAccount(binary: string, name: string): Promise<void> {
  if (!validAccountName(name)) throw new Error('Invalid account.');
  const result = await run(binary, ['--forget', name, '--json']);
  if (result.code !== 0) throw new Error('The saved account could not be forgotten.');
}

/** The persisted backend status decides success even if the mutation timed out. */
export async function enableSavedAccounts(binary: string): Promise<void> {
  await run(binary, ['--enable', '--json']).catch(() => undefined);
  const status = await listSavedAccounts(binary).catch(() => null);
  if (status?.enabled === true) return;
  if (status?.enabled === false) throw Error('Account retention was not enabled.');
  throw Error('Account retention could not be verified. Refresh account status before trying again.');
}
