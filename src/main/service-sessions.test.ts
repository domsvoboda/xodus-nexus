import { describe, expect, it, vi } from 'vitest';
import { EphemeralServiceSessions, WARM_SESSION_IDLE_MS, WarmServiceSessions } from './service-sessions.js';
import type { XodusServiceSession } from './xodus-service.js';

function fakeStart() {
  const sessions: (XodusServiceSession & { stopped: number })[] = [];
  const start = vi.fn(async (binary: string) => {
    const session = {
      socketPath: `/run/x/${sessions.length}.sock`, bridgePort: 4000 + sessions.length, bridgeKey: 'k'.repeat(64), pid: 100 + sessions.length, startedAt: 'now',
      stopped: 0, binary, stop: async () => { session.stopped++; },
    };
    sessions.push(session);
    return session;
  });
  return { start: start as unknown as typeof import('./xodus-service.js').startXodusService, sessions, calls: start };
}

describe('EphemeralServiceSessions', () => {
  it('starts one service per launch and stops it on release', async () => {
    const fake = fakeStart();
    const sessions = new EphemeralServiceSessions(fake.start);
    const first = await sessions.acquire('/bin/xodus-cli', '/data', () => {});
    const second = await sessions.acquire('/bin/xodus-cli', '/data', () => {});
    expect(fake.sessions).toHaveLength(2);
    await first.release();
    expect(fake.sessions[0].stopped).toBe(1);
    expect(fake.sessions[1].stopped).toBe(0);
    await second.release();
    expect(fake.sessions[1].stopped).toBe(1);
  });
});

describe('WarmServiceSessions', () => {
  it('reuses one live service across launches and reports it warm', async () => {
    const fake = fakeStart();
    const ready = vi.fn(async () => true);
    const log: string[] = [];
    const warm = new WarmServiceSessions({ start: fake.start, ready, now: () => 1_000_000, log: line => log.push(line) });
    expect(warm.status).toEqual({ warm: false });
    const messages: string[] = [];
    const first = await warm.acquire('/bin/xodus-cli', '/run/x', line => messages.push(line));
    await first.release();
    expect(warm.status.warm).toBe(true);
    const second = await warm.acquire('/bin/xodus-cli', '/run/x', line => messages.push(line));
    expect(fake.calls).toHaveBeenCalledTimes(1);
    expect(second.socketPath).toBe(first.socketPath);
    expect(messages).toContain('Reusing the warm Xodus account service.');
    expect(fake.sessions[0].stopped).toBe(0);
    await second.release();
    expect(warm.current?.pid).toBe(100);
    expect(warm.binary).toBe('/bin/xodus-cli');
  });

  it('restarts a dead service or one from another backend, and stops on sweep after the idle period', async () => {
    const fake = fakeStart();
    let alive = true;
    let now = 0;
    const warm = new WarmServiceSessions({ start: fake.start, ready: async () => alive, now: () => now, idleMs: WARM_SESSION_IDLE_MS });
    const first = await warm.acquire('/bin/a', '/run/x', () => {});
    await first.release();
    alive = false;
    const second = await warm.acquire('/bin/a', '/run/x', () => {});
    expect(fake.sessions).toHaveLength(2);
    expect(fake.sessions[0].stopped).toBe(1);
    alive = true;
    await second.release();
    const third = await warm.acquire('/bin/b', '/run/x', () => {});
    expect(fake.sessions).toHaveLength(3);
    expect(fake.sessions[1].stopped).toBe(1);
    expect(await warm.sweep()).toBe(false); // in use
    await third.release();
    now = WARM_SESSION_IDLE_MS - 1;
    expect(await warm.sweep()).toBe(false);
    now = WARM_SESSION_IDLE_MS + 1;
    expect(await warm.sweep()).toBe(true);
    expect(fake.sessions[2].stopped).toBe(1);
    expect(warm.status).toEqual({ warm: false });
  });

  it('forgets a service whose socket stopped answering and adopts one from a previous daemon', async () => {
    const fake = fakeStart();
    let alive = true;
    const warm = new WarmServiceSessions({ start: fake.start, ready: async () => alive });
    const adopted = { socketPath: '/run/old.sock', bridgePort: 1, bridgeKey: 'k'.repeat(64), pid: 7, stop: vi.fn(async () => {}) };
    warm.adopt(adopted, '/bin/a', '2026-10-25T00:00:00.000Z');
    expect(warm.status).toMatchObject({ warm: true, startedAt: '2026-10-25T00:00:00.000Z' });
    expect(await warm.healthy()).toBe(true);
    alive = false;
    expect(await warm.healthy()).toBe(false);
    expect(adopted.stop).toHaveBeenCalledTimes(1);
    expect(warm.status.warm).toBe(false);
    alive = true;
    await warm.acquire('/bin/a', '/run/x', () => {});
    expect(fake.calls).toHaveBeenCalledTimes(1);
    await warm.stopAll();
    expect(fake.sessions[0].stopped).toBe(1);
  });
});
