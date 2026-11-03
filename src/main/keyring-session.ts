import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { externalLauncherEnvironment } from './launcher-environment.js';

export type KdeProvider = 'kwallet' | 'kwallet5' | 'ksecretd';
const localDisplay = /^:\d{1,5}(?:\.\d{1,3})?$/;

/** Give only this provider the current display. Never mutate the bus/manager
 * environment, install persistent units, guess :0 or change wallet settings. */
export async function keyringSessionEnvironment(source: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  if (!source.DBUS_SESSION_BUS_ADDRESS?.startsWith('unix:')) throw Error('No local session bus');
  const env = externalLauncherEnvironment(source);
  // The distro provider must use its own Qt and libraries, not Steam/AppImage.
  for (const key of Object.keys(env)) {
    if (key.startsWith('LD_') || key.startsWith('QT_') || key.startsWith('APPIMAGE') || ['APPDIR', 'ARGV0', 'OWD'].includes(key)) delete env[key];
  }
  const uid = process.getuid?.();
  if (source.DISPLAY && localDisplay.test(source.DISPLAY)) {
    const number = source.DISPLAY.slice(1).split('.')[0];
    const socket = await fs.lstat(`/tmp/.X11-unix/X${number}`);
    if (!socket.isSocket() || socket.uid !== uid) throw Error('Unavailable local display');
    if (source.XAUTHORITY) {
      if (!path.isAbsolute(source.XAUTHORITY) || /[\x00-\x1f\x7f]/.test(source.XAUTHORITY)) throw Error('Invalid display authority');
      await fs.access(source.XAUTHORITY, constants.R_OK);
    }
    env.QT_QPA_PLATFORM = 'xcb';
    delete env.WAYLAND_DISPLAY;
  } else {
    const name = source.WAYLAND_DISPLAY;
    if (!name || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,254}$/.test(name)
      || !source.XDG_RUNTIME_DIR || !path.isAbsolute(source.XDG_RUNTIME_DIR)) throw Error('Unavailable local display');
    const socket = await fs.lstat(path.join(source.XDG_RUNTIME_DIR, name));
    if (!socket.isSocket() || socket.uid !== uid) throw Error('Unavailable local display');
    env.QT_QPA_PLATFORM = 'wayland';
    delete env.DISPLAY;
    delete env.XAUTHORITY;
  }
  return env;
}

// systemd Exec properties are not shell commands. Quote each literal argument,
// preserving whitespace and escaping its own $ / % expansion rules.
function unitWord(value: string): string {
  if (value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw Error('Invalid keyring stop helper');
  return '"' + value.replace(/[\\"]/g, '\\$&').replace(/\$/g, () => '$$').replace(/%/g, '%%') + '"';
}

export async function startSessionKeyring(provider: KdeProvider, source: NodeJS.ProcessEnv, owned: () => Promise<boolean>, stopHelper?: string): Promise<void> {
  const env = await keyringSessionEnvironment(source);
  const binary = provider === 'ksecretd' ? '/usr/bin/ksecretd' : provider === 'kwallet5' ? '/usr/bin/kwalletd5' : '/usr/bin/kwalletd6';
  for (const executable of [binary, '/usr/bin/systemd-run', '/usr/bin/env']) {
    const stat = await fs.stat(executable);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022)) throw Error('Unavailable system keyring provider');
    await fs.access(executable, constants.X_OK);
  }
  const runtime = source.XDG_RUNTIME_DIR;
  if (!runtime || !path.isAbsolute(runtime) || /[\x00-\x20\x7f,;%=]/.test(runtime)) throw Error('Unavailable user manager');
  const directory = await fs.lstat(runtime);
  const managerBus = await fs.lstat(path.join(runtime, 'bus'));
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077)
    || !managerBus.isSocket() || managerBus.uid !== process.getuid?.()) throw Error('Unavailable user manager');
  // A provider forked from Steam remains in its reaper even after Nexus exits.
  // A transient user service belongs to the graphical session, not the game.
  // Start with an empty service environment: neither Steam nor stale manager Qt
  // settings, loader paths or unrelated credentials belong in this process.
  const keys = ['HOME', 'USER', 'LOGNAME', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_DIRS', 'XDG_RUNTIME_DIR',
    'XDG_CURRENT_DESKTOP', 'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'QT_QPA_PLATFORM'];
  const assignments = keys.flatMap(key => {
    const value = env[key];
    if (value === undefined) return [];
    if (value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw Error('Invalid keyring session environment');
    return [`${key}=${value}`];
  });
  const stopProperties: string[] = [];
  if (stopHelper !== undefined) {
    if (!path.isAbsolute(stopHelper)) throw Error('Invalid keyring stop helper');
    const stat = await fs.stat(stopHelper);
    if (!stat.isFile() || ![0, process.getuid?.()].includes(stat.uid) || (stat.mode & 0o022)) throw Error('Unavailable keyring stop helper');
    await fs.access(stopHelper, constants.X_OK);
    const command = ['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
      `DBUS_SESSION_BUS_ADDRESS=${env.DBUS_SESSION_BUS_ADDRESS}`, stopHelper, 'keyring-session-stop', '--provider-pid']
      .map(unitWord).join(' ');
    // MAINPID is the systemd-owned provider, never a renderer-supplied PID.
    // The native helper rechecks its UID, executable, Nexus cgroup and unique
    // bus owner, then waits for Qt's normal exit to flush pending wallet writes.
    stopProperties.push(`--property=ExecStop=${command} \${MAINPID}`, '--property=TimeoutStopSec=12s');
  }
  const args = ['--user', '--collect', '--service-type=exec', '--expand-environment=no', '--quiet',
    '--description=Nexus Launcher session wallet',
    `--unit=xodus-nexus-keyring-${randomUUID()}`, '--property=PartOf=graphical-session.target',
    '--property=StandardOutput=null', '--property=StandardError=null', ...stopProperties, '--',
    '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', ...assignments, binary];
  if (await owned()) return;
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/systemd-run', args, {
      env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(runtime, 'bus')}` },
      stdio: 'ignore', shell: false,
    });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Could not start system keyring provider')); }, 10_000);
    child.once('error', () => { clearTimeout(timer); reject(Error('Could not start system keyring provider')); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve(); else reject(Error('Could not start system keyring provider'));
    });
  });
}
