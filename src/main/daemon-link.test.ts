import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ClientFrame, DaemonFrame } from '../shared/daemon-protocol.js';
import { DaemonLink } from './daemon-link.js';
import type { DaemonConnection } from './daemon-client.js';

/** A scripted DaemonConnection: records what the link sends and lets the test answer. */
class FakeConnection extends EventEmitter {
  sent: ClientFrame[] = [];
  open = true;
  send(frame: ClientFrame) { this.sent.push(frame); }
  close() { if (!this.open) return; this.open = false; this.emit('close', undefined); }
  next<T extends DaemonFrame>(accept: (frame: DaemonFrame) => frame is T, timeoutMs?: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => reject(new Error('timeout')), timeoutMs) : undefined;
      const onFrame = (frame: DaemonFrame) => { if (accept(frame)) { if (timer) clearTimeout(timer); this.off('frame', onFrame); resolve(frame); } };
      this.on('frame', onFrame);
      this.once('close', () => { if (timer) clearTimeout(timer); reject(new Error('closed')); });
    });
  }
  answer(frame: DaemonFrame) { this.emit('frame', frame); }
}

const state = { session: { warm: true }, gameOperation: { id: 'game-1', gameId: '1', title: 'T', kind: 'launch' as const, status: 'running' as const, phase: 'p', log: [], startedAt: 'now' } };

describe('DaemonLink', () => {
  it('connects, subscribes, mirrors state and reconnects after the daemon goes away', async () => {
    vi.useFakeTimers();
    const connections: FakeConnection[] = [];
    let fail = 1;
    const connect = vi.fn(async () => { if (fail-- > 0) throw new Error('ECONNREFUSED'); const connection = new FakeConnection(); connections.push(connection); return connection as unknown as DaemonConnection; });
    const link = new DaemonLink({ socketPath: '/run/x.sock', version: '1', connect, backoffMs: [100, 200] });
    const states: unknown[] = [];
    const connected: boolean[] = [];
    link.on('state', frame => states.push(frame));
    link.on('connected', value => connected.push(value));
    link.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(link.connected).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(link.connected).toBe(true);
    expect(connections[0].sent.map(frame => frame.type)).toEqual(['hello', 'subscribe']);
    connections[0].answer({ schema: 1, type: 'hello', daemonVersion: '1', profileId: 'p', state });
    expect(link.state?.gameOperation?.id).toBe('game-1');
    expect(states).toHaveLength(1);
    connections[0].close();
    expect(link.connected).toBe(false);
    expect(link.state).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    expect(connections).toHaveLength(2);
    expect(connected).toEqual([true, false, true]);
    link.stop();
    expect(connections[1].open).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connections).toHaveLength(2);
    vi.useRealTimers();
  });

  it('resolves launch with the operation id, rejects with the daemon message and sends reload', async () => {
    const connection = new FakeConnection();
    const link = new DaemonLink({ socketPath: '/run/x.sock', version: '1', connect: async () => connection as unknown as DaemonConnection });
    await expect(link.launch('0123456789abcdef', {})).rejects.toThrow('not connected');
    link.start();
    await new Promise(resolve => setImmediate(resolve));
    const accepted = link.launch('0123456789abcdef', { DISPLAY: ':0' });
    const request = connection.sent.find(frame => frame.type === 'launch') as Extract<ClientFrame, { type: 'launch' }>;
    expect(request).toMatchObject({ gameId: '0123456789abcdef', env: { DISPLAY: ':0' }, attach: false });
    connection.answer({ schema: 1, type: 'accepted', requestId: 'other', operationId: 'nope' });
    connection.answer({ schema: 1, type: 'accepted', requestId: request.requestId, operationId: 'game-0123456789abcdef' });
    expect(await accepted).toBe('game-0123456789abcdef');
    const refused = link.launch('0123456789abcdef', {});
    const second = connection.sent.filter(frame => frame.type === 'launch').at(-1) as Extract<ClientFrame, { type: 'launch' }>;
    connection.answer({ schema: 1, type: 'error', requestId: second.requestId, code: 'busy', message: 'Another game is already starting or running.' });
    await expect(refused).rejects.toThrow('Another game is already starting or running.');
    const cancel = link.cancel();
    connection.answer({ schema: 1, type: 'state', state });
    await cancel;
    link.reload();
    expect(connection.sent.at(-1)).toEqual({ schema: 1, type: 'reload' });
    link.stop();
  });

  it('owns a launch it asked to own and claims it back after the daemon restarts, until the game ends', async () => {
    vi.useFakeTimers();
    const connections: FakeConnection[] = [];
    const connect = vi.fn(async () => { const connection = new FakeConnection(); connections.push(connection); return connection as unknown as DaemonConnection; });
    const link = new DaemonLink({ socketPath: '/run/x.sock', version: '1', connect, backoffMs: [100] });
    link.start();
    await vi.advanceTimersByTimeAsync(0);
    const accepted = link.launch('1', {}, true);
    const request = connections[0].sent.find(frame => frame.type === 'launch') as Extract<ClientFrame, { type: 'launch' }>;
    expect(request.attach).toBe(true);
    connections[0].answer({ schema: 1, type: 'accepted', requestId: request.requestId, operationId: 'game-1' });
    await accepted;
    connections[0].answer({ schema: 1, type: 'state', state });
    connections[0].close();
    await vi.advanceTimersByTimeAsync(100);
    expect(connections[1].sent).toContainEqual({ schema: 1, type: 'attach', operationId: 'game-1' });
    connections[1].answer({ schema: 1, type: 'state', state: { ...state, gameOperation: { ...state.gameOperation, status: 'complete' as const } } });
    connections[1].close();
    await vi.advanceTimersByTimeAsync(100);
    expect(connections[2].sent.map(frame => frame.type)).toEqual(['hello', 'subscribe']);
    link.stop();
    vi.useRealTimers();
  });
});
