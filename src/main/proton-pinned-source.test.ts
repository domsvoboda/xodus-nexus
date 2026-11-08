import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { prepareProtonRunner, protonLaunchFeatureNotices } from './proton.js';
import { prepareGameWrapper } from './game-wrapper.js';
import { defaultLaunchTools } from '../shared/launch-tools.js';

// Executes the PINNED runtime source read-only under python3. No Wine, Proton,
// game or network process is involved; the extracted functions only read the
// environment and the fixture prefix. Skip unless the source file is provided:
//   XODUS_PROTON_SOURCE=/path/to/the/pinned/proton
const protonSource = process.env.XODUS_PROTON_SOURCE;
const created: string[] = [];
const execFile = promisify(execFileCallback);

afterAll(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/**
 * Extracts the reviewed selectors from the pinned entry script and applies them
 * to the environment the production Play command exports. Nothing else from
 * the script is imported or executed, so no session, prefix or Wine setup runs.
 */
const probe = String.raw`
import json, os, sys, textwrap

source_lines = open(sys.argv[1], encoding='utf-8').read().splitlines()
mode = sys.argv[2]

def block(header, indent=8):
    for index, line in enumerate(source_lines):
        if line.strip() == header and len(line) - len(line.lstrip()) == indent:
            out = [line]
            for follow in source_lines[index + 1:]:
                if not follow.strip():
                    out.append(follow)
                    continue
                if len(follow) - len(follow.lstrip()) <= indent:
                    break
                out.append(follow)
            return textwrap.dedent('\n'.join(out))
    raise SystemExit('missing block: ' + header)

def function(name):
    for index, line in enumerate(source_lines):
        if line.startswith('def ' + name + '('):
            out = [line]
            for follow in source_lines[index + 1:]:
                if follow and not follow.startswith((' ', '\t')):
                    break
                out.append(follow)
            return '\n'.join(out).rstrip()
    raise SystemExit('missing function: ' + name)

def method(name, indent=4):
    for index, line in enumerate(source_lines):
        if len(line) - len(line.lstrip()) == indent and line.lstrip().startswith('def ' + name + '('):
            out = [line]
            for follow in source_lines[index + 1:]:
                if follow.strip() and len(follow) - len(follow.lstrip()) <= indent:
                    break
                out.append(follow)
            return textwrap.dedent('\n'.join(out)).rstrip()
    raise SystemExit('missing method: ' + name)

if mode == 'config':
    namespace = {'os': os}
    exec(function('comma_escaped'), namespace)
    session = type('Session', (), {})()
    session.compat_config = set()
    session.cmdlineappend = []
    namespace['self'] = session
    exec(block('if "STEAM_COMPAT_CONFIG" in os.environ:'), namespace)
    print(json.dumps({'compat_config': sorted(session.compat_config), 'cmdlineappend': session.cmdlineappend}))
elif mode == 'drive':
    def file_exists(value, follow_symlinks=True):
        return os.path.exists(value) if follow_symlinks else os.path.lexists(value)
    def log(*args, **kwargs):
        pass
    namespace = {'os': os, 'log': log, 'file_exists': file_exists}
    for name in ['get_validated_steamapps_parent', 'try_get_game_library_dir', 'setup_dir_drive', 'setup_game_dir_drive']:
        exec(function(name), namespace)
    session = type('Session', (), {})()
    session.env = dict(os.environ)
    # The pinned session adds the gamedrive compat option by default in
    # CachyOS and through PROTON_SET_GAME_DRIVE in Standard. The location
    # mapping below is what the launcher feeds; it never adds this option.
    session.compat_config = {'gamedrive'}
    compatdata = type('CompatData', (), {})()
    compatdata.prefix_dir = os.environ['WINEPREFIX'] + '/'
    namespace['g_session'] = session
    namespace['g_compatdata'] = compatdata
    # A real Proton prefix already has dosdevices; this fixture prefix does not.
    os.makedirs(os.path.join(compatdata.prefix_dir, 'dosdevices'), exist_ok=True)
    namespace['setup_game_dir_drive']()
    link = os.path.join(compatdata.prefix_dir, 'dosdevices', 's:')
    print(json.dumps({'game_drive': os.readlink(link) if os.path.islink(link) else None}))
elif mode == 'logging':
    def file_exists(value, follow_symlinks=True):
        return os.path.exists(value) if follow_symlinks else os.path.lexists(value)
    def makedirs(dir_path):
        os.makedirs(dir_path, exist_ok=True)
    namespace = {'os': os, 'file_exists': file_exists, 'makedirs': makedirs}
    exec(method('setup_logging'), namespace)
    # The pinned CachyOS variant reads the runtime version file for an optional
    # suffix; a missing file is its own documented fallback to no suffix.
    proton = type('Proton', (), {})()
    proton.version_file = os.environ.get('NEXUS_PROBE_VERSION_FILE', os.path.join(os.environ['HOME'], 'absent-version'))
    namespace['g_proton'] = proton
    session = type('Session', (), {})()
    session.env = dict(os.environ)
    configured = os.environ.get('PROTON_LOG')
    invoked = configured is not None and len(configured) > 0 and configured != '0'
    created = bool(namespace['setup_logging'](session, append_forever=False)) if invoked else False
    log = getattr(session, 'log_file', None)
    name = os.path.basename(log.name) if log is not None else None
    if log is not None:
        log.close()
    print(json.dumps({'invoked': invoked, 'created': created, 'name': name}))
else:
    raise SystemExit('unknown mode: ' + mode)
`;

interface Fixture {
  root: string;
  wine: string;
  compat: string;
  install: string;
}

async function fixture(mode: string, installPath?: string): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), `nexus-pinned-${mode}-`)); created.push(root);
  const files = path.join(root, 'runtime/files');
  const wine = path.join(files, 'bin/wine'), proton = path.join(root, 'runtime/proton');
  const compat = path.join(root, 'compat'), system32 = path.join(compat, 'pfx/drive_c/windows/system32');
  const install = installPath ?? path.join(root, 'installs/Game');
  await mkdir(path.dirname(wine), { recursive: true });
  await mkdir(path.join(files, 'share/default_pfx'), { recursive: true });
  await mkdir(system32, { recursive: true });
  for (const name of ['libvkd3d-utils-1.dll', 'dxgi.dll', 'd3d12.dll']) await writeFile(path.join(system32, name), 'fixture');
  await writeFile(wine, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await writeFile(path.join(files, 'bin/wineserver'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const script = path.join(root, 'probe.py');
  await writeFile(script, probe);
  // The fixture Proton session only forwards the Play arguments to the probe,
  // which applies the exact pinned selector to the inherited environment.
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  await writeFile(proton, `#!/bin/sh\n[ "$1" = run ] || exit 0\nshift\nexec python3 ${quote(script)} ${quote(protonSource!)} ${quote(mode)} "$@"\n`, { mode: 0o700 });
  return { root, wine, compat, install };
}

describe.skipIf(!protonSource)('pinned Proton selectors', () => {
  it('parses a compat-config launch option with the pinned runtime parser', async () => {
    const f = await fixture('config'), runner = (await prepareProtonRunner(f.wine, f.compat, path.join(f.root, 'steam')))!;
    // Proton appends each cmdlineappend entry as one argv element and only adds
    // the remaining names to its compat config.
    const value = 'cmdlineappend:--flag one\\,two,wined3d,localshadercache';
    const wrapper = await prepareGameWrapper(runner.launchCommand, { ...defaultLaunchTools,
      launchOptions: `STEAM_COMPAT_CONFIG='${value}' %command%` }, path.join(f.root, 'wrappers'), process.env);
    const { stdout } = await execFile(wrapper.command, ['Z:\\game\\Game.exe'], { env: process.env });
    const parsed = JSON.parse(stdout.trim().split('\n').pop()!);
    expect(parsed).toEqual({ compat_config: ['localshadercache', 'wined3d'], cmdlineappend: ['--flag one,two'] });
    // Empty, literal zero and whitespace-only values stay data and add no option.
    for (const [configured, expected] of [
      ['', { compat_config: [], cmdlineappend: [] }],
      ['0', { compat_config: ['0'], cmdlineappend: [] }],
      [' ', { compat_config: [' '], cmdlineappend: [] }],
    ] as const) {
      const empty = await prepareGameWrapper(runner.launchCommand, { ...defaultLaunchTools,
        launchOptions: `STEAM_COMPAT_CONFIG='${configured}' %command%` }, path.join(f.root, `wrappers-${configured.length ? 'data' : 'empty'}`), process.env);
      const result = JSON.parse((await execFile(empty.command, ['Z:\\game\\Game.exe'], { env: process.env })).stdout.trim().split('\n').pop()!);
      expect(result).toEqual(expected);
      await empty.cleanup();
    }
    await wrapper.cleanup();
  }, 60_000);

  it('matches the pinned logging selector for a Steam launch environment', async () => {
    const f = await fixture('logging');
    const logs = path.join(f.root, 'logs'); await mkdir(logs, { recursive: true });
    const pinned = async (extra: NodeJS.ProcessEnv) => {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: logs };
      for (const name of ['SteamGameId', 'PROTON_LOG', 'PROTON_LOG_DIR', 'NEXUS_PROBE_VERSION_FILE']) delete env[name];
      const { stdout } = await execFile('python3', [path.join(f.root, 'probe.py'), protonSource!, 'logging'],
        { env: { ...env, ...extra } });
      return JSON.parse(stdout.trim().split('\n').pop()!);
    };
    // No Steam game id: the pinned function returns before creating a file.
    expect(await pinned({ PROTON_LOG: '1' })).toEqual({ invoked: true, created: false, name: null });
    expect(await protonLaunchFeatureNotices({ PROTON_LOG: '1' }, f.root)).toHaveLength(1);
    // A forwarded Steam game id lets the pinned function create its log file.
    expect(await pinned({ PROTON_LOG: '1', SteamGameId: '16968485195965530112' }))
      .toEqual({ invoked: true, created: true, name: 'steam-16968485195965530112.log' });
    expect(await protonLaunchFeatureNotices({ PROTON_LOG: '1', SteamGameId: '16968485195965530112' }, f.root)).toEqual([]);
    // Presence semantics: an empty value still satisfies the pinned check.
    expect(await pinned({ PROTON_LOG: '1', SteamGameId: '' }))
      .toEqual({ invoked: true, created: true, name: 'steam-.log' });
    expect(await protonLaunchFeatureNotices({ PROTON_LOG: '1', SteamGameId: '' }, f.root)).toEqual([]);
    // The caller nonzero gate still decides whether logging is set up at all.
    for (const value of ['0', '']) {
      expect(await pinned({ PROTON_LOG: value })).toEqual({ invoked: false, created: false, name: null });
      expect(await protonLaunchFeatureNotices({ PROTON_LOG: value }, f.root)).toEqual([]);
    }
  }, 60_000);

  it('maps the game drive from the verified install location with the pinned runtime functions', async () => {
    const plain = await fixture('drive');
    await mkdir(plain.install, { recursive: true });
    const plainRunner = (await prepareProtonRunner(plain.wine, plain.compat, path.join(plain.root, 'steam'), 4, { installPath: plain.install }))!;
    const plainResult = JSON.parse((await execFile(plainRunner.launchCommand, ['Z:\\game\\Game.exe'], { env: process.env })).stdout.trim().split('\n').pop()!);
    // A Nexus installation outside a Steam library has no game library drive.
    expect(plainResult).toEqual({ game_drive: null });
    // A game genuinely inside a Steam library reports that library.
    const library = await fixture('drive');
    const libraryGame = path.join(library.root, 'steam-library/steamapps/common/Game');
    await mkdir(libraryGame, { recursive: true });
    const libraryRunner = (await prepareProtonRunner(library.wine, library.compat, path.join(library.root, 'steam'), 4, { installPath: libraryGame }))!;
    const libraryResult = JSON.parse((await execFile(libraryRunner.launchCommand, ['Z:\\game\\Game.exe'], { env: process.env })).stdout.trim().split('\n').pop()!);
    // Proton maps S: to the parent of the validated `steamapps` directory.
    expect(libraryResult.game_drive).toBe(await realpath(path.join(library.root, 'steam-library')));
  }, 60_000);
});
