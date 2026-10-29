import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { run } from './process.js';
import { layoutOfWine, runtimeLoader, X86_64_LAYOUT, type ProtonLayout } from './proton-layout.js';
import { installRuntimeComponents, runtimeComponentChecksums, verifiedRuntimeComponents } from './proton.js';

/**
 * Running a game under the compatibility tool Steam selected for its shortcut.
 * The shortcut's launch options end in `%command%`, so the launcher receives
 * Steam's own command (reaper, Steam Linux Runtime, `proton <verb> <exe>`).
 * Nexus keeps every word up to the verb and only replaces Steam's placeholder
 * executable with the decrypted launch view's entry.
 */
export interface SteamProtonCommand {
  /** Steam's command up to and including `proton <verb>`; the game executable follows. */
  prefix: string[];
  protonRoot: string;
}

const VERBS = new Set(['waitforexitandrun', 'run']);
const MAX_WORDS = 64;

/** Steam's Proton command, or undefined for a shortcut without a compatibility tool. */
export function steamProtonCommand(words: readonly string[] | undefined): SteamProtonCommand | undefined {
  if (!words?.length) return undefined;
  if (words.length > MAX_WORDS || words.some(word => !word || /[\0\r\n]/.test(word))) throw new Error('Invalid Steam launch command.');
  for (let index = words.length - 2; index >= 0; index--) {
    const word = words[index];
    if (path.basename(word) !== 'proton' || !VERBS.has(words[index + 1])) continue;
    if (!path.isAbsolute(word)) throw new Error('Steam passed a relative Proton path.');
    return { prefix: words.slice(0, index + 2), protonRoot: path.dirname(word) };
  }
  return undefined;
}

/**
 * Steam's `%command%` is: launch wrappers the user or the OS put in front of it
 * (`armada-game-launch`, `gamemoderun`, `VAR=value`), Steam's process tracking
 * (`pw-audio-namespace --`, `reaper SteamLaunch AppId=… --`), then, with a
 * compatibility tool, the runtime and tool (`…/_v2-entry-point … -- …/proton
 * waitforexitandrun`), and last the shortcut's placeholder executable.
 */
export interface SteamCommandParts {
  wrappers: string[];
  tracking: string[];
  /** The compatibility tool part, ending in `proton <verb>`; empty without one. */
  tool: string[];
}

const TRACKING = new Set(['pw-audio-namespace', 'reaper', 'steam-launch-wrapper']);
const isTool = (word: string) => /^(_v2-entry-point|entry-point|run-in-[a-z0-9]+)$/.test(path.basename(word)) ||
  /\/SteamLinuxRuntime[^/]*\//.test(word) || path.basename(word) === 'proton';

export function parseSteamCommand(words: readonly string[]): SteamCommandParts {
  if (words.length > MAX_WORDS || words.some(word => !word || /[\0\r\n]/.test(word))) throw new Error('Invalid Steam launch command.');
  const proton = steamProtonCommand(words);
  const end = proton ? proton.prefix.length : words.length;
  const steam = words.findIndex(word => TRACKING.has(path.basename(word)) || isTool(word));
  if (steam < 0 || steam >= end) {
    // No Steam words: a bare placeholder (or nothing) follows the wrappers.
    return { wrappers: proton ? words.slice(0, end) : words.slice(0, Math.max(0, words.length - 1)), tracking: [], tool: [] };
  }
  const toolStart = words.findIndex((word, index) => index >= steam && index < end && isTool(word));
  return {
    wrappers: words.slice(0, steam),
    tracking: words.slice(steam, toolStart < 0 ? (proton ? end : words.length - 1) : toolStart),
    tool: toolStart < 0 ? [] : words.slice(toolStart, end),
  };
}

/**
 * What a launch runs of Steam's command: the wrappers, then the tool part
 * (Steam's tracking and the placeholder are dropped).
 */
export function forwardedSteamCommand(parts: SteamCommandParts): string[] {
  return [...parts.wrappers, ...parts.tool];
}

/**
 * What a launch keeps of the shortcut's `%command%`: its wrappers and the tool
 * part, or undefined when only Steam's tracking and placeholder remain. Steam
 * waits on the shortcut script itself, so its tracking is not run again.
 */
