import { spawn, execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { profileIdOf } from '../shared/profile-id.js';
import { filterClientEnvironment, type DaemonFrame } from '../shared/daemon-protocol.js';
import { shortcutArguments } from '../main/game-shortcuts.js';
import { DaemonConnection, daemonSocketPath } from '../main/daemon-client.js';
import { unitNames } from '../main/daemon-units.js';

const CONNECT_WINDOW_MS = 10_000;
const say = (line: string) => process.stdout.write(`[nexus] ${line}\n`);
const warn = (line: string) => process.stderr.write(`[nexus] ${line}\n`);

/** The installed launcher wrapper beside this binary, or the binary itself. */
export function legacyLauncher(execPath: string): string {
  const wrapper = path.join(path.dirname(execPath), 'xodus-nexus');
  return path.basename(execPath) === 'xodus-nexus.bin' ? wrapper : execPath;
}

/** Today's in-process launch: Electron starts, prepares and runs the game itself. */
export function legacyFallback(profile: string | undefined, gameId: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const launcher = legacyLauncher(process.execPath);
  const args = [...(profile ? ['--nexus-profile', profile] : []), '--launch-game', gameId];
  const { ELECTRON_RUN_AS_NODE: _node, ...rest } = env;
  return new Promise((resolve, reject) => {
    const child = spawn(launcher, args, { stdio: 'inherit', env: rest });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function startUnit(profileId: string, runtimeDir: string): Promise<boolean> {
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  const unit = unitNames(profileId).socket;
  try { await fs.access(path.join(configHome, 'systemd', 'user', unit)); }
  catch { return false; }
  return new Promise(resolve => {
    execFile('/usr/bin/systemctl', ['--user', 'start', unit], {
      env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(runtimeDir, 'bus')}` }, timeout: 15_000,
    }, error => resolve(!error));
  });
}

async function connect(socketPath: string, profileId: string, runtimeDir: string): Promise<DaemonConnection | undefined> {
  const deadline = Date.now() + CONNECT_WINDOW_MS;
  let started = false;
  while (Date.now() < deadline) {
    try { return await DaemonConnection.connect(socketPath, 3_000); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ECONNREFUSED') { warn(`Background service unavailable: ${(error as Error).message}`); return undefined; }
      if (!started) { started = true; if (!await startUnit(profileId, runtimeDir)) return undefined; }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  return undefined;
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<number> {
  const request = shortcutArguments(argv);
  if (!request.gameId) throw new Error('A game shortcut ID is required.');
  const gameId = request.gameId;
  const userData = request.profile ?? path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'xodus-nexus');
  const profileId = profileIdOf(userData);
  const runtimeDir = env.XDG_RUNTIME_DIR;
  const connection = runtimeDir && path.isAbsolute(runtimeDir) ? await connect(daemonSocketPath(runtimeDir, profileId), profileId, runtimeDir) : undefined;
  if (!connection) {
    say('Background service not running; starting Nexus directly.');
    return legacyFallback(request.profile, gameId, env);
  }
  connection.send({ schema: 1, type: 'hello', client: 'steam', version: '1' });
  const hello = await connection.next((frame): frame is DaemonFrame & { type: 'hello' } => frame.type === 'hello', 5_000);
  say(`Connected to Nexus background service ${hello.daemonVersion}.`);
  const requestId = randomUUID();
  connection.send({ schema: 1, type: 'launch', requestId, gameId, env: filterClientEnvironment(env), cwd: process.cwd(), attach: true });
  return new Promise<number>((resolve, reject) => {
    let operationId: string | undefined;
    let exited = false;
    connection.on('frame', frame => {
      switch (frame.type) {
        case 'accepted': if (frame.requestId === requestId) { operationId = frame.operationId; say('Launch accepted.'); } break;
        case 'log': if (!operationId || frame.operationId === operationId) say(frame.line); break;
        case 'error':
          if (frame.requestId !== requestId) break;
          if (frame.code === 'wallet-locked' || frame.code === 'backend-unavailable') {
            say(`${frame.message} Starting Nexus directly.`);
            connection.close();
            legacyFallback(request.profile, gameId, env).then(resolve, reject);
          } else { warn(frame.message); exited = true; connection.close(); resolve(1); }
          break;
        case 'exit':
          if (operationId && frame.operationId !== operationId) break;
          exited = true;
          say(frame.status === 'complete' ? 'The game has exited.' : 'The game exited with an error.');
          connection.close();
          resolve(frame.code ?? (frame.status === 'complete' ? 0 : 1));
          break;
      }
    });
    connection.on('close', error => {
      if (exited) return;
      warn(error ? `Lost the background service: ${error.message}` : 'The background service closed the connection.');
      resolve(1);
    });
  });
}

const entry = Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (entry) {
  main().then(code => { process.exitCode = code; }, error => { warn((error as Error).message); process.exitCode = 1; });
}
