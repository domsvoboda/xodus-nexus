import { describe, expect, it, vi } from 'vitest';
import { AccountWatch, daemonMarket, type StoredAccount } from './controller.js';

describe('daemonMarket', () => {
  it('keeps a configured market and takes a neutral one from the session locale', () => {
    expect(daemonMarket('GB', { LANG: 'de_DE.UTF-8' })).toBe('GB');
    expect(daemonMarket('neutral', { LANG: 'de_DE.UTF-8' })).toBe('DE');
    expect(daemonMarket('Neutral', { LC_ALL: 'fr_CA.UTF-8', LANG: 'en_US.UTF-8' })).toBe('CA');
    expect(daemonMarket('neutral', { LANG: 'C.UTF-8' })).toBe('US');
    expect(daemonMarket('neutral', {})).toBe('US');
  });
});

describe('AccountWatch', () => {
  function watch(reads: Array<StoredAccount | Error>) {
    const seen: StoredAccount[] = [];
    const changes: StoredAccount[] = [];
    const subject: AccountWatch = new AccountWatch(async () => {
      const next = reads.shift()!;
      if (next instanceof Error) throw next;
      seen.push(next);
      return next;
    }, async () => { changes.push(subject.current); });
    return { subject, seen, changes };
  }

  it('reads the account on every refresh and invalidates before a switched account is used', async () => {
    const { subject, changes } = watch([{ stored: true, username: 'a@example.com' }, { stored: true, username: 'a@example.com' }, { stored: true, username: 'b@example.com' }]);
    await subject.refresh();
    expect(changes).toHaveLength(1);
    await subject.refresh();
    expect(changes).toHaveLength(1);
    await subject.refresh();
    expect(changes).toHaveLength(2);
    // The old account is never visible while its state is being dropped.
    expect(changes[1]).toEqual({ stored: null });
    expect(subject.current).toEqual({ stored: true, username: 'b@example.com' });
  });

  it('keeps the owner across a failed read so a later switch is still seen', async () => {
    const { subject, changes } = watch([{ stored: true, username: 'a@example.com' }, new Error('wallet locked'), { stored: true, username: 'b@example.com' }]);
    await subject.refresh();
    await subject.refresh();
    expect(subject.current).toEqual({ stored: null });
    expect(subject.error).toBe('wallet locked');
    await subject.refresh();
    expect(changes).toHaveLength(2);
    expect(subject.error).toBeUndefined();
  });

  it('treats a sign-out as a change and a service restored for another account as stale', async () => {
    const signedOut = watch([{ stored: true, username: 'a@example.com' }, { stored: false }]);
    await signedOut.subject.refresh();
    await signedOut.subject.refresh();
    expect(signedOut.changes).toHaveLength(2);

    const restored = watch([{ stored: true, username: 'b@example.com' }]);
    restored.subject.restore('not-the-key-of-b');
    await restored.subject.refresh();
    expect(restored.changes).toHaveLength(1);
  });

  it('keeps a service restored for the same account', async () => {
    const first = watch([{ stored: true, username: 'a@example.com' }]);
    await first.subject.refresh();
    const restored = watch([{ stored: true, username: 'a@example.com' }]);
    restored.subject.restore(first.subject.owner);
    await restored.subject.refresh();
    expect(restored.changes).toHaveLength(0);
  });

  it('gives up on a read that hangs', async () => {
    vi.useFakeTimers();
    try {
      const subject = new AccountWatch(signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))), async () => {}, 50);
      const done = subject.refresh();
      await vi.advanceTimersByTimeAsync(50);
      await done;
      expect(subject.error).toBe('aborted');
    } finally { vi.useRealTimers(); }
  });
});