export function steamLaunchCommand(words: readonly string[] | undefined): string[] | undefined {
  if (!words?.length) return undefined;
  const forwarded = forwardedSteamCommand(parseSteamCommand(words));
  return forwarded.length ? forwarded : undefined;
}

/** The wrappers of a forwarded command: everything before its tool part. */
export function forwardedWrappers(words: readonly string[]): string[] {
  const tool = words.findIndex(isTool);
  return tool < 0 ? [...words] : words.slice(0, tool);
}

/** A wrapper list as an exec prefix: leading `VAR=value` words need `env`. */
export function wrapperPrefix(wrappers: readonly string[]): string[] {
  return wrappers.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(wrappers[0]) ? ['/usr/bin/env', ...wrappers] : [...wrappers];
}

/**
 * The overlay: only what Xbox PC games need from the Nexus runtime to run at
 * all (the GDK runtime, Xbox service networking and app state), loaded
 * natively in any Proton. Graphics (DXVK, vkd3d, d3dcompiler) and mscoree stay
 * the player's Proton's own: its fixes are its choice, and a native mscoree
 * cannot find the Proton's Mono.
 */
export const OVERLAY_COMPONENTS = ['xgameruntime.dll', 'winhttp.dll', 'libnghttp2.dll', 'windows.web.dll', 'twinapi.appcore.dll'];
const overlayOverrides = (names: string[]) => {
  const wine = names.filter(name => name !== 'libnghttp2.dll').map(name => name.replace(/\.dll$/, ''));
  return `${wine.join(',')}=n,b;libnghttp2=n`;
};

async function ownedDirectory(directory: string, what: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) {
    throw new Error(`Unsafe ${what}: ${directory}`);
  }
}

/**
 * The prefix Steam created for this shortcut. Only `steamapps/compatdata/<appid>`
 * of a Steam root is accepted, owned by this user, never through a symlink.
 */
export async function steamCompatData(env: NodeJS.ProcessEnv): Promise<{ compatData: string; prefix: string }> {
  const given = env.STEAM_COMPAT_DATA_PATH;
  if (!given || !path.isAbsolute(given)) throw new Error('Steam did not pass a compatibility data path for this game.');
  const compatData = await fs.realpath(given);
  if (!/^\d+$/.test(path.basename(compatData)) || path.basename(path.dirname(compatData)) !== 'compatdata' ||
    path.basename(path.dirname(path.dirname(compatData))) !== 'steamapps') throw new Error(`Unexpected Steam compatibility data path: ${compatData}`);
  await ownedDirectory(compatData, 'Steam compatibility data directory');
  return { compatData, prefix: path.join(compatData, 'pfx') };
}

/**
 * Whether Proton has set up (or upgraded) the prefix to its own version: it
 * writes the `CURRENT_PREFIX_VERSION` of its `proton` script (not the content
 * of its `version` file) to `compatdata/<appid>/version`.
 */
async function prefixReady(compatData: string, protonRoot: string): Promise<boolean> {
  try {
    await fs.access(path.join(compatData, 'pfx', 'drive_c', 'windows', 'system32'));
    const [prefixVersion, script] = await Promise.all([
      fs.readFile(path.join(compatData, 'version'), 'utf8'),
      fs.readFile(path.join(protonRoot, 'proton'), 'utf8'),
    ]);
    const current = script.match(/^CURRENT_PREFIX_VERSION\s*=\s*["']([^"'\n]+)["']/m)?.[1];
    return Boolean(current) && prefixVersion.trim() === current;
  } catch { return false; }
}

const BUILTIN_MARKER = Buffer.from('Wine builtin DLL');

/**
 * Wine replaces a system32 file that carries its builtin marker with the
 * Proton's own builtin of that name, so the overlay is installed without the
 * marker (after its checksum was verified) and loads as the native override.
 */
export function withoutBuiltinMarker(bytes: Buffer): Buffer {
  if (!bytes.subarray(0x40, 0x40 + BUILTIN_MARKER.length).equals(BUILTIN_MARKER)) return bytes;
  const copy = Buffer.from(bytes);
  copy.fill(0, 0x40, 0x40 + BUILTIN_MARKER.length);
  return copy;
}

