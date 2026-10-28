import type { OfflinePermissions } from './types.js';

/** Fixed metadata only, never provider messages or account data. */
export const offlinePermissionStages = new Set([
  'confirm-required', 'device-sign-in', 'xsts', 'timeout', 'request', 'read', 'http', 'schema', 'ok', 'declined',
]);

export function offlinePermissionDiagnostic(line: string): { stage: string; status?: number } | undefined {
  if (line.length > 64 || /[\r\n]/.test(line)) return;
  const match = /^NEXUS_OFFLINE_PC_V1 ([a-z-]{1,24}) (0|[1-5][0-9]{2})$/.exec(line);
  if (!match || !offlinePermissionStages.has(match[1])) return;
  const status = Number(match[2]);
  return { stage: match[1], status: status || undefined };
}

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000 ? value : undefined;

/** Parses the backend's one-line JSON summary; anything unexpected is rejected. */
export function parseOfflinePermissions(output: string, now = new Date()): OfflinePermissions {
  if (output.length > 64 * 1024) throw Error('The offline-permission response exceeded the safety limit.');
  const line = output.split('\n').map(line => line.trim()).reverse().find(line => line.startsWith('{'));
  let value: Record<string, unknown>;
  try { value = JSON.parse(line ?? ''); } catch { throw Error('The backend returned an unreadable offline-permission status.'); }
  if (!value || typeof value !== 'object' || value.schema !== 1 || typeof value.enabled !== 'boolean') {
    throw Error('The backend returned an unsupported offline-permission status.');
  }
  const nextChangeAt = typeof value.nextChangeAt === 'string' && value.nextChangeAt.length <= 40 && !Number.isNaN(Date.parse(value.nextChangeAt))
    ? new Date(value.nextChangeAt).toISOString() : undefined;
  return {
    enabled: value.enabled,
    requestSuccess: value.requestSuccess === true,
    remainingToggles: count(value.remainingToggles),
    maxToggles: count(value.maxToggles),
    periodDays: count(value.periodDays),
    nextChangeAt,
    checkedAt: now.toISOString(),
  };
}

/** Maps the last backend diagnostic to a user-facing message. */
export function offlinePermissionFailure(log: string[]): string | undefined {
  let last: ReturnType<typeof offlinePermissionDiagnostic>;
  for (const line of log.slice(-64)) {
    const record = offlinePermissionDiagnostic(line);
    if (record) last = record;
  }
  if (!last || last.stage === 'ok') return;
  switch (last.stage) {
    case 'declined': return 'Microsoft did not apply the change. Usually all changes for this year have been used.';
    case 'timeout':
    case 'request': return 'Microsoft could not be reached. Check your connection and try again.';
    case 'device-sign-in':
    case 'xsts': return 'Xbox sign-in for this request failed. Check your connection, or sign in again in Settings.';
    case 'http':
      if (last.status === 401 || last.status === 403) return 'Microsoft rejected the request. Sign in again in Settings.';
      if (last.status === 429) return 'Microsoft is rate-limiting requests. Wait before trying again.';
      if (last.status && last.status >= 500) return 'Microsoft returned a server error. Try again later.';
      return 'Microsoft refused the offline-permission request.';
    case 'confirm-required': return 'The backend requires confirmation for this change.';
    default: return 'Microsoft returned an unreadable offline-permission response.';
  }
}

/** Remaining-changes sentence shown under the setting, mirroring the Xbox app. */
/** Each variant is one fixed English sentence so the renderer can translate it. */
export function offlinePermissionLimitText(status: OfflinePermissions, locale?: string): string {
  const days = status.periodDays === 365 || status.periodDays === undefined ? undefined : status.periodDays;
  const when = status.nextChangeAt ? new Date(status.nextChangeAt).toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' }) : undefined;
  if (status.remainingToggles === undefined) {
    if (!status.maxToggles) return 'Microsoft limits how often this setting can change.';
    return days ? `Microsoft allows ${status.maxToggles} changes of this setting every ${days} days.` : `Microsoft allows ${status.maxToggles} changes of this setting per year.`;
  }
  if (status.remainingToggles === 0) {
    const used = days ? `You have used every change for this ${days}-day period.` : 'You have used every change for this year.';
    return when ? `${used} You can change this again on ${when}.` : used;
  }
  if (status.maxToggles) {
    return days ? `Changes left in this ${days}-day period: ${status.remainingToggles} of ${status.maxToggles}.` : `Changes left this year: ${status.remainingToggles} of ${status.maxToggles}.`;
  }
  return days ? `Changes left in this ${days}-day period: ${status.remainingToggles}.` : `Changes left this year: ${status.remainingToggles}.`;
}
