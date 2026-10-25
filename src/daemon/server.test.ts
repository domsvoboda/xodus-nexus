import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeFrame, FrameReader, parseDaemonFrame, type ClientFrame, type DaemonFrame, type DaemonState } from '../shared/daemon-protocol.js';
import { DaemonServer } from './server.js';
import { DaemonError, type GameController } from './controller.js';

const linux = process.platform !== 'win32';

/** A scripted stand-in for the controller: the server only needs its events and verbs. */
function fakeController() {
  const stateListeners = new Set<(state: DaemonState) => void>();
  const logListeners = new Set<(operationId: string, line: string) => void>();
  const exitListeners = new Set<(operationId: string, code: number | null, status: 'complete' | 'failed') => void>();
  const fake = {
    owner: undefined as string | undefined,
    busy: false,
    launches: [] as { gameId: string; env: Record<string, string>; owner?: string }[],
    cancelled: 0,
    lost: [] as string[],
    state: (): DaemonState => ({ session: { warm: false }, connectivity: { state: 'online' } }),
    onState: (listener: (state: DaemonState) => void) => { stateListeners.add(listener); return () => stateListeners.delete(listener); },
    onLog: (listener: (operationId: string, line: string) => void) => { logListeners.add(listener); return () => logListeners.delete(listener); },
    onExit: (listener: (operationId: string, code: number | null, status: 'complete' | 'failed') => void) => { exitListeners.add(listener); return () => exitListeners.delete(listener); },
    async launch(request: { gameId: string; env: Record<string, string> }, owner?: string) {
      if (fake.busy) throw new DaemonError('busy', 'Another game is already starting or running.');
      if (request.gameId === 'ffffffffffffffff') throw new DaemonError('wallet-locked', 'Wallet locked.');
      fake.busy = true; fake.owner = owner; fake.launches.push({ ...request, owner });
      return { operationId: `game-${request.gameId}` };
    },
    async cancel() { fake.cancelled++; },
    attach(operationId: string, owner: string) { if (!fake.busy || operationId !== `game-${fake.launches.at(-1)?.gameId}`) return false; fake.owner = owner; return true; },
    ownerLost(owner: string) { fake.lost.push(owner); if (fake.owner === owner) { fake.owner = undefined; fake.cancelled++; } },
    emitLog(operationId: string, line: string) { for (const listener of logListeners) listener(operationId, line); },
    emitExit(operationId: string, code: number | null, status: 'complete' | 'failed') { fake.busy = false; for (const listener of exitListeners) listener(operationId, code, status); },
    emitState() { for (const listener of stateListeners) listener(fake.state()); },
  };
  return fake;
}

class TestClient {
  private readonly reader = new FrameReader();
  readonly frames: DaemonFrame[] = [];
  readonly closed: Promise<void>;
  private constructor(readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => { for (const line of this.reader.push(chunk)) this.frames.push(parseDaemonFrame(line)); });
    this.closed = new Promise(resolve => socket.once('close', () => resolve()));
  }
  static connect(socketPath: string): Promise<TestClient> {
    return new Promise((resolve, reject) => { const socket = createConnection(socketPath); socket.once('connect', () => resolve(new TestClient(socket))); socket.once('error', reject); });
  }
  send(frame: ClientFrame | string): void { this.socket.write(typeof frame === 'string' ? frame : encodeFrame(frame)); }
  async until(predicate: (frame: DaemonFrame) => boolean): Promise<DaemonFrame> {
    await vi.waitFor(() => expect(this.frames.some(predicate)).toBe(true), { timeout: 3_000 });
    return this.frames.find(predicate)!;
  }
}

