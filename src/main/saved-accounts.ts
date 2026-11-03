import { spawnTracked, waitForAccountReads } from './process.js';

/** Saved Store / Game Pass accounts kept by the backend (`saved-accounts`). */
export interface SavedAccounts { accounts: string[]; active?: string }

const valid = (name: unknown): name is string =>
  typeof name === 'string' && Boolean(name.trim()) && name.length <= 128 && !/[\x00-\x1f\x7f]/.test(name);

async function run(binary: string, args: string[]): Promise<{ code: number | null; output: string }> {
  const result = await spawnTracked(binary, ['saved-accounts', ...args], { maxOutput: 100_000, stdoutOnly: true }).result;
  return { code: result.code, output: result.output };
}

export function parseSavedAccounts(output: string): SavedAccounts | null {
  try {
    const line = output.split('\n').map(entry => entry.trim()).reverse().find(entry => entry.startsWith('{'));
    const value = JSON.parse(line ?? '') as { accounts?: unknown; active?: unknown };
    if (!Array.isArray(value.accounts)) return null;
    return { accounts: value.accounts.filter(valid).slice(0, 50), active: valid(value.active) ? value.active : undefined };
  } catch { return null; }
}

export async function listSavedAccounts(binary: string): Promise<SavedAccounts | null> {
  const result = await run(binary, ['--json']);
  return result.code === 0 ? parseSavedAccounts(result.output) : null;
}

/** Makes a saved account the active Store account, no sign-in and no device reset. */
export async function useSavedAccount(binary: string, name: string): Promise<void> {
  if (!valid(name)) throw new Error('Invalid account.');
  await waitForAccountReads();
  const result = await run(binary, ['--use', name, '--json']);
  if (result.code !== 0) throw new Error('That saved account could not be activated. Sign in to it again.');
}

export async function forgetSavedAccount(binary: string, name: string): Promise<void> {
  if (!valid(name)) throw new Error('Invalid account.');
  const result = await run(binary, ['--forget', name, '--json']);
  if (result.code !== 0) throw new Error('The saved account could not be forgotten.');
}