/**
 * The layout Steam's Proton will really use. Its `proton` script runs the
 * arm64 loader (`files/bin-arm64`) unless `PROTON_USE_ARM64=0`, which a FEX
 * preset may set to run the x86_64 loader under FEX instead.
 */
export async function steamProtonLayout(protonRoot: string, env: NodeJS.ProcessEnv): Promise<ProtonLayout> {
  if (env.PROTON_USE_ARM64 === '0') {
    const x86 = path.join(protonRoot, 'files', X86_64_LAYOUT.bin, 'wine');
    if (await fs.access(x86).then(() => true, () => false)) return X86_64_LAYOUT;
  }
  return layoutOfWine(await runtimeLoader(protonRoot));
}

const PE_MACHINES: Record<number, ProtonLayout['peArch']> = { 0x8664: 'x86_64-windows', 0xaa64: 'aarch64-windows' };

/** The COFF machine of a PE file, or undefined when it is not a readable PE image. */
async function peMachine(file: string): Promise<number | undefined> {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const header = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 0x40 || header.toString('latin1', 0, 2) !== 'MZ') return undefined;
    const pe = header.readUInt32LE(0x3c);
    if (pe + 6 > bytesRead || header.toString('latin1', pe, pe + 4) !== 'PE\0\0') return undefined;
    return header.readUInt16LE(pe + 4);
  } catch { return undefined; }
  finally { await handle?.close().catch(() => undefined); }
}

/** The PE architecture of a prepared prefix, read from its system32 kernel32 (ARM64X reports ARM64). */
export async function prefixArchitecture(prefix: string): Promise<ProtonLayout['peArch'] | undefined> {
  const machine = await peMachine(path.join(prefix, 'drive_c', 'windows', 'system32', 'kernel32.dll'));
  return machine === undefined ? undefined : PE_MACHINES[machine];
}

const IMAGE_FILE_MACHINE_I386 = 0x14c;

/**
 * The overlay is 64-bit only (system32), so a 32-bit game under Steam's
 * Proton is refused before the prefix is touched. An executable the package
 * keeps encrypted cannot be read here and is left to the launch.
 */
export async function requireSupportedGameExecutable(file: string): Promise<void> {
  if (await peMachine(file) === IMAGE_FILE_MACHINE_I386) {
    throw new Error("This game's executable is 32-bit (x86). With a Steam-selected Proton, Xodus Nexus supports 64-bit games only, because the Xbox runtime components it adds are 64-bit. Clear the compatibility tool for this game in Steam.");
  }
}

async function requireSameArchitecture(prefix: string, layout: ProtonLayout): Promise<void> {
  const existing = await prefixArchitecture(prefix);
  // Never rebuild or mix a prefix: it holds the game's local saves.
  if (existing && existing !== layout.peArch) {
    throw new Error(`This game's Steam prefix was set up for ${existing}, but the selected Proton runs ${layout.peArch}. Switch back to a ${existing} Proton in Steam, or back up and delete ${path.dirname(prefix)} so Proton creates a new prefix.`);
  }
}

/**
 * The Nexus runtime release whose components match `peArch`: the active one
 * first, then any other installed release beside it (x86_64 and aarch64
 * runtimes can be installed together).
 */
export async function overlayRuntime(activeProtonRoot: string, peArch: ProtonLayout['peArch']): Promise<{ root: string; checksums: Record<string, string> } | undefined> {
  const releases = path.dirname(activeProtonRoot);
  const siblings = await fs.readdir(releases, { withFileTypes: true }).catch(() => []);
  const candidates = [activeProtonRoot, ...siblings.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => path.join(releases, entry.name)).filter(root => root !== activeProtonRoot).sort().reverse()];
  for (const root of candidates) {
    try {
      const stat = await fs.lstat(root);
      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) continue;
      const checksums = await runtimeComponentChecksums(root, peArch);
      if (checksums && OVERLAY_COMPONENTS.every(name => checksums[name])) return { root, checksums };
    } catch { /* Not a usable runtime release. */ }
  }
  return undefined;
}