describe.skipIf(!linux)('DaemonServer', () => {
  let root: string;
  let socketPath: string;
  let net: Server;
  let controller: ReturnType<typeof fakeController>;
  let server: DaemonServer;
  const exits: string[] = [];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-daemon-'));
    socketPath = path.join(root, 'd.sock');
    controller = fakeController();
    server = new DaemonServer(controller as unknown as GameController, { version: '0.0.0-test', profileId: 'abc123def456', log: () => {}, requestExitWhenIdle: () => exits.push('reload') });
    net = createServer();
    server.attach(net);
    await new Promise<void>(resolve => net.listen(socketPath, resolve));
  });
  afterEach(async () => { server.close(); await new Promise<void>(resolve => net.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); });

  it('handshakes, launches for an owning client, streams logs and reports exit', async () => {
    const client = await TestClient.connect(socketPath);
    client.send({ schema: 1, type: 'hello', client: 'steam', version: '1' });
    const hello = await client.until(frame => frame.type === 'hello');
    expect(hello).toMatchObject({ daemonVersion: '0.0.0-test', profileId: 'abc123def456' });
    client.send({ schema: 1, type: 'launch', requestId: 'r1', gameId: '0123456789abcdef', env: { DISPLAY: ':0' }, attach: true });
    const accepted = await client.until(frame => frame.type === 'accepted');
    expect(accepted).toMatchObject({ requestId: 'r1', operationId: 'game-0123456789abcdef' });
    expect(controller.launches[0]).toMatchObject({ gameId: '0123456789abcdef', env: { DISPLAY: ':0' } });
    expect(controller.owner).toBeDefined();
    controller.emitLog('game-0123456789abcdef', 'Proton prefix ready');
    await client.until(frame => frame.type === 'log' && frame.line === 'Proton prefix ready');
    controller.emitExit('game-0123456789abcdef', 0, 'complete');
    const exit = await client.until(frame => frame.type === 'exit');
    expect(exit).toMatchObject({ code: 0, status: 'complete' });
  });

  it('stops the game when the owning client disappears, and leaves non-owners alone', async () => {
    const watcher = await TestClient.connect(socketPath);
    watcher.send({ schema: 1, type: 'hello', client: 'electron', version: '1' });
    watcher.send({ schema: 1, type: 'subscribe' });
    await watcher.until(frame => frame.type === 'state');
    const owner = await TestClient.connect(socketPath);
    owner.send({ schema: 1, type: 'hello', client: 'steam', version: '1' });
    owner.send({ schema: 1, type: 'launch', requestId: 'r', gameId: '0123456789abcdef', env: {}, attach: true });
    await owner.until(frame => frame.type === 'accepted');
    owner.socket.destroy();
    await vi.waitFor(() => expect(controller.cancelled).toBe(1));
    expect(controller.owner).toBeUndefined();
    watcher.socket.destroy();
    await vi.waitFor(() => expect(controller.lost).toHaveLength(2));
    expect(controller.cancelled).toBe(1);
  });

  it('maps controller errors to typed error frames and rejects a busy daemon', async () => {
    const client = await TestClient.connect(socketPath);
    client.send({ schema: 1, type: 'hello', client: 'steam', version: '1' });
    client.send({ schema: 1, type: 'launch', requestId: 'w', gameId: 'ffffffffffffffff', env: {}, attach: true });
    expect(await client.until(frame => frame.type === 'error')).toMatchObject({ requestId: 'w', code: 'wallet-locked' });
    client.send({ schema: 1, type: 'launch', requestId: 'a', gameId: '0123456789abcdef', env: {}, attach: true });
    await client.until(frame => frame.type === 'accepted');
    client.send({ schema: 1, type: 'launch', requestId: 'b', gameId: '0123456789abcdee', env: {}, attach: true });
    expect(await client.until(frame => frame.type === 'error' && frame.requestId === 'b')).toMatchObject({ code: 'busy' });
    client.send({ schema: 1, type: 'reload' });
    client.send({ schema: 1, type: 'ping' });
    await client.until(frame => frame.type === 'pong');
    expect(exits).toContain('reload');
  });

  it('lets a reconnecting client re-own its game by operation id', async () => {
    const first = await TestClient.connect(socketPath);
    first.send({ schema: 1, type: 'hello', client: 'steam', version: '1' });
    first.send({ schema: 1, type: 'launch', requestId: 'r', gameId: '0123456789abcdef', env: {}, attach: true });
    await first.until(frame => frame.type === 'accepted');
    const second = await TestClient.connect(socketPath);
    second.send({ schema: 1, type: 'hello', client: 'steam', version: '1' });
    second.send({ schema: 1, type: 'attach', operationId: 'game-0123456789abcdef' });
    await second.until(frame => frame.type === 'state');
    first.socket.destroy();
    await vi.waitFor(() => expect(controller.lost).toHaveLength(1));
    expect(controller.cancelled).toBe(0);
    second.send({ schema: 1, type: 'attach', operationId: 'game-nope' });
    expect(await second.until(frame => frame.type === 'error')).toMatchObject({ code: 'game-not-found' });
  });

  it('refuses frames before hello and malformed input with a schema error, then hangs up', async () => {
    const early = await TestClient.connect(socketPath);
    early.send({ schema: 1, type: 'ping' });
    expect(await early.until(frame => frame.type === 'error')).toMatchObject({ code: 'schema' });
    await early.closed;
    const garbage = await TestClient.connect(socketPath);
    garbage.send('{"schema":1,"type":"hello","client":"steam","version":"1"}\nnot json\n');
    expect(await garbage.until(frame => frame.type === 'error')).toMatchObject({ code: 'schema', message: 'Frame is not JSON.' });
    await garbage.closed;
  });
});
