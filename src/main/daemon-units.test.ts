import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonUnits, marker, profileIdOf, renderUnits, unitNames, type UnitRunner } from './daemon-units.js';

const profileId = 'abc123def456';
let root: string;
let run: ReturnType<typeof vi.fn<UnitRunner>>;
let units: DaemonUnits;
const options = { profileId, launcher: '/home/deck/.local/opt/xodus-nexus/Xodus-Nexus.AppImage', userData: '/home/deck/.config/xodus-nexus' };

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-units-'));
  run = vi.fn<UnitRunner>(async () => ({ code: 0, output: '' }));
  units = new DaemonUnits({ configHome: root, runtimeDir: '/run/user/1000', run, uid: process.getuid?.() });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('unit rendering', () => {
  it('derives names and a stable profile id', () => {
    expect(profileIdOf('/home/deck/.config/xodus-nexus')).toMatch(/^[0-9a-f]{12}$/);
    expect(unitNames(profileId)).toEqual({ socket: `xodus-nexus-${profileId}.socket`, service: `xodus-nexus-${profileId}.service` });
    expect(() => unitNames('../evil')).toThrow('Invalid Nexus profile id.');
  });

  it('renders a socket-activated pair that survives a daemon crash without killing the game', () => {
    const rendered = renderUnits(options);
    expect(rendered.socket).toContain(marker(profileId));
    expect(rendered.socket).toContain(`ListenStream=%t/xodus-nexus/${profileId}.sock`);
    expect(rendered.socket).toContain('SocketMode=0600');
    expect(rendered.socket).toContain('DirectoryMode=0700');
    expect(rendered.socket).toContain('WantedBy=sockets.target');
    expect(rendered.service).toContain(marker(profileId));
    expect(rendered.service).toContain(`Requires=xodus-nexus-${profileId}.socket`);
    expect(rendered.service).toContain('KillMode=process');
    expect(rendered.service).toContain('Restart=on-failure');
    expect(rendered.service).toContain('StartLimitBurst=5');
    expect(rendered.service).toContain('TimeoutStopSec=150');
    expect(rendered.service).not.toContain('PartOf=graphical-session.target\n');
    expect(rendered.service).not.toContain('[Install]');
    expect(rendered.service).toContain(`ExecStart=/usr/bin/env -i PATH=/usr/bin:/bin HOME=%h USER=%u XDG_RUNTIME_DIR=%t DBUS_SESSION_BUS_ADDRESS=unix:path=%t/bus LISTEN_FDS=\${LISTEN_FDS} LISTEN_PID=\${LISTEN_PID} LISTEN_FDNAMES=\${LISTEN_FDNAMES} "${options.launcher}" --nexus-daemon --nexus-profile "${options.userData}"`);
  });

  it('escapes systemd expansions in paths and refuses unstable or unsafe ones', () => {
    const rendered = renderUnits({ ...options, launcher: '/opt/100%/$HOME "x"/Nexus.AppImage' });
    expect(rendered.service).toContain('"/opt/100%%/$$HOME \\"x\\"/Nexus.AppImage"');
    expect(() => renderUnits({ ...options, launcher: '/tmp/.mount_abc/xodus-nexus' })).toThrow('Invalid launcher path');
    expect(() => renderUnits({ ...options, launcher: 'relative/Nexus.AppImage' })).toThrow('Invalid launcher path');
    expect(() => renderUnits({ ...options, userData: '/x\nExecStart=evil' })).toThrow('Invalid profile path');
  });
});

describe('DaemonUnits', () => {
  it('installs both files atomically, reloads and enables only the socket', async () => {
    await units.install(options);
    const directory = path.join(root, 'systemd', 'user');
    const names = unitNames(profileId);
    expect(await fs.readFile(path.join(directory, names.socket), 'utf8')).toContain('[Socket]');
    expect(await fs.readFile(path.join(directory, names.service), 'utf8')).toContain('[Service]');
    expect(await fs.readdir(directory)).toEqual(expect.arrayContaining([names.socket, names.service]));
    expect((await fs.readdir(directory)).filter(name => name.includes('.sock.') || name.includes('.service.'))).toEqual([]);
    expect(run.mock.calls.map(([file, args]) => [file, args])).toEqual([
      ['/usr/bin/systemctl', ['--user', 'daemon-reload']],
      ['/usr/bin/systemctl', ['--user', 'enable', '--now', names.socket]],
    ]);
    for (const [, , env] of run.mock.calls) expect(env).toEqual({ PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' });
    expect(await units.installed(profileId)).toBe(true);
    // A second install replaces the marker files in place.
    await units.install({ ...options, launcher: '/home/deck/other/Nexus.AppImage' });
    expect(await fs.readFile(path.join(directory, names.service), 'utf8')).toContain('/home/deck/other/Nexus.AppImage');
  });

  it('refuses to overwrite or delete unit files without the profile marker', async () => {
    const directory = path.join(root, 'systemd', 'user');
    await fs.mkdir(directory, { recursive: true });
    const foreign = path.join(directory, unitNames(profileId).socket);
    await fs.writeFile(foreign, '[Unit]\nDescription=Someone else\n');
    await expect(units.install(options)).rejects.toThrow('unrelated systemd unit');
    expect(await units.installed(profileId)).toBe(false);
    await units.remove(profileId);
    expect(await fs.readFile(foreign, 'utf8')).toContain('Someone else');
  });

  it('removes its own units, tolerating stop failures, and maps is-active output', async () => {
    await units.install(options);
    run.mockClear();
    run.mockImplementation(async (_file, args) => args.includes('disable') ? { code: 1, output: 'not loaded' } : { code: 0, output: '' });
    await units.remove(profileId);
    const names = unitNames(profileId);
    expect(await fs.readdir(path.join(root, 'systemd', 'user'))).toEqual([]);
    expect(run.mock.calls.map(([, args]) => args)).toEqual([
      ['--user', 'disable', '--now', names.socket], ['--user', 'stop', names.service], ['--user', 'daemon-reload'],
    ]);
    for (const [output, expected] of [['active\n', 'active'], ['inactive', 'inactive'], ['failed', 'failed'], ['activating', 'unknown']] as const) {
      run.mockResolvedValueOnce({ code: output === 'active\n' ? 0 : 3, output });
      expect(await units.isActive(profileId)).toBe(expected);
    }
  });

  it('surfaces systemctl failures without their raw output', async () => {
    run.mockResolvedValue({ code: 1, output: 'Failed to connect to bus: /run/user/1000/bus secret' });
    await expect(units.install(options)).rejects.toThrow('systemctl --user daemon-reload failed (exit code 1).');
    await expect(units.start(profileId)).rejects.not.toThrow('secret');
  });
});
