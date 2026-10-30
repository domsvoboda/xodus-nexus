import { describe, expect, it, vi } from 'vitest';
import { EphemeralServiceSessions } from './service-sessions.js';
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