export interface SteamOverlay {
  layout: ProtonLayout;
  /** Environment for the game: native overrides for the overlay DLLs. */
  environment: Record<string, string>;
  /** The runtime's x64 PlayFab Game Saves adapter, when its checksum matches the runtime metadata. */
  playfabAdapter(): Promise<string | undefined>;
}

/** The runtime's PlayFab adapter (x64, like the SDK it replaces), checked against its metadata. */
export async function checkedPlayfabAdapter(runtimeRoot: string): Promise<string | undefined> {
  try {
    const metadata = JSON.parse(await fs.readFile(path.join(runtimeRoot, 'XODUS_NEXUS_PATCH.json'), 'utf8')) as { runtimeCompatibility?: Record<string, string> };
    const expected = metadata.runtimeCompatibility?.['PlayFabGameSave.dll'];
    const file = path.join(runtimeRoot, 'files', 'share', 'xodus-nexus', 'compat', 'PlayFabGameSave.dll');
    if (!expected || createHash('sha256').update(await fs.readFile(file)).digest('hex') !== expected) return undefined;
    return file;
  } catch { return undefined; }
}

/**
 * Prepares Steam's prefix for a Nexus game. Proton sets up or upgrades a prefix
 * when it runs, replacing system32 DLLs, so a fresh or outdated prefix is first
 * brought up with a no-op command; the checked overlay is written afterwards
 * and again before every launch.
 */
export async function prepareSteamOverlay(command: SteamProtonCommand, nexusProtonRoot: string,
  env: NodeJS.ProcessEnv, onLine: (line: string) => void): Promise<SteamOverlay> {
  const { compatData, prefix } = await steamCompatData(env);
  const layout = await steamProtonLayout(command.protonRoot, env);
  const runtime = await overlayRuntime(nexusProtonRoot, layout.peArch);
  if (!runtime) throw new Error(`No installed Nexus runtime has ${layout.peArch} components for this Proton. Install the Nexus runtime for that architecture or clear the compatibility tool in Steam.`);
  if (runtime.root !== nexusProtonRoot) onLine(`Using the ${layout.peArch} components of the installed Nexus runtime ${path.basename(runtime.root)}.`);
  // Validate before Proton or Nexus changes anything in the prefix.
  const names = [...OVERLAY_COMPONENTS];
  const components = await verifiedRuntimeComponents(runtime.root, layout.peArch, runtime.checksums, names);
  await requireSameArchitecture(prefix, layout);
  if (!await prefixReady(compatData, command.protonRoot)) {
    onLine('Preparing the Steam Proton prefix for this game…');
    const result = await run(command.prefix[0], [...command.prefix.slice(1), 'C:\\windows\\system32\\cmd.exe', '/c', 'exit'], { env, maxOutput: 1_000_000 });
    if (!await prefixReady(compatData, command.protonRoot)) {
      const detail = result.output.split('\n').map(line => line.trim()).filter(Boolean).slice(-3).join(' | ');
      throw new Error(`Steam's Proton did not prepare its prefix (code ${result.code})${detail ? `: ${detail}` : ''}`);
    }
  }
  await requireSameArchitecture(prefix, layout);
  for (const directory of [prefix, path.join(prefix, 'drive_c'), path.join(prefix, 'drive_c', 'windows'), path.join(prefix, 'drive_c', 'windows', 'system32')]) {
    await ownedDirectory(directory, 'Steam prefix directory');
  }
  await installRuntimeComponents(prefix, components.map(({ name, bytes }) => ({ name, bytes: withoutBuiltinMarker(bytes) })));
  onLine(`Applied the Nexus runtime overlay (${layout.peArch}) to the Steam prefix ${prefix}.`);
  // Graphics stay the Proton's own; its versions explain shader differences
  // from the Nexus runtime.
  const versions = await Promise.all(['wine/dxvk', 'vkd3d'].map(library =>
    fs.readFile(path.join(command.protonRoot, 'files', 'lib', library, 'version'), 'utf8').then(text => text.match(/\(([^)]+)\)/)?.[1], () => undefined)));
  onLine(`Steam Proton graphics: DXVK ${versions[0] ?? 'unknown'}, vkd3d ${versions[1] ?? 'unknown'}.`);
  const overrides = [env.WINEDLLOVERRIDES, overlayOverrides(names)].filter(Boolean).join(';');
  return { layout, environment: { WINEDLLOVERRIDES: overrides }, playfabAdapter: () => checkedPlayfabAdapter(runtime.root) };
}

