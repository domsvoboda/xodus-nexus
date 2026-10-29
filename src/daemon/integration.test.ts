import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeFrame, FrameReader, parseDaemonFrame, type ClientFrame, type DaemonFrame } from '../shared/daemon-protocol.js';
import { LINUX_RUN_PATCH } from '../main/backend.js';
import { GameController } from './controller.js';
import { DaemonServer } from './server.js';

// End to end through the real controller, server, launch core and process
// handling: only xodus-cli and Wine are stand-ins. The fake `run` behaves like
// a game whose runtime uploads its saves when asked to quit (SIGINT; there is
// no X server here, so the close helper is not used).
const linux = process.platform !== 'win32';
const GAME_ID = '0123456789abcdef';

const FAKE_CLI = `#!/bin/sh
case "$1" in
  --help) printf 'xodus-cli 0.0.0-test\\n\\nCommands:\\n  login      Sign in\\n  account    Account\\n  streaming  Install\\n  run        Run a game\\n' ;;
  account) printf '{"stored":false}\\n' ;;
  streaming) printf 'Usage: xodus-cli streaming\\n' ;;
  run)
    [ "$2" = --help ] && { printf 'Usage: xodus-cli run\\n  --license-cache <DIR>\\n  --offline\\n'; exit 0; }
    cd "$2" || exit 3
    trap 'echo "uploading saves"; sleep 2; echo uploaded > "$2/uploaded"; echo "saves uploaded"; exit 0' INT
    trap 'echo "killed"; exit 143' TERM
    echo "game started as $XODUS_NEXUS_LAUNCH_ID"
    echo "$$" > "$2/pid"
    while :; do sleep 0.1; done ;;
  *) exit 2 ;;
esac
`;

