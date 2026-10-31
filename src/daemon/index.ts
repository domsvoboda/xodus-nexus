import { createWriteStream, fstatSync, promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileIdOf } from '../shared/profile-id.js';
import { shortcutArguments } from '../main/game-shortcuts.js';
import { daemonSocketPath } from '../main/daemon-client.js';
import { BackendDiagnostics, setBackendDiagnostics } from '../main/backend-diagnostics.js';
import { GameController } from './controller.js';
import { DaemonServer } from './server.js';
import { bundledCloseHelper } from '../main/graceful-close.js';
import { socketReady } from '../main/xodus-service.js';


const IDLE_EXIT_MS = 10 * 60_000;
const IDLE_CHECK_MS = 30_000;

async function launcherVersion(): Promise<string> {
  for (const candidate of ['../../package.json', '../../../package.json']) {
    try {
      const parsed = JSON.parse(await fs.readFile(fileURLToPath(new URL(candidate, import.meta.url)), 'utf8')) as { version?: string };
      if (parsed.version) return parsed.version;
    } catch { /* Try the next layout. */ }
  }
  return 'unknown';
}

async function privateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error(`Unsafe runtime directory: ${directory}`);
}

function activationSocket(): boolean {
  try { return fstatSync(3).isSocket(); }
  catch { return false; }
}

async function listen(server: Server, socketPath: string): Promise<string> {
  // systemd socket activation hands over the listening socket on fd 3. The
  // AppImage runtime forks before AppRun runs, so LISTEN_PID names an ancestor;
  // trust the fd itself instead.
  if (process.env.LISTEN_FDS === '1' && activationSocket()) {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen({ fd: 3 }, () => { server.removeListener('error', reject); resolve(); }); });
    return 'systemd socket';
  }
  await privateDirectory(path.dirname(socketPath));
  // Started by hand while the socket unit holds this path: never unlink a live
  // listener, or activation breaks until the socket unit is restarted.
  if (await socketReady(socketPath)) { process.stderr.write(`Another Nexus daemon already listens on ${socketPath}; nothing to do.
`); process.exit(0); }
  await fs.rm(socketPath, { force: true });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); }); });
  await fs.chmod(socketPath, 0o600);
  return socketPath;
}

async function main(): Promise<void> {
  const request = shortcutArguments(process.argv.slice(2));
  const userData = request.profile ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'xodus-nexus');
  const profileId = profileIdOf(userData);
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (!runtimeDir || !path.isAbsolute(runtimeDir)) throw new Error('XDG_RUNTIME_DIR is required.');
  const version = await launcherVersion();

  let logFile: ReturnType<typeof createWriteStream> | undefined;
  const log = (line: string) => {
    const stamped = `[${new Date().toISOString()}] ${line}`;
    process.stderr.write(stamped + '\n');
    logFile?.write(stamped + '\n');
  };
  const diagnostics = new BackendDiagnostics(path.join(userData, 'daemon'));
  setBackendDiagnostics(diagnostics);

  const runtimeRoot = path.join(runtimeDir, 'xodus-nexus', profileId);
  await privateDirectory(path.dirname(runtimeRoot));
  await privateDirectory(runtimeRoot);
  const closeHelper = await bundledCloseHelper();
  const controller = new GameController({ userData, home: os.homedir(), runtimeRoot, log, closeHelper });
  await controller.start();
  log(closeHelper ? `Graceful close helper: ${closeHelper}.` : 'No graceful close helper in this build; Exit game falls back to signals.');
  const dataRoot = path.dirname(controller.store.settings.runtimeRoot);
  try {
    await fs.mkdir(path.join(dataRoot, 'logs'), { recursive: true });
    logFile = createWriteStream(path.join(dataRoot, 'logs', 'daemon.log'), { flags: 'a', encoding: 'utf8', mode: 0o600 });
    logFile.on('error', () => { logFile = undefined; });
  } catch { /* stderr (journald) remains. */ }

  let exitWhenIdle = false;
  const server = new DaemonServer(controller, { version, profileId, log, requestExitWhenIdle: () => { exitWhenIdle = true; } });
  const net = createServer();
  server.attach(net);
  const bound = await listen(net, daemonSocketPath(runtimeDir, profileId));
  log(`Xodus Nexus daemon ${version} for profile ${profileId} listening on ${bound}.`);

  let idleSince = Date.now();
  let stopping = false;
  const shutdown = async (reason: string, code = 0) => {
    if (stopping) return;
    stopping = true;
    log(`Shutting down: ${reason}.`);
    clearInterval(idleTimer);
    net.close();
    server.close();
    await controller.stop();
    await diagnostics.flush().catch(() => undefined);
    await new Promise<void>(resolve => (logFile ? logFile.end(resolve) : resolve()));
    process.exit(code);
  };
  const idleTimer = setInterval(() => {
    if (controller.busy || server.clientCount > 0) { idleSince = Date.now(); return; }
    if (exitWhenIdle && controller.idle) void shutdown('reload requested');
    else if (controller.idle && Date.now() - idleSince > IDLE_EXIT_MS) void shutdown('idle');
  }, IDLE_CHECK_MS);
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGHUP', () => { exitWhenIdle = true; });
}

main().catch(error => {
  process.stderr.write(`Xodus Nexus daemon failed: ${(error as Error).message}\n`);
  process.exit(1);
});