/**
 * The private directory that holds the decrypted launch view: under the user's
 * runtime directory (tmpfs, cleared at logout and reboot), mode 0700, shared
 * into the Steam Linux Runtime container through STEAM_COMPAT_MOUNTS.
 */
export async function launchViewDirectory(env: NodeJS.ProcessEnv, profileId: string): Promise<string> {
  const runtime = env.XDG_RUNTIME_DIR;
  if (!runtime || !path.isAbsolute(runtime)) throw new Error('XDG_RUNTIME_DIR is not set; Steam Proton launches need a private runtime directory.');
  await ownedDirectory(runtime, 'runtime directory');
  let directory = runtime;
  for (const segment of ['xodus-nexus', 'views', profileId]) {
    directory = path.join(directory, segment);
    await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    await ownedDirectory(directory, 'launch view directory');
    await fs.chmod(directory, 0o700);
  }
  // A force-stopped backend (SIGTERM/SIGKILL) cannot remove its view. One
  // game runs per profile, so views left here are stale before a launch.
  await clearLaunchViews(directory);
  return directory;
}

/** Removes every launch view the backend left in `directory`; run before a launch and after it ends. */
export async function clearLaunchViews(directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('.xodus-chain-')) continue;
    await fs.rm(path.join(directory, entry.name), { recursive: true, force: true });
  }
}

/**
 * Bytes a full launch view will hold, as far as they can be known before the
 * backend runs: the size of every package executable and DLL that is not a
 * readable PE image (still encrypted). Encrypted data files cannot be told
 * apart from plain ones here; `requireLaunchViewSpace` leaves room for them.
 */
export async function launchViewNeed(gameRoot: string): Promise<number> {
  let bytes = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { await visit(file); continue; }
      if (!entry.isFile() || !/\.(exe|dll)$/i.test(entry.name)) continue;
      let handle;
      try {
        handle = await fs.open(file, 'r');
        const header = Buffer.alloc(2);
        const { bytesRead } = await handle.read(header, 0, 2, 0);
        if (bytesRead < 2 || header.toString('latin1') !== 'MZ') bytes += (await handle.stat()).size;
      } catch { /* Unreadable here; the backend reports it if the launch needs it. */ }
      finally { await handle?.close().catch(() => undefined); }
    }
  };
  await visit(gameRoot);
  return bytes;
}

/** Free space a launch view must leave: the runtime directory is usually a RAM-backed tmpfs. */
export const LAUNCH_VIEW_MARGIN = 64 * 1024 ** 2;
export const LAUNCH_VIEW_SPACE_MESSAGE = 'Not enough memory for the launch view in XDG_RUNTIME_DIR. Close other programs, or clear the compatibility tool for this game in Steam to use the Nexus runtime.';
const mib = (bytes: number) => `${Math.ceil(bytes / 1024 ** 2)} MiB`;

/**
 * Refuses a launch whose known decrypted files would take more than half of
 * the free space (less a margin) in the view directory: the rest stays for
 * encrypted data files and, on a tmpfs, for the game's own memory.
 */
export async function requireLaunchViewSpace(directory: string, need: number,
  statfs: (file: string) => Promise<{ bavail: number; bsize: number }> = fs.statfs): Promise<{ need: number; free: number }> {
  const stat = await statfs(directory);
  const free = stat.bavail * stat.bsize;
  if (need + LAUNCH_VIEW_MARGIN > free / 2) throw new Error(`${LAUNCH_VIEW_SPACE_MESSAGE} (needs at least ${mib(need + LAUNCH_VIEW_MARGIN)} of ${mib(free)} free; at most half is used.)`);
  return { need, free };
}

/** The launch view ran out of space while the backend created it. */
export function launchViewFailure(output: string): string | undefined {
  return output.split('\n').some(line => /launch (view|chain)/i.test(line) && /No space left on device|os error 28|ENOSPC/i.test(line))
    ? LAUNCH_VIEW_SPACE_MESSAGE : undefined;
}

/**
 * What a Steam-selected Proton does not get from the Nexus runtime, for the
 * launch log: shown every launch, so a failure has its likely cause beside it.
 */
