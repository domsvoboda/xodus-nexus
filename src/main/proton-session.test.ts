import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { prepareProtonRunner, protonOptionalComponentNotices } from './proton.js';
import { prepareGameWrapper } from './game-wrapper.js';
import { defaultLaunchTools } from '../shared/launch-tools.js';

// End-to-end fixture for the Play command of a real runtime payload. It is
// guarded because it needs a built Nexus runtime directory:
//   XODUS_CACHYOS_PAYLOAD=<.../nexus-runtime-cachyos-...>   CachyOS family
//   XODUS_STANDARD_PAYLOAD=<.../nexus-runtime-...>          Standard family
//   XODUS_PROTON_FIXTURE_CACHE_DIR=<cache>  optional isolated upscaler cache.
// The fixture never touches a user prefix, cache or home directory: every run
// uses a private compatibility directory, private HOME and a private cache, and
// temporary roots come from TMPDIR.
const execFile = promisify(execFileCallback);
const cachyos = process.env.XODUS_CACHYOS_PAYLOAD;
const standard = process.env.XODUS_STANDARD_PAYLOAD;
const fixtureCache = process.env.XODUS_PROTON_FIXTURE_CACHE_DIR;
const created: string[] = [];

afterAll(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface Session {
  root: string;
  compatibilityDataPath: string;
  runner: NonNullable<Awaited<ReturnType<typeof prepareProtonRunner>>>;
  wrapper: { command: string };
  stdout: string;
  output: string;
}

async function session(payload: string, launchOptions: string, reusedRoot?: string): Promise<Session> {
  const root = reusedRoot ?? await mkdtemp(path.join(tmpdir(), 'nexus-proton-session-'));
  if (!reusedRoot) created.push(root);
  const compatibilityDataPath = path.join(root, 'compat');
  const home = path.join(root, 'home');
  const cache = fixtureCache ?? path.join(root, 'cache');
  await mkdir(home, { recursive: true });
  await mkdir(cache, { recursive: true });
  // prepareProtonRunner initializes the prefix with the runtime's own Proton
  // session, which inherits the launcher process environment. Point HOME and the
  // cache at this fixture root for that call so no user cache is written.
  const previousHome = process.env.HOME, previousCache = process.env.XDG_CACHE_HOME;
  process.env.HOME = home;
  process.env.XDG_CACHE_HOME = cache;
  let runner;
  try {
    runner = await prepareProtonRunner(path.join(payload, 'files/bin/wine'), compatibilityDataPath,
      path.join(root, 'steam'), 4);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previousCache;
  }
  expect(runner).toBeDefined();
  if (!runner) throw new Error('payload is not a Proton runtime');
  const wrapper = await prepareGameWrapper(runner.launchCommand,
    { ...defaultLaunchTools, launchOptions }, path.join(root, 'wrappers'));
  const childEnvironment = {
    ...process.env,
    HOME: home,
    XDG_CACHE_HOME: cache,
    // A stale shell configuration must never win over the runtime environment.
    WINEPREFIX: '/wrong/prefix',
    WINEDLLOVERRIDES: 'dxgi=b;stale=1',
    UMU_ID: 'stale-umu',
  };
  let stdout = '', stderr = '';
  try {
    ({ stdout, stderr } = await execFile(wrapper.command, ['cmd', '/c', 'set'], {
      env: childEnvironment, maxBuffer: 16 * 1024 * 1024, timeout: 900_000,
    }));
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    failure.message = `${failure.message}\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}`;
    throw error;
  }
  return { root, compatibilityDataPath, runner, wrapper, stdout, output: stdout + stderr };
}

function environmentOf(stdout: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

async function deployedPayload(compatibilityDataPath: string) {
  const directory = path.join(compatibilityDataPath, 'pfx/drive_c/windows/system32/umu');
  let names: string[] = [];
  try { names = (await readdir(directory)).sort(); } catch { names = []; }
  const files: Record<string, { size: number; magic: string }> = {};
  for (const name of names) {
    const file = path.join(directory, name);
    const info = await stat(file);
    if (!info.isFile()) continue;
    const head = await readFile(file).then((bytes) => bytes.subarray(0, 2).toString('latin1'), () => '');
    files[name] = { size: info.size, magic: head };
  }
  return files;
}

function expectNoIntegrityFailure(output: string) {
  // "Failed to validate optiscaler files" is the normal cold-prefix message
  // before the payload is installed. Real integrity failures must not appear.
  expect(output).not.toMatch(/CRIT: MD5 mismatch/);
  expect(output).not.toMatch(/Failed to download/);
  expect(output).not.toMatch(/Failed to extract/);
}

describe.skipIf(!cachyos)('CachyOS Play command with a real payload', () => {
  it('runs the runtime Proton session, deploys the requested component and keeps the managed prefix', async () => {
    const { compatibilityDataPath, runner, wrapper, stdout, output } = await session(cachyos!, 'PROTON_USE_OPTISCALER=1 %command%');
    const environment = environmentOf(stdout);
    expect(wrapper.command).not.toBe(runner.launchCommand);
    expect(environment.get('WINEPREFIX')?.replace(/\/$/, '')).toBe(path.join(compatibilityDataPath, 'pfx'));
    expect(output).toContain('Setting up optiscaler version');
    expect(environment.get('WINE_OPTISCALER_NAME')).toBe('dxgi.dll');
    expect(output).not.toContain('umu.exe');
    // The hook variable alone is not success: the payload must really be installed.
    expectNoIntegrityFailure(output);
    const files = await deployedPayload(compatibilityDataPath);
    for (const name of ['OptiScaler.dll', 'OptiScaler.ini', 'fakenvapi.dll']) {
      expect(files[name], `${name} must be deployed`).toBeDefined();
      expect(files[name].size).toBeGreaterThan(0);
    }
    expect(files['OptiScaler.dll'].magic).toBe('MZ');
  }, 900_000);

  it('starts the same game without the optional component when the option is absent', async () => {
    const { compatibilityDataPath, stdout, output } = await session(cachyos!, '%command%');
    const environment = environmentOf(stdout);
    expect(environment.get('WINEPREFIX')?.replace(/\/$/, '')).toBe(path.join(compatibilityDataPath, 'pfx'));
    expect(environment.has('WINE_OPTISCALER_NAME')).toBe(false);
    expect(output).not.toContain('Setting up optiscaler version');
    expect(await deployedPayload(compatibilityDataPath)).toEqual({});
  }, 900_000);

  it('reports the optional component honestly before the first launch', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nexus-proton-session-')); created.push(root);
    const notices = await protonOptionalComponentNotices(
      { PROTON_USE_OPTISCALER: '1' }, path.join(cachyos!, ''), path.join(root, 'compat'), true);
    expect(notices).toHaveLength(1);
    expect(notices[0]).not.toMatch(/will be downloaded|is active|verified/i);
    expect(notices[0]).toContain('offline');
  }, 900_000);

  it('preserves the Nexus overlay component across a second Proton session', async () => {
    const first = await session(cachyos!, 'PROTON_USE_OPTISCALER=1 %command%');
    const overlay = path.join(first.compatibilityDataPath, 'pfx/drive_c/windows/system32/windows.web.dll');
    await copyFile(path.join(cachyos!, 'files/lib/wine/x86_64-windows/windows.web.dll'), overlay);
    const digest = createHash('sha256').update(await readFile(overlay)).digest('hex');
    const second = await session(cachyos!, 'PROTON_USE_OPTISCALER=1 %command%', first.root);
    expect(second.compatibilityDataPath).toBe(first.compatibilityDataPath);
    expect(createHash('sha256').update(await readFile(overlay)).digest('hex')).toBe(digest);
    expect(environmentOf(second.stdout).get('WINE_OPTISCALER_NAME')).toBe('dxgi.dll');
    expectNoIntegrityFailure(second.output);
  }, 1_800_000);

  it('starts an absolute Unix executable with spaces and quoted arguments through the Proton session', async () => {
    const { root, runner, wrapper } = await session(cachyos!, '%command%');
    const directory = path.join(root, 'game dir with spaces');
    await mkdir(directory, { recursive: true });
    const executable = path.join(directory, 'game cmd.exe');
    await copyFile(path.join(cachyos!, 'files/lib/wine/x86_64-windows/cmd.exe'), executable);
    const childEnvironment = {
      ...process.env,
      HOME: path.join(root, 'home'),
      XDG_CACHE_HOME: fixtureCache ?? path.join(root, 'cache'),
      WINEPREFIX: '/wrong/prefix',
      UMU_ID: 'stale-umu',
    };
    // The backend always passes an absolute Unix executable path; Proton must
    // still start the runtime Wine, not umu.exe or steam.exe, and keep argv.
    const { stdout, stderr } = await execFile(wrapper.command,
      [executable, '/c', 'echo', 'alpha', '"beta gamma"', 'delta'],
      { env: childEnvironment, maxBuffer: 8 * 1024 * 1024, timeout: 900_000 });
    // Wine's cmd re-quotes the echoed remainder, so the space-preserving
    // argument is asserted by content: a split would yield "beta" and "gamma"
    // as separate tokens, and the executable would never have started at all if
    // the route had fallen back to umu.exe or steam.exe.
    expect(stdout).toContain('alpha');
    expect(stdout).toContain('beta gamma');
    expect(stdout.trimEnd().endsWith('delta')).toBe(true);
    expect(`${stdout}${stderr}`).not.toContain('umu.exe');
    // Stop keeps using the exact bare runtime Wine command captured at launch.
    expect(runner.stopPrefix.command).toBe(runner.command);
    const stopScript = await readFile(runner.command, 'utf8');
    const launchScript = await readFile(runner.launchCommand, 'utf8');
    expect(stopScript).toContain('--nexus-stop-prefix');
    expect(stopScript).not.toContain(' run "$@"');
    expect(launchScript).toContain(' run "$@"');
    // wineserver -k exits 1 when no server is running; that is its own idle
    // status, not a launcher failure, so both codes are accepted here.
    const stopped = await execFile(runner.stopPrefix.command, runner.stopPrefix.args,
      { env: childEnvironment, timeout: 120_000 }).catch((error: { code?: number }) => ({ code: error.code }));
    expect([0, 1]).toContain((stopped as { code?: number }).code ?? 0);
  }, 1_800_000);
});

describe.skipIf(!standard)('Standard Play command with a real payload', () => {
  it('runs the runtime Proton session without the CachyOS upscaler hook', async () => {
    const { compatibilityDataPath, stdout } = await session(standard!, 'PROTON_USE_OPTISCALER=1 %command%');
    const environment = environmentOf(stdout);
    expect(environment.get('WINEPREFIX')?.replace(/\/$/, '')).toBe(path.join(compatibilityDataPath, 'pfx'));
    expect(environment.has('WINE_OPTISCALER_NAME')).toBe(false);
    expect(await deployedPayload(compatibilityDataPath)).toEqual({});
  }, 900_000);
});
