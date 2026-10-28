/** Fixed content-licensing metadata only, never provider messages or license data. */
export const contentLicenseStages = new Set([
  'content-timeout', 'content-request', 'content-http', 'content-size', 'content-read',
  'content-json', 'content-schema', 'content-not-entitled', 'content-device-limit', 'content-empty-keys',
  'content-base64', 'content-utf8', 'content-xml', 'content-license-blob', 'content-parsed',
  // Device-bound offline license cache (backend `run --license-cache`).
  'content-cache-stored', 'content-cache-skipped', 'content-cache-write-failed', 'content-cache-used',
  'content-cache-missing', 'content-cache-expired', 'content-cache-invalid', 'content-cache-purged',
  // Every stored license removed: Microsoft reports this device as not the
  // designated offline device, or they belonged to another account.
  'content-cache-revoked', 'content-cache-account',
  // The clock is earlier than a stored license has already been used at.
  'content-cache-clock',
]);
/** Stages after which the launch holds a usable license. */
const licenseResolved = new Set(['content-parsed', 'content-cache-used']);

export function contentLicenseDiagnostic(line: string): { stage: string; status?: number } | undefined {
  if (line.length > 128 || /[\r\n]/.test(line)) return;
  const match = /^NEXUS_CONTENT_LICENSE_DIAGNOSTIC_V1 ([a-z0-9-]{1,60}) (0|[1-5][0-9]{2})$/.exec(line);
  if (!match || !contentLicenseStages.has(match[1])) return;
  const status = Number(match[2]);
  return { stage: match[1], status: status || undefined };
}

export function contentLicenseFailure(log: string[]): string | undefined {
  let last: ReturnType<typeof contentLicenseDiagnostic>;
  for (const line of log.slice(-256)) {
    const record = contentLicenseDiagnostic(line);
    if (record) last = licenseResolved.has(record.stage) ? undefined : record;
  }
  if (!last) return;
  if (last.stage === 'content-device-limit') return 'Microsoft Store device limit reached. Open https://account.microsoft.com/devices/content, unlink an old device you no longer use, then try again. You do not need to sign out or reset the wallet.';
  if (last.stage === 'content-cache-missing') return 'Microsoft content licensing is unreachable and no offline license is stored for this game. Offline play needs this device set as the account\'s offline device, then one launch while online.';
  if (last.stage === 'content-cache-expired') return 'Microsoft content licensing is unreachable and the stored offline license for this game has expired. Connect to the internet and play it once to renew offline play.';
  if (last.stage === 'content-cache-invalid') return 'Microsoft content licensing is unreachable and the stored offline license for this game is not valid on this device. Connect to the internet and play it once to renew offline play.';
  if (last.stage === 'content-cache-account') return 'Microsoft content licensing is unreachable and the stored offline licenses belonged to another account, so they were removed. Connect to the internet and play once with this account to enable offline play.';
  if (last.stage === 'content-cache-clock') return 'Microsoft content licensing is unreachable and the system clock is earlier than the stored offline license was last used, so it was not used. Correct the date and time, or connect to the internet.';
  if (last.stage === 'content-cache-purged') return 'Microsoft did not grant a license for this account and package, so its offline license was removed. Check the purchased edition, subscription and Store region.';
  if (['content-cache-stored', 'content-cache-skipped', 'content-cache-write-failed', 'content-cache-revoked'].includes(last.stage)) return;
  if (last.stage === 'content-http') {
    if (last.status === 401) return 'Microsoft rejected content licensing sign-in (HTTP 401). Sign in again in Settings.';
    if (last.status === 403) return 'Microsoft denied this content-license request (HTTP 403). Check the account, purchased edition and Store region.';
    if (last.status === 429) return 'Microsoft content licensing is rate-limiting requests (HTTP 429). Wait before trying again.';
    if (last.status && last.status >= 500) return `Microsoft content licensing returned a server error (HTTP ${last.status}). Try again later.`;
    return 'Microsoft content licensing returned an unexpected HTTP status. Share the backend diagnostic log.';
  }
  if (last.stage === 'content-timeout') return 'Microsoft content licensing timed out. Check your connection and try again.';
  if (last.stage === 'content-request' || last.stage === 'content-read') return 'The Microsoft content-license request could not be completed. Check your connection and try again.';
  if (last.stage === 'content-not-entitled') return 'Microsoft did not grant a license for this account and package. Check the purchased edition, subscription and Store region.';
  if (last.stage === 'content-size') return 'The content-license response exceeded the safety limit. Share the backend diagnostic log.';
  return 'Microsoft returned an invalid or unsupported content-license response. Share the backend diagnostic log.';
}
