import { describe, expect, it } from 'vitest';
import { offlinePermissionDiagnostic, offlinePermissionFailure, offlinePermissionLimitText, parseOfflinePermissions } from './offline-permissions.js';

const line = (stage: string, status = 0) => `NEXUS_OFFLINE_PC_V1 ${stage} ${status}`;
const summary = (extra: Record<string, unknown> = {}) => JSON.stringify({ schema: 1, enabled: true, requestSuccess: true, remainingToggles: 1, maxToggles: 3, periodDays: 365, nextChangeAt: null, ...extra });

describe('offline permission status', () => {
  it('parses only the allowlisted backend summary and takes the last JSON line', () => {
    const now = new Date('2026-10-24T22:00:00Z');
    const parsed = parseOfflinePermissions(`noise\n{"schema":1,"enabled":false}\n${summary()}\n`, now);
    expect(parsed).toEqual({ enabled: true, requestSuccess: true, remainingToggles: 1, maxToggles: 3, periodDays: 365, nextChangeAt: undefined, checkedAt: now.toISOString() });
    expect(parseOfflinePermissions(summary({ remainingToggles: 0, nextChangeAt: '2027-03-01T10:00:00+00:00', requestSuccess: false })).nextChangeAt).toBe('2027-03-01T10:00:00.000Z');
    expect(parseOfflinePermissions(summary({ remainingToggles: -1, maxToggles: 1e9, nextChangeAt: 'soon', secret: 'x' }))).toMatchObject({ remainingToggles: undefined, maxToggles: undefined, nextChangeAt: undefined });
    expect(JSON.stringify(parseOfflinePermissions(summary({ secret: 'x' })))).not.toContain('secret');
    for (const bad of ['', 'not json', '{"schema":2,"enabled":true}', '{"schema":1,"enabled":"yes"}', summary().repeat(5000)]) {
      expect(() => parseOfflinePermissions(bad)).toThrow();
    }
  });
  it('maps diagnostics to fixed messages without provider text', () => {
    expect(offlinePermissionFailure([line('ok', 200)])).toBeUndefined();
    expect(offlinePermissionFailure(['private@example.test', line('declined', 200)])).toContain('did not apply');
    expect(offlinePermissionFailure([line('request')])).toContain('could not be reached');
    expect(offlinePermissionFailure([line('timeout')])).toContain('could not be reached');
    expect(offlinePermissionFailure([line('http', 401)])).toContain('Sign in again');
    expect(offlinePermissionFailure([line('http', 429)])).toContain('rate-limiting');
    expect(offlinePermissionFailure([line('http', 503)])).toContain('server error');
    expect(offlinePermissionFailure([line('device-sign-in')])).toContain('Xbox sign-in');
    expect(offlinePermissionFailure([line('schema', 200)])).toContain('unreadable');
    expect(offlinePermissionFailure(['unrelated'])).toBeUndefined();
    for (const text of [line('unknown'), line('http', 999), 'prefix ' + line('http', 401), line('http', 401) + ' secret']) expect(offlinePermissionDiagnostic(text)).toBeUndefined();
    expect(offlinePermissionDiagnostic(line('ok', 200))).toEqual({ stage: 'ok', status: 200 });
  });
  it('explains the yearly limit like the Xbox app', () => {
    const base = { enabled: true, requestSuccess: true, maxToggles: 3, periodDays: 365, checkedAt: '2026-10-24T22:00:00Z' };
    expect(offlinePermissionLimitText({ ...base, remainingToggles: 2 }, 'en-US')).toBe('Changes left this year: 2 of 3.');
    expect(offlinePermissionLimitText({ ...base, remainingToggles: 1, maxToggles: undefined }, 'en-US')).toBe('Changes left this year: 1.');
    expect(offlinePermissionLimitText({ ...base, remainingToggles: 0, nextChangeAt: '2027-03-01T10:00:00.000Z' }, 'en-US')).toBe('You have used every change for this year. You can change this again on March 1, 2027.');
    expect(offlinePermissionLimitText({ ...base, remainingToggles: 0 }, 'en-US')).toBe('You have used every change for this year.');
    expect(offlinePermissionLimitText({ ...base, remainingToggles: undefined }, 'en-US')).toBe('Microsoft allows 3 changes of this setting per year.');
    expect(offlinePermissionLimitText({ ...base, remainingToggles: undefined, maxToggles: undefined }, 'en-US')).toBe('Microsoft limits how often this setting can change.');
    expect(offlinePermissionLimitText({ ...base, periodDays: 30, remainingToggles: 1, maxToggles: undefined }, 'en-US')).toBe('Changes left in this 30-day period: 1.');
    expect(offlinePermissionLimitText({ ...base, periodDays: 30, remainingToggles: 0 }, 'en-US')).toBe('You have used every change for this 30-day period.');
  });
});