export function steamProtonLimits(prefix: string): string[] {
  return [
    'Package identity and ApplicationData from the Nexus runtime are not available with this Proton; games that need them may fail. Use the Xodus Nexus tool for full support.',
    `This Proton uses Steam's prefix (${prefix}): local game settings and local saves from the Nexus prefix are not there, so the game may start as on a first run.`,
  ];
}

/**
 * The shader cache settings the Nexus runner applies, for a Steam Proton
 * launch: only for variables neither the player nor Steam already set, and
 * the size limits only with the managed driver directory.
 */
export function steamShaderCacheEnvironment(env: NodeJS.ProcessEnv, caches: { vkd3d: string; nvidia: string; mesa: string },
  limits: { bytes: string; mesa: string }): Record<string, string> {
  const result: Record<string, string> = {};
  if (env.VKD3D_SHADER_CACHE_PATH === undefined) result.VKD3D_SHADER_CACHE_PATH = caches.vkd3d;
  if (env.__GL_SHADER_DISK_CACHE_PATH === undefined) {
    result.__GL_SHADER_DISK_CACHE_PATH = caches.nvidia;
    if (env.__GL_SHADER_DISK_CACHE === undefined) result.__GL_SHADER_DISK_CACHE = '1';
    if (env.__GL_SHADER_DISK_CACHE_SIZE === undefined) result.__GL_SHADER_DISK_CACHE_SIZE = limits.bytes;
  }
  if (env.MESA_SHADER_CACHE_DIR === undefined) {
    result.MESA_SHADER_CACHE_DIR = caches.mesa;
    if (env.MESA_SHADER_CACHE_MAX_SIZE === undefined) result.MESA_SHADER_CACHE_MAX_SIZE = limits.mesa;
  }
  return result;
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

/** A launcher script that runs `words` with its own arguments appended. */
async function writeLauncher(directory: string, name: string, words: string[]): Promise<string> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await ownedDirectory(directory, 'launch wrapper directory');
  const file = path.join(directory, name);
  const temporary = `${file}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `#!/bin/sh\nexec ${words.map(shellQuote).join(' ')} "$@"\n`, { mode: 0o700, flag: 'w' });
  await fs.rename(temporary, file);
  return file;
}

/** The "wine" the backend runs: Steam's command with the launch view's entry appended. */
export async function writeSteamLauncher(directory: string, command: SteamProtonCommand): Promise<string> {
  const parts = parseSteamCommand(command.prefix);
  return writeLauncher(directory, 'steam-proton', [...wrapperPrefix(parts.wrappers), ...parts.tool]);
}

/**
 * Stop for a Steam Proton launch, like the Nexus runner's `--nexus-stop-prefix`:
 * that Proton's own wineserver, for Steam's prefix only, never a global one.
 * Proton's `waitforexitandrun` already waits for the prefix to empty.
 */
export async function writeSteamPrefixStop(directory: string, protonRoot: string, layout: ProtonLayout,
  prefix: string): Promise<{ command: string; args: string[] }> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await ownedDirectory(directory, 'launch wrapper directory');
  const file = path.join(directory, 'steam-proton-stop');
  const temporary = `${file}.tmp-${process.pid}`;
  const wineserver = path.join(protonRoot, 'files', layout.bin, 'wineserver');
  await fs.writeFile(temporary, `#!/bin/sh\nexport WINEPREFIX=${shellQuote(prefix)}\nexec ${shellQuote(wineserver)} -k\n`, { mode: 0o700, flag: 'w' });
  await fs.rename(temporary, file);
  return { command: file, args: [] };
}

/** The Nexus runtime's "wine" run inside the shortcut's launch wrappers. */
export async function writeWrappedLauncher(directory: string, wrappers: string[], wine: string): Promise<string> {
  return writeLauncher(directory, 'wrapped-wine', [...wrapperPrefix(wrappers), wine]);
}

/** Shares the game folder and the launch view with the Steam Linux Runtime container. */
export function steamCompatMounts(env: NodeJS.ProcessEnv, paths: string[]): string {
  return [env.STEAM_COMPAT_MOUNTS, ...paths].filter(Boolean).join(':');
}
