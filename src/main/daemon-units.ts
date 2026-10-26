import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export { profileIdOf } from '../shared/profile-id.js';

export interface UnitNames { socket: string; service: string }

export function unitNames(profileId: string): UnitNames {
  if (!/^[0-9a-f]{12}$/.test(profileId)) throw new Error('Invalid Nexus profile id.');
  return { socket: `xodus-nexus-${profileId}.socket`, service: `xodus-nexus-${profileId}.service` };
}

// systemd Exec properties are not shell commands. Quote each literal argument,
// preserving whitespace and escaping its own $ / % expansion rules.
function unitWord(value: string): string {
  if (value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid unit argument.');
  return '"' + value.replace(/[\\"]/g, '\\$&').replace(/\$/g, () => '$$').replace(/%/g, '%%') + '"';
}

function safePath(value: string, what: string): string {
  if (!path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) || value.includes('/.mount_')) throw new Error(`Invalid ${what} for the background service.`);
  return value;
}

export interface RenderOptions { profileId: string; launcher: string; userData: string }

export function marker(profileId: string): string { return `# X-Xodus-Nexus-Profile=${profileId}`; }

/** The socket-activated pair; only the socket is enabled, the service follows it. */
export function renderUnits({ profileId, launcher, userData }: RenderOptions): { socket: string; service: string } {
  const names = unitNames(profileId);
  // `env -i` scrubs the user manager's inherited session variables, so the
  // socket-activation variables systemd sets for this very exec must be passed
  // through explicitly (systemd expands ${VAR} before the exec).
  const exec = [
    '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'HOME=%h', 'USER=%u', 'XDG_RUNTIME_DIR=%t', 'DBUS_SESSION_BUS_ADDRESS=unix:path=%t/bus',
    'LISTEN_FDS=${LISTEN_FDS}', 'LISTEN_PID=${LISTEN_PID}', 'LISTEN_FDNAMES=${LISTEN_FDNAMES}',
    unitWord(safePath(launcher, 'launcher path')), '--nexus-daemon', '--nexus-profile', unitWord(safePath(userData, 'profile path')),
  ].join(' ');
  const socket = [
    '[Unit]', 'Description=Xodus Nexus game daemon socket', marker(profileId), '',
    '[Socket]', `ListenStream=%t/xodus-nexus/${profileId}.sock`, 'SocketMode=0600', 'DirectoryMode=0700', 'RemoveOnStop=yes', '',
    '[Install]', 'WantedBy=sockets.target', '',
  ].join('\n');
  const service = [
    '[Unit]', 'Description=Xodus Nexus game daemon', marker(profileId), `Requires=${names.socket}`, `After=${names.socket}`,
    '# Deliberately not PartOf=graphical-session.target: the daemon outlives a',
    '# Desktop/Gaming Mode switch; each game gets its Steam client\'s display environment.',
    'StartLimitIntervalSec=60', 'StartLimitBurst=5', '',
    '[Service]', 'Type=exec', `ExecStart=${exec}`,
    '# A daemon crash must not take the running game or xodus-service with it.',
    'KillMode=process', 'TimeoutStopSec=150', 'Restart=on-failure', 'RestartSec=2', 'StandardOutput=journal', 'StandardError=journal', '',
  ].join('\n');
  return { socket, service };
}

export type UnitRunner = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number | null; output: string }>;

const defaultRunner: UnitRunner = (file, args, env) => new Promise(resolve => {
  execFile(file, args, { env, timeout: 15_000, maxBuffer: 65_536 }, (error, stdout, stderr) => {
    const code = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : error ? null : 0;
    resolve({ code: error ? (code ?? null) : 0, output: `${stdout ?? ''}${stderr ?? ''}` });
  });
});

export interface DaemonUnitsOptions {
  /** `~/.config` */
  configHome: string;
  /** `$XDG_RUNTIME_DIR` */
  runtimeDir: string;
  run?: UnitRunner;
  uid?: number;
}

/** Installs and controls the per-profile user units; the daemon itself lives in the AppImage. */
export class DaemonUnits {
  private readonly run: UnitRunner;
  private readonly uid: number | undefined;
  constructor(private readonly options: DaemonUnitsOptions) {
    this.run = options.run ?? defaultRunner;
    this.uid = options.uid ?? process.getuid?.();
  }

  private get directory(): string { return path.join(this.options.configHome, 'systemd', 'user'); }
  private file(name: string): string { return path.join(this.directory, name); }

  private async systemctl(...args: string[]): Promise<string> {
    const runtime = this.options.runtimeDir;
    if (!path.isAbsolute(runtime) || /[\x00-\x20\x7f,;%=]/.test(runtime)) throw new Error('Unavailable user manager.');
    const env = { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.posix.join(runtime, 'bus')}` };
    const result = await this.run('/usr/bin/systemctl', ['--user', ...args], env);
    if (result.code !== 0) throw new Error(`systemctl --user ${args[0]} failed (exit code ${result.code ?? 'unknown'}).`);
    return result.output;
  }

  private async owned(file: string, profileId: string): Promise<boolean> {
    try {
      const stat = await fs.lstat(file);
      // Ownership and mode are POSIX facts; on other platforms only the marker decides.
      if (!stat.isFile() || (this.uid !== undefined && stat.uid !== this.uid) || (process.platform !== 'win32' && (stat.mode & 0o022))) return false;
      return (await fs.readFile(file, 'utf8')).split('\n').includes(marker(profileId));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }

  private async write(file: string, content: string, profileId: string): Promise<void> {
    try {
      await fs.lstat(file);
      if (!await this.owned(file, profileId)) throw new Error('Refusing to replace an unrelated systemd unit file.');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const temporary = `${file}.${randomUUID()}`;
    try {
      await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }

  async installed(profileId: string): Promise<boolean> {
    const names = unitNames(profileId);
    return (await this.owned(this.file(names.socket), profileId)) && (await this.owned(this.file(names.service), profileId));
  }

  async install(options: RenderOptions): Promise<void> {
    const names = unitNames(options.profileId);
    const rendered = renderUnits(options);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.write(this.file(names.socket), rendered.socket, options.profileId);
    await this.write(this.file(names.service), rendered.service, options.profileId);
    await this.systemctl('daemon-reload');
    await this.systemctl('enable', '--now', names.socket);
  }

  async remove(profileId: string): Promise<void> {
    const names = unitNames(profileId);
    await this.systemctl('disable', '--now', names.socket).catch(() => undefined);
    await this.systemctl('stop', names.service).catch(() => undefined);
    for (const name of [names.socket, names.service]) {
      if (await this.owned(this.file(name), profileId)) await fs.rm(this.file(name), { force: true });
    }
    await this.systemctl('daemon-reload');
  }

  async start(profileId: string): Promise<void> { await this.systemctl('start', unitNames(profileId).socket); }
  async stop(profileId: string): Promise<void> { await this.systemctl('stop', unitNames(profileId).service); }
  async resetFailed(profileId: string): Promise<void> { await this.systemctl('reset-failed', unitNames(profileId).service).catch(() => undefined); }

  async isActive(profileId: string): Promise<'active' | 'inactive' | 'failed' | 'unknown'> {
    const result = await this.run('/usr/bin/systemctl', ['--user', 'is-active', unitNames(profileId).service],
      { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: this.options.runtimeDir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.posix.join(this.options.runtimeDir, 'bus')}` });
    const value = result.output.trim();
    return value === 'active' || value === 'inactive' || value === 'failed' ? value : 'unknown';
  }
}

