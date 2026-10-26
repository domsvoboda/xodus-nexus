import { expect, it } from 'vitest';
import { contentLicenseDiagnostic, contentLicenseFailure, contentLicenseStages } from './content-license.js';
const line = (stage: string, status = 200) => `NEXUS_CONTENT_LICENSE_DIAGNOSTIC_V1 ${stage} ${status}`;
it('explains the Store device limit without confusing it with HTTP 501 or missing ownership', () => {
  const text = contentLicenseFailure([line('content-device-limit')]);
  expect(text).toContain('Microsoft Store device limit reached');
  expect(text).toContain('https://account.microsoft.com/devices/content');
  expect(text).toContain('unlink');
  expect(text).not.toMatch(/purchased edition|Sign in again/);
  expect(contentLicenseFailure([line('content-http', 501)])).toContain('server error');
  expect(contentLicenseFailure([line('content-not-entitled')])).not.toContain('device limit');
  expect(contentLicenseFailure([line('content-device-limit'), line('content-parsed')])).toBeUndefined();
});
it('distinguishes actual status, transport, denial and response failures without guessing ownership', () => {
  for (const [status, message] of [[401, 'Sign in again'], [403, 'purchased edition'], [429, 'rate-limiting'], [503, 'server error']] as const) {
    expect(contentLicenseFailure([line('content-http', status)])).toContain(message);
  }
  expect(contentLicenseFailure([line('content-timeout', 0)])).toContain('timed out');
  expect(contentLicenseFailure([line('content-not-entitled')])).toContain('did not grant');
  expect(contentLicenseFailure([line('content-schema')])).toContain('unsupported');
  expect(contentLicenseFailure([line('content-empty-keys')])).not.toContain('not own');
});
it('accepts only complete allowlisted metadata and never provider text or credentials', () => {
  for (const text of ['prefix ' + line('content-http', 403), line('content-http', 403) + ' secret',
    line('unknown'), line('content-http', 999), line('content-http', -1), 'private@example.test t=SECRET',
    line('content-schema') + '\n', line('content-schema') + '\r']) expect(contentLicenseDiagnostic(text)).toBeUndefined();
  for (const stage of contentLicenseStages) {
    expect(contentLicenseDiagnostic(line(stage))).toEqual({ stage, status: 200 });
    expect(contentLicenseFailure(['private@example.test t=SECRET', line(stage)]) ?? '').not.toMatch(/example.test|SECRET/);
  }
  expect(contentLicenseDiagnostic(line('content-timeout', 0))).toEqual({ stage: 'content-timeout', status: undefined });
});
it('clears earlier failure metadata on a parsed response and bounds old log inspection', () => {
  expect(contentLicenseFailure([line('content-http', 503), line('content-parsed'), 'later extraction failure'])).toBeUndefined();
  expect(contentLicenseFailure([line('content-http', 503), ...Array(256).fill('other')])).toBeUndefined();
  expect(contentLicenseFailure([line('content-parsed'), line('content-license-blob', 0)])).toContain('unsupported');
});