class Client {
  private readonly reader = new FrameReader();
  readonly frames: DaemonFrame[] = [];
  private constructor(readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => { for (const line of this.reader.push(chunk)) this.frames.push(parseDaemonFrame(line)); });
  }
  static connect(socketPath: string): Promise<Client> {
    return new Promise((resolve, reject) => { const socket = createConnection(socketPath); sockets.add(socket); socket.once('connect', () => resolve(new Client(socket))); socket.once('error', reject); });
  }
  send(frame: ClientFrame): void { this.socket.write(encodeFrame(frame)); }
  async until<T extends DaemonFrame>(predicate: (frame: DaemonFrame) => frame is T, timeoutMs = 20_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.frames.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`Timed out; frames: ${JSON.stringify(this.frames.map(frame => frame.type))}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

let root: string;
let gameDir: string;
let controller: GameController;
let net: Server;
let socketPath: string;
const log: string[] = [];
const sockets = new Set<Socket>();

async function startDaemon(): Promise<void> {
  controller = new GameController({ userData: path.join(root, 'userData'), home: root, runtimeRoot: path.join(root, 'run'), log: line => log.push(line) });
  // No network probes from tests: Microsoft counts as reachable.
  controller.connectivity.check = async () => ({ state: 'online' });
  await controller.start();
  net = createServer();
  new DaemonServer(controller, { version: 'test', profileId: 'test', log: line => log.push(line), requestExitWhenIdle: () => {} }).attach(net);
  await new Promise<void>(resolve => net.listen(socketPath, resolve));
}

async function steamClient(): Promise<{ client: Client; operationId: string }> {
  const client = await Client.connect(socketPath);
  client.send({ schema: 1, type: 'hello', client: 'steam', version: '1' });
  await client.until((frame): frame is DaemonFrame & { type: 'hello' } => frame.type === 'hello');
  client.send({ schema: 1, type: 'launch', requestId: 'r1', gameId: GAME_ID, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, attach: true });
  const accepted = await client.until((frame): frame is DaemonFrame & { type: 'accepted' } => frame.type === 'accepted' || (frame.type === 'error' && (() => { throw new Error(frame.message); })()));
  await client.until((frame): frame is DaemonFrame & { type: 'log' } => frame.type === 'log' && frame.line.includes('game started as game-' + GAME_ID));
  return { client, operationId: accepted.operationId };
}

const exists = (file: string) => fs.access(file).then(() => true, () => false);

describe.skipIf(!linux)('background daemon end to end', { timeout: 60_000 }, () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-daemon-e2e-'));
    gameDir = path.join(root, 'game');
    socketPath = path.join(root, 'daemon.sock');
    log.length = 0;
    await fs.mkdir(gameDir);
    await fs.writeFile(path.join(gameDir, 'MicrosoftGame.config'), '<Game><Identity Name="Test.Game" Version="1.0.0.0"/><ExecutableList><Executable Name="Game.exe"/></ExecutableList></Game>');
    await fs.writeFile(path.join(gameDir, 'Game.exe'), 'MZ fixture');
    await fs.writeFile(path.join(gameDir, '.xodus-streaming.msixvc'), 'fixture');
    const release = path.join(root, 'userData', 'xodus-backends', 'releases', 'test');
    await fs.mkdir(release, { recursive: true });
    await fs.writeFile(path.join(release, 'xodus-cli'), FAKE_CLI, { mode: 0o755 });
    await fs.writeFile(path.join(root, 'userData', 'xodus-backends', 'current.json'), JSON.stringify({ commit: 'test', binaryPath: path.join(release, 'xodus-cli'), builtAt: new Date().toISOString(), linuxRunPatch: LINUX_RUN_PATCH }));
    await fs.writeFile(path.join(root, 'wine'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await fs.writeFile(path.join(root, 'userData', 'launcher-state.json'), JSON.stringify({
      settings: { winePath: path.join(root, 'wine'), runtimeRoot: path.join(root, 'data', 'runtimes'), market: 'US' },
      games: [{ id: GAME_ID, title: 'Test Game', path: gameDir, installState: 'ready', executable: 'Game.exe' }],
      downloads: [],
    }));
    await startDaemon();
  }, 30_000);

  afterEach(async () => {
    // net.close waits for every connection; a failed test may leave clients open.
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await controller.stop().catch(() => undefined);
    await new Promise<void>(resolve => net.close(() => resolve()));
    const pid = Number(await fs.readFile(path.join(gameDir, 'pid'), 'utf8').catch(() => '0'));
    if (pid) try { process.kill(-pid, 'SIGKILL'); } catch { /* Already gone. */ }
    await fs.rm(root, { recursive: true, force: true });
  }, 90_000);

  it('runs a Steam launch and, when Steam kills the client, lets the game upload its saves before it exits', async () => {
    const { client, operationId } = await steamClient();
    expect(controller.state().gameOperation).toMatchObject({ id: operationId, status: 'running' });
    // Steam's Exit game: the thin client dies; the daemon closes the game, which uploads first.
    client.socket.destroy();
    await expect.poll(() => controller.state().gameOperation?.status, { timeout: 20_000 }).toBe('complete');
    expect(await fs.readFile(path.join(gameDir, 'uploaded'), 'utf8')).toBe('uploaded\n');
    const gameLog = await fs.readFile(controller.state().gameOperation!.logPath!, 'utf8');
    expect(gameLog).toContain('uploading saves');
    expect(gameLog).toContain('saves uploaded');
    expect(gameLog).toContain('exited with code 0');
    expect(log.join('\n')).toContain('its Steam client went away');
  });

  it('closes on Stop from the launcher, forces a second Stop and refuses a second game meanwhile', async () => {
    const { client } = await steamClient();
    const launcher = await Client.connect(socketPath);
    launcher.send({ schema: 1, type: 'hello', client: 'electron', version: '1' });
    await launcher.until((frame): frame is DaemonFrame & { type: 'hello' } => frame.type === 'hello');
    launcher.send({ schema: 1, type: 'launch', requestId: 'r2', gameId: GAME_ID, env: {}, attach: false });
    const busy = await launcher.until((frame): frame is DaemonFrame & { type: 'error' } => frame.type === 'error' && frame.requestId === 'r2');
    expect(busy.code).toBe('busy');
    launcher.send({ schema: 1, type: 'cancel', requestId: 'c1' });
    await expect.poll(() => controller.state().gameOperation?.status, { timeout: 5_000 }).toBe('stopping');
    launcher.send({ schema: 1, type: 'cancel', requestId: 'c2' });
    await expect.poll(() => controller.state().gameOperation?.status, { timeout: 20_000 }).toBe('complete');
    // The force stop came before the trap's upload finished.
    expect(await exists(path.join(gameDir, 'uploaded'))).toBe(false);
    expect(log.join('\n')).toContain('forcing the game to stop');
    client.socket.destroy();
    launcher.socket.destroy();
  });

  it('keeps the account service out of the way and starts the next launch after the last game closed', async () => {
    const first = await steamClient();
    first.client.socket.destroy();
    await expect.poll(() => controller.state().gameOperation?.status, { timeout: 20_000 }).toBe('complete');
    await fs.rm(path.join(gameDir, 'uploaded'));
    const second = await steamClient();
    expect(controller.state().gameOperation).toMatchObject({ id: second.operationId, status: 'running' });
    second.client.socket.destroy();
    await expect.poll(() => controller.state().gameOperation?.status, { timeout: 20_000 }).toBe('complete');
    expect(await exists(path.join(gameDir, 'uploaded'))).toBe(true);
  });
});
