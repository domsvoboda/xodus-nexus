import { constants, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { run } from './process.js';
import { installedEacRuntime } from './anti-cheat.js';
import { prepareManagedPrefix } from './managed-prefix.js';
import { systemGameLocale } from './game-locale.js';
import { windowsGameLocale } from '../shared/game-language.js';
import { prepareShaderCache } from './shader-cache.js';
import { DEFAULT_SHADER_CACHE_GIB, shaderCacheLimits } from '../shared/shader-cache.js';
import { layoutOfWine, protonRootOf, type ProtonLayout } from './proton-layout.js';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export interface ProtonRunner {
  command: string;
  launchCommand: string;
  compatibilityDataPath: string;
  protonRoot: string;
  /** The verified game location reported to the Play command, when known. */
  compatibilityLocation?: SteamCompatLocation;
  stopPrefix: { command: string; args: string[] };
}

// Optional Proton components (CachyOS) are prepared by the runtime's own
// `proton` session, which downloads them on first use from the public
// proton-upscalers component index. The launcher must say so honestly instead of
// implying they are always present.
const PROTON_OPTIONAL_COMPONENTS = [
  { environment: 'PROTON_USE_OPTISCALER', label: 'OptiScaler', payload: 'drive_c/windows/system32/umu/OptiScaler.dll' },
] as const;

function protonComponentEnabled(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '' && value.trim() !== '0';
}

/**
 * Reports how a launch option that asks for an optional Proton component will be
 * served. The CachyOS Proton session deploys the payload into the managed prefix
 * and exports WINE_OPTISCALER_NAME; without the payload (for example an offline
 * first launch) the game still starts and the component stays inactive.
 * Nothing is claimed for runtimes that do not ship the upscaler integration.
 */
export async function protonOptionalComponentNotices(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
  protonRoot: string,
  compatibilityDataPath: string,
  offline: boolean,
): Promise<string[]> {
  let capable = true;
  try { await fs.access(path.join(protonRoot, 'protonfixes', 'upscalers.py'), constants.R_OK); }
  catch { capable = false; }
  if (!capable) return [];
  const notices: string[] = [];
  for (const component of PROTON_OPTIONAL_COMPONENTS) {
    if (!protonComponentEnabled(environment[component.environment])) continue;
    let prepared = true;
    try { await fs.access(path.join(compatibilityDataPath, 'pfx', component.payload), constants.R_OK); }
    catch { prepared = false; }
    if (prepared) notices.push(`${component.label} files are present in this Proton prefix; the runtime verifies them at launch.`);
    else if (offline) notices.push(`${component.label} files are not present in this Proton prefix yet. This launch is offline, so it can only use an already downloaded component; without one ${component.label} stays inactive.`);
    else notices.push(`${component.label} files are prepared by the CachyOS Proton session on first use. If that download fails, the game still starts without ${component.label}.`);
  }
  return notices;
}

/**
 * Proton's own `nonzero()` test for a launch option: only a missing, empty or
 * literal "0" value disables it (whitespace-only values stay enabled upstream).
 */
function upstreamNonzero(value: string | undefined): boolean {
  return value !== undefined && value.length > 0 && value !== '0';
}

/**
 * Reports requested Proton launch options that this runtime cannot act on
 * through the Nexus Play path. Play runs the runtime's own Proton session
 * directly without entering the runtime's umu/Steam helper, so options that
 * helper would serve stay inactive. An optional genuine Steam shortcut handoff
 * can still provide a Steam game id, so the notices always evaluate the actual
 * launch environment instead of assuming that identity is missing. They are
 * reported here instead of being simulated with an invented Steam identity.
 * Only options the user requested are reported.
 *
 * `location` is the verified game-location result the runner captured for this
 * launch. The game-drive notice is emitted only when that context carries no
 * real Steam library, so a genuinely mapped S: drive is never reported as
 * inactive.
 */
export async function protonLaunchFeatureNotices(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
  protonRoot: string,
  location?: SteamCompatLocation,
): Promise<string[]> {
  const present = async (relative: string): Promise<boolean> => {
    try { await fs.access(path.join(protonRoot, relative), constants.R_OK); return true; }
    catch { return false; }
  };
  const notices: string[] = [];
  if (upstreamNonzero(environment.PROTON_DISCORD_BRIDGE)) {
    if (await present('files/lib/wine/discord-rpc-bridge/bridge.exe')) {
      // The pinned bridge documents --steam through PROTON_REMOTE_DEBUG_CMD
      // (extras/discord-rpc-bridge/build/bridge.sh), and the pinned Proton
      // session starts that command before the game (CachyOS proton:2418,
      // 2507-2514, 2553-2560). A --rpc companion is another route. Nexus
      // configures neither and cannot verify a user starter or an existing
      // prefix service, so the payload alone proves no Rich Presence state.
      notices.push('PROTON_DISCORD_BRIDGE is set. This runtime includes the Discord RPC bridge. The Nexus Proton Play route does not automatically configure or start it, so the bundled payload alone does not establish Rich Presence. Custom service startup or an existing prefix service is not verified by Nexus.');
    } else {
      notices.push('PROTON_DISCORD_BRIDGE is set, but this runtime does not include the Discord RPC bridge, so the option has no effect.');
    }
  }
  if (upstreamNonzero(environment.PROTON_LOCAL_SHADER_CACHE) && !await present('protonfixes/utilities.py')) {
    notices.push('PROTON_LOCAL_SHADER_CACHE is set, but this runtime does not implement it, so the option has no effect.');
  }
  // Proton's own log file exists only when the effective environment carries a
  // Steam game id; the pinned setup_logging checks key presence, not the value.
  // A genuine Steam shortcut handoff or an ambient value both satisfy it.
  if (upstreamNonzero(environment.PROTON_LOG) && environment.SteamGameId === undefined) {
    notices.push('PROTON_LOG is set, but Proton creates its log file only when the launch provides a Steam game id, and this launch has none. The configured Wine and DXVK logging variables still apply.');
  }
  if (upstreamNonzero(environment.PROTON_SET_GAME_DRIVE) && !location?.libraryPaths) {
    notices.push('PROTON_SET_GAME_DRIVE is set, but this game is not installed inside a verified Steam library (a real steamapps directory), so Proton has no library for the S: game drive. Nexus does not fabricate one. The other mount drives follow the runtime.');
  }
  return notices;
}

export interface SteamCompatLocation {
  /** The real install directory Proton receives as the game location. */
  installPath: string;
  /** A real `steamapps` directory containing the install, when one exists. */
  libraryPaths?: string;
}

/**
 * Location context for Proton's own drive mapping. `PROTON_SET_GAME_DRIVE`
 * maps S: to the parent of a `steamapps` directory that contains the game, and
 * the runtime itself validates the library parent (writable, same device).
 * Nexus reports the genuine install directory, and the real library only when
 * the game is actually installed inside one. A Store installation outside a
 * Steam library reports just the install directory, so nothing is fabricated
 * for a Steam-only drive.
 */
export async function steamCompatLocation(installPath: string): Promise<SteamCompatLocation | undefined> {
  if (!installPath || !path.isAbsolute(installPath)) return undefined;
  let install: string;
  try {
    install = await fs.realpath(installPath);
    if (!(await fs.stat(install)).isDirectory()) return undefined;
  } catch { return undefined; }
  const located: SteamCompatLocation = { installPath: install };
  let directory = path.dirname(install);
  for (;;) {
    if (path.basename(directory) === 'steamapps') {
      try {
        // The runtime looks up the real path and requires the basename
        // `steamapps`. Report the library only when it would satisfy that.
        const library = await fs.realpath(directory);
        if (path.basename(library) === 'steamapps' && (await fs.stat(library)).isDirectory()) located.libraryPaths = library;
      } catch { /* A library the runtime would reject stays unreported. */ }
      return located;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return located;
    directory = parent;
  }
}

const REQUIRED_PREFIX_FILES = [
  'drive_c/windows/system32/libvkd3d-utils-1.dll',
  'drive_c/windows/system32/dxgi.dll',
  'drive_c/windows/system32/d3d12.dll',
];

async function missingPrefixFiles(compatibilityDataPath: string, layout: ProtonLayout): Promise<string[]> {
  const prefix = path.join(compatibilityDataPath, 'pfx');
  const missing: string[] = [];
  // Proton builds Wine's separate vkd3d DLLs only for x86 PE targets.
  const required = layout.peArch === 'x86_64-windows' ? REQUIRED_PREFIX_FILES : REQUIRED_PREFIX_FILES.filter(file => !file.endsWith('/libvkd3d-utils-1.dll'));
  for (const relative of required) {
    try { await fs.access(path.join(prefix, relative), constants.R_OK); }
    catch { missing.push(relative); }
  }
  return missing;
}

async function rebaseRuntimeSymlinks(prefix: string, protonRoot: string): Promise<number> {
  const releasesRoot = path.dirname(protonRoot);
  const currentFiles = path.join(protonRoot, 'files');
  let updated = 0;
  let serial = 0;

  async function visit(directory: string): Promise<void> {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;

      const target = await fs.readlink(entryPath);
      if (!path.isAbsolute(target)) continue;
      const relative = path.relative(releasesRoot, target);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
      const components = relative.split(path.sep);
      if (components.length < 3 || components[1] !== 'files') continue;

      const replacement = path.join(currentFiles, ...components.slice(2));
      if (replacement === target) continue;
      try { await fs.access(replacement, constants.R_OK); }
      catch { continue; }

      const temporary = `${entryPath}.xodus-runtime-${process.pid}-${serial++}`;
      try {
        await fs.symlink(replacement, temporary);
        await fs.rename(temporary, entryPath);
        updated += 1;
      } catch (error) {
        await fs.unlink(temporary).catch(() => undefined);
        throw error;
      }
    }
  }

  await visit(prefix);
  return updated;
}

export async function prefixUserLocale(prefix: string): Promise<string | undefined> {
  try {
    const userReg = await fs.readFile(path.join(prefix, 'user.reg'), 'latin1');
    const section = userReg.split(/\r?\n(?=\[)/).find(part => /^\[Control Panel\\\\International\]/m.test(part));
    return section?.match(/^"LocaleName"="([^"]*)"/m)?.[1];
  } catch { return undefined; }
}

export async function syncPrefixUserLocale(
  wineCommand: string,
  prefix: string,
  locale: string | undefined,
  env: NodeJS.ProcessEnv,
  onLine: (line: string) => void,
): Promise<void> {
  try { await synchronizePrefixUserLocale(wineCommand, prefix, locale, env, onLine); }
  catch {
    // An optional language override must not prevent an otherwise valid game
    // from starting because its locale marker or registry tool is unavailable.
    onLine('The prefix user locale could not be synchronized; the game may use the previous language.');
  }
}

async function synchronizePrefixUserLocale(
  wineCommand: string,
  prefix: string,
  locale: string | undefined,
  env: NodeJS.ProcessEnv,
  onLine: (line: string) => void,
): Promise<void> {
  const marker = path.join(prefix, '.nexus-user-locale.json');
  let managed: { schema: number; applied: string } | undefined;
  try {
    const handle = await fs.open(marker, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 512 || stat.nlink !== 1) throw Error('Invalid locale marker.');
      const buffer = Buffer.alloc(513);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 512) throw Error('Invalid locale marker.');
      const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      if (value?.schema !== 1 || typeof value.applied !== 'string' || windowsGameLocale(value.applied) !== value.applied) throw Error('Invalid locale marker.');
      managed = value;
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      onLine('The managed game-language record is unavailable; leaving the prefix locale unchanged.');
      return;
    }
  }
  if (!locale && !managed) return;
  const current = await prefixUserLocale(prefix);
  if (!locale && current && current !== managed!.applied) {
    // Another tool or the user changed it after Nexus. Do not reset their work.
    await fs.unlink(marker);
    return;
  }
  const target = locale ? windowsGameLocale(locale) : systemGameLocale(env);
  if (!target) {
    onLine('The system language could not be resolved; leaving the prefix locale unchanged.');
    return;
  }
  if (current === target) {
    if (!locale) await fs.unlink(marker);
    return;
  }
  onLine(`Updating the Windows user locale of the game prefix from ${current ?? 'unset'} to ${target}.`);
  // Wine pins HKCU\Control Panel\International in the prefix at creation and
  // ignores later LANG changes. Deleting the key makes Wine rebuild it from
  // the launch environment, so titles that read the Windows user locale
  // instead of XPackageGetUserLocale follow the selected game language.
  const result = await run(wineCommand, ['reg', 'delete', 'HKCU\\Control Panel\\International', '/f'], { env: { ...env, WINEUSERLOCALE: target }, maxOutput: 100_000 });
  if (result.code !== 0) {
    onLine(`The prefix user locale could not be updated (reg exited with code ${result.code}); the game may use the previous language.`);
    return;
  }
  if (locale) {
    // The key is recreated by the next Wine process from this launch's locale.
    await fs.mkdir(prefix, { recursive: true });
    const temporary = `${marker}.${process.pid}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ schema: 1, applied: target }));
      await handle.close();
      await fs.rename(temporary, marker);
    } finally {
      await handle.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
    }
  } else await fs.unlink(marker);
}

function unrealCultureGameIniContent(existing: string, locale: string): string | null {
  const lines = existing.split(/\r?\n/);
  let inInternationalization = false;
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      inInternationalization = header[1].trim().toLowerCase() === 'internationalization';
      continue;
    }
    if (!inInternationalization) continue;
    const pair = lines[index].match(/^(\s*Culture\s*=\s*)(.*)$/i);
    if (!pair) continue;
    if (pair[2].trim() === locale) return null;
    lines[index] = `${pair[1]}${locale}`;
    return `${lines.join('\r\n').trimEnd()}\r\n`;
  }
  return `${existing.replace(/\s*$/, '\r\n')}[Internationalization]\r\nCulture=${locale}\r\n`;
}

// Unreal GDK titles resolve their text culture at engine init, before the
// cloud save (with the in-game Language Select) is available. A read-only
// Game.ini with [Internationalization] Culture pins the language at boot.
// The launcher only manages the two marker-owned lines it wrote itself; a
// manually authored Culture line is never modified, and clearing the game
// language in the launcher removes the pin again.
const MANAGED_CULTURE_MARKER = '; Xodus Nexus game language';

export interface UnrealCulturePlan {
  content: string | null;
  managed: boolean;
  manual: boolean;
}

export function managedUnrealCultureGameIni(existing: string, locale: string | undefined): UnrealCulturePlan {
  const newline = existing.includes('\r\n') || !existing.includes('\n') ? '\r\n' : '\n';
  const lines = existing.split(/\r?\n/);
  const sectionHeader = (line: string) => line.match(/^\s*\[([^\]]+)\]\s*$/);
  const isMarker = (line: string) => line.trim() === MANAGED_CULTURE_MARKER;
  const isCulture = (line: string) => line.match(/^(\s*Culture\s*=\s*)(.*?)\s*$/i);

  let intlStart = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const header = sectionHeader(lines[index]);
    if (header && header[1].trim().toLowerCase() === 'internationalization') { intlStart = index; break; }
  }
  let intlEnd = intlStart;
  if (intlStart >= 0) {
    for (let index = intlStart + 1; index < lines.length; index += 1) {
      if (sectionHeader(lines[index])) break;
      intlEnd = index;
    }
  }

  let ownedCultureIndex = -1;
  let manualCulture = false;
  for (let index = intlStart + 1; index <= intlEnd; index += 1) {
    if (!isCulture(lines[index])) continue;
    if (index > intlStart && isMarker(lines[index - 1])) ownedCultureIndex = index;
    else manualCulture = true;
  }

  if (locale === undefined) {
    if (ownedCultureIndex < 0) return { content: null, managed: false, manual: manualCulture };
    const withoutManaged = lines.filter((_, index) => index !== ownedCultureIndex - 1 && index !== ownedCultureIndex);
    // Drop the [Internationalization] header when nothing but blank lines remain in it.
    let start = -1;
    let end = -1;
    for (let index = 0; index < withoutManaged.length; index += 1) {
      const header = sectionHeader(withoutManaged[index]);
      if (!header) continue;
      if (start >= 0) { end = index - 1; break; }
      if (header[1].trim().toLowerCase() === 'internationalization') start = index;
    }
    if (start >= 0) {
      if (end < start) end = withoutManaged.length - 1;
      let remainder = false;
      for (let index = start + 1; index <= end; index += 1) {
        if (withoutManaged[index].trim()) { remainder = true; break; }
      }
      if (!remainder) withoutManaged.splice(start, end - start + 1);
    }
    return { content: `${withoutManaged.join(newline).replace(/\s*$/, newline)}`, managed: true, manual: false };
  }

  if (manualCulture) return { content: null, managed: false, manual: true };

  if (ownedCultureIndex >= 0) {
    const [, prefix, value] = isCulture(lines[ownedCultureIndex])!;
    if (value === locale) return { content: null, managed: true, manual: false };
    lines[ownedCultureIndex] = `${prefix}${locale}`;
    return { content: `${lines.join(newline).replace(/\s*$/, newline)}`, managed: true, manual: false };
  }

  if (intlStart >= 0) {
    lines.splice(intlEnd + 1, 0, MANAGED_CULTURE_MARKER, `Culture=${locale}`);
    return { content: `${lines.join(newline).replace(/\s*$/, newline)}`, managed: true, manual: false };
  }
  const body = existing.replace(/\s*$/, '');
  const separator = body === '' ? '' : `${newline}${newline}`;
  return {
    content: `${body}${separator}[Internationalization]${newline}${MANAGED_CULTURE_MARKER}${newline}Culture=${locale}${newline}`,
    managed: true,
    manual: false,
  };
}

export async function syncUnrealCultureGameIni(
  prefix: string,
  installPath: string,
  titleId: string | undefined,
  locale: string | undefined,
  onLine: (line: string) => void,
): Promise<void> {
  if (!titleId) return;
  // Only Unreal installations: this mechanism writes a Game.ini entry that
  // only the Unreal internationalization system reads. Every other engine
  // would at best ignore it, but the file must not be touched at all.
  try { await fs.access(path.join(installPath, 'Engine')); }
  catch { return; }
  const usersDirectory = path.join(prefix, 'drive_c', 'users');
  let users: string[];
  try { users = await fs.readdir(usersDirectory); }
  catch { return; }
  for (const user of users) {
    const microsoftDirectory = path.join(usersDirectory, user, 'AppData', 'Local', 'Microsoft');
    let products: string[];
    try { products = await fs.readdir(microsoftDirectory); }
    catch { continue; }
    for (const product of products) {
      const configDirectory = path.join(microsoftDirectory, product, 'WinGDK', titleId, 'Saved', 'Config', 'WinGDK');
      try { await fs.access(configDirectory); }
      catch { continue; }
      const gameIni = path.join(configDirectory, 'Game.ini');
      let existing = '';
      try { existing = await fs.readFile(gameIni, 'utf8'); }
      catch { existing = ''; }
      const plan = managedUnrealCultureGameIni(existing, locale);
      if (plan.manual && locale) {
        onLine(`Found a manually configured Game.ini culture in ${product}; the launcher language is not pinned there.`);
        continue;
      }
      if (plan.content !== null) {
        await fs.chmod(gameIni, 0o644).catch(() => undefined);
        const temporary = `${gameIni}.xodus-culture-${process.pid}`;
        await fs.writeFile(temporary, plan.content, { mode: 0o644 });
        await fs.rename(temporary, gameIni);
        onLine(locale
          ? `Pinned the Unreal text language to ${locale} via ${path.join(product, 'WinGDK', titleId, 'Saved', 'Config', 'WinGDK', 'Game.ini')}.`
          : `Removed the pinned Unreal text language from ${path.join(product, 'WinGDK', titleId, 'Saved', 'Config', 'WinGDK', 'Game.ini')}.`);
      }
      // Clearing our pin must also release our read-only protection so the
      // game can save its own language choice again.
      if (plan.managed && locale !== undefined) await fs.chmod(gameIni, 0o444).catch(() => undefined);
    }
  }
}

/**
 * Proton's per-game FEX setup for arm64 hosts, evaluated at each launch: the
 * Steam variables of that launch become the prefix's FEX app config. An
 * explicit FEX_APP_CONFIG (or FEX_DISKCACHE / FEX_APP_CONFIG_LOCATION) wins.
 * Like the Nexus runtime's Proton, a 32-bit exe also gets vector TSO unless
 * the runtime's i386 xgameruntime.dll carries the FEX-safe atomics marker.
 */
export function fexEnvironment(configFile: string, i386XGameRuntime?: string): string[] {
  const profiles = path.join(path.dirname(configFile), 'fex-emu');
  return [
    'if [ "$(uname -m)" = aarch64 ]; then',
    '  if [ "${FEX_DISKCACHE+x}" != x ]; then export FEX_DISKCACHE=1; fi',
    '  if [ "${FEX_APP_CONFIG_LOCATION+x}" != x ]; then',
    // FEX creates AppConfig here. Its global shipped profiles are still read
    // from the runtime, but local state must never mutate that runtime.
    `    mkdir -p ${shellQuote(path.join(profiles, 'AppConfig'))} || exit 1`,
    `    export FEX_APP_CONFIG_LOCATION=${shellQuote(profiles + '/')}`,
    '  fi',
    '  if [ "${FEX_APP_CONFIG+x}" != x ]; then',
    '    fex_tso=; fex_multiblock=',
    '    case "${STEAM_FEX_TSOENABLED:-}" in 0|1) fex_tso=$STEAM_FEX_TSOENABLED;; esac',
    '    case "${STEAM_FEX_MULTIBLOCK:-}" in 0|1) fex_multiblock=$STEAM_FEX_MULTIBLOCK;; esac',
    // A user override sets both values, exactly like Proton.
    '    if [ -n "${STEAM_COMPAT_FEX_CONFIG:-}" ]; then',
    '      case "$STEAM_COMPAT_FEX_CONFIG" in *TSOEnabled:1*) fex_tso=1;; *) fex_tso=0;; esac',
    '      case "$STEAM_COMPAT_FEX_CONFIG" in *Multiblock:1*) fex_multiblock=1;; *) fex_multiblock=0;; esac',
    '    fi',
    '    fex_config=',
    '    if [ -n "$fex_tso" ]; then fex_config="\\"TSOEnabled\\": \\"$fex_tso\\""; fi',
    '    if [ -n "$fex_multiblock" ]; then fex_config="${fex_config:+$fex_config, }\\"Multiblock\\": \\"$fex_multiblock\\""; fi',
    // 32-bit x86 does 64-bit atomics with SSE, which FEX orders like x86
    // only with vector TSO. The first existing .exe argument is the game.
    ...(i386XGameRuntime ? [
      '    for fex_exe in "$@"; do',
      '      case "$fex_exe" in *.exe|*.EXE) ;; *) continue;; esac',
      '      [ -f "$fex_exe" ] || continue',
      '      fex_pe=$(od -An -tu4 -j60 -N4 "$fex_exe" 2>/dev/null | tr -d " ")',
      `      if [ -n "$fex_pe" ] && [ "$(od -An -tx2 -j"$((fex_pe + 4))" -N2 "$fex_exe" 2>/dev/null | tr -d " ")" = 014c ] && ! grep -aqF nexus-fex-safe-i386-atomics-v1 ${shellQuote(i386XGameRuntime)} 2>/dev/null; then`,
      '        fex_config="${fex_config:+$fex_config, }\\"VectorTSOEnabled\\": \\"1\\""',
      '      fi',
      '      break',
      '    done',
    ] : []),
    `    fex_tmp=$(mktemp ${shellQuote(configFile + '.tmp.XXXXXX')}) || exit 1`,
    `    printf '{\\n  "Config": {%s},\\n  "ThunksDB": {}\\n}\\n' "$fex_config" > "$fex_tmp" && mv -f "$fex_tmp" ${shellQuote(configFile)} || { rm -f "$fex_tmp"; exit 1; }`,
    `    export FEX_APP_CONFIG=${shellQuote(configFile)}`,
    '  fi',
    'fi',
  ];
}

export async function prepareProtonRunner(
  winePath: string,
  compatibilityDataPath: string,
  steamRoot: string,
  shaderCacheLimitGiB = DEFAULT_SHADER_CACHE_GIB,
  options: { installPath?: string } = {},
): Promise<ProtonRunner | undefined> {
  const cacheLimits = shaderCacheLimits(shaderCacheLimitGiB);
  // An arm64 runtime keeps its own loader, prefix and ARM64X modules; Proton's
  // `run` selects the same layout itself when it creates the prefix.
  const layout = layoutOfWine(winePath);
  const protonRoot = protonRootOf(winePath);
  const proton = path.join(protonRoot, 'proton');
  const defaultPrefix = path.join(protonRoot, 'files', 'share', layout.defaultPrefix);
  try {
    await fs.access(proton, constants.X_OK);
    await fs.access(defaultPrefix, constants.R_OK);
  } catch {
    return undefined;
  }

  await prepareManagedPrefix(compatibilityDataPath);
  await fs.mkdir(steamRoot, { recursive: true });
  await rebaseRuntimeSymlinks(path.join(compatibilityDataPath, 'pfx'), protonRoot);
  let missing = await missingPrefixFiles(compatibilityDataPath, layout);
  if (missing.length > 0) {
    const initialized = await run(proton, ['run', 'cmd', '/c', 'exit'], {
      env: {
        ...process.env,
        STEAM_COMPAT_DATA_PATH: compatibilityDataPath,
        STEAM_COMPAT_CLIENT_INSTALL_PATH: steamRoot,
        SteamAppId: '0',
        SteamGameId: '0',
        UMU_ID: 'xodus-nexus',
        UMU_USE_STEAM: '0',
        PYTHONDONTWRITEBYTECODE: '1',
      },
      maxOutput: 1_000_000,
    });
    missing = await missingPrefixFiles(compatibilityDataPath, layout);
    if (missing.length > 0) {
      const detail = initialized.output.split('\n').map((line) => line.trim()).filter(Boolean).slice(-5).join(' | ');
      throw new Error(`The Proton prefix was not prepared correctly; missing ${missing.join(', ')}${detail ? `: ${detail}` : ` (code ${initialized.code})`}`);
    }
  }
  await prepareManagedPrefix(compatibilityDataPath);
  await rebaseRuntimeSymlinks(path.join(compatibilityDataPath, 'pfx'), protonRoot);

  const files = path.join(protonRoot, 'files');
  // A locally built Wine uses the host SDK. Do not combine its GStreamer
  // module with the older libraries/plugins from the base Proton archive.
  // This is a runtime capability, never a per-game exception.
  let hostLibraries = false;
  let http2Runtime = false;
  let jsonRuntime = false;
  let shaderRuntime = false;
  let appStateRuntime = false;
  let dxvkRuntime = false;
  try {
    const metadata = JSON.parse(await fs.readFile(path.join(protonRoot, 'XODUS_NEXUS_PATCH.json'), 'utf8')) as { features?: unknown; components?: Record<string, string>; componentsByArch?: Record<string, Record<string, string>> };
    hostLibraries = Array.isArray(metadata.features) && metadata.features.includes('wine-host-libraries-v1');
    http2Runtime = Array.isArray(metadata.features) && metadata.features.includes('wine-winhttp-http2-v1');
    jsonRuntime = Array.isArray(metadata.features) && metadata.features.includes('winrt-json-v1');
    shaderRuntime = Array.isArray(metadata.features) && metadata.features.includes('hlsl-state-keywords-v1');
    appStateRuntime = Array.isArray(metadata.features) && metadata.features.includes('appstate-registration-v1');
    dxvkRuntime = Array.isArray(metadata.features) && metadata.features.includes('dxvk-constant-compare-v1');
    const dxvkComponents = ['d3d8.dll', 'd3d9.dll', 'd3d10core.dll', 'd3d11.dll', 'dxgi.dll'];
    // `components` are the x86_64 checksums; other PE directories are listed
    // under `componentsByArch` and are never checked against x86_64 bytes.
    const expectedComponents = metadata.componentsByArch?.[layout.peArch] ?? (layout.peArch === 'x86_64-windows' ? metadata.components : undefined);
    const components = [ ...(http2Runtime ? ['libnghttp2.dll'] : []), ...(jsonRuntime ? ['windows.web.dll'] : []), ...(shaderRuntime ? ['libvkd3d-shader-1.dll'] : []), ...(appStateRuntime ? ['twinapi.appcore.dll'] : []), ...(dxvkRuntime ? dxvkComponents : []) ];
    // Validate every component before changing any prefix entry.
    const verified = await Promise.all(components.map(async (name) => {
      // WinHTTP loads nghttp2 with LOAD_LIBRARY_SEARCH_SYSTEM32. WINEDLLPATH
      // alone is insufficient in existing prefixes. Validate before replacing
      // a directory entry so symlinks cannot overwrite another runtime.
      const library = name === 'libvkd3d-shader-1.dll' ? 'vkd3d' : dxvkComponents.includes(name) ? 'wine/dxvk' : 'wine';
      const source = path.join(files, 'lib', library, layout.peArch, name);
      const expected = expectedComponents?.[name];
      const bytes = await fs.readFile(source);
      if (!expected || createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`The shared runtime has an invalid ${name} checksum.`);
      return { name, bytes };
    }));
    for (const { name, bytes } of verified) {
      const target = path.join(compatibilityDataPath, 'pfx/drive_c/windows/system32', name);
      let current: Buffer | undefined;
      try { current = await fs.readFile(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!current?.equals(bytes)) {
        const temporary = `${target}.nexus-${process.pid}`;
        try {
          await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o644 });
          await fs.rename(temporary, target);
        } finally { await fs.unlink(temporary).catch(() => undefined); }
      }
    }
  } catch (error) {
    if (http2Runtime || jsonRuntime || shaderRuntime || appStateRuntime || dxvkRuntime) throw error;
    // Stock Proton keeps its bundled library environment.
  }
  const libraryDirectories = [
    path.join(files, 'lib', 'x86_64-linux-gnu'),
    path.join(files, 'lib', 'aarch64-linux-gnu'),
    path.join(files, 'lib', 'i386-linux-gnu'),
  ];
  // In particular, do not inherit editor/AppImage LD_LIBRARY_PATH entries.
  const protonLibraries = [...(hostLibraries ? ['/usr/lib'] : []), ...libraryDirectories].join(':');
  const gstPlugins = hostLibraries ? '/usr/lib/gstreamer-1.0' : libraryDirectories.map((directory) => path.join(directory, 'gstreamer-1.0')).join(':');
  const wineDllPath = [path.join(files, 'lib', 'vkd3d'), path.join(files, 'lib', 'wine')].join(':');
  const executablePath = [path.join(files, layout.bin), process.env.PATH ?? ''].filter(Boolean).join(':');
  const wineserver = path.join(files, layout.bin, 'wineserver');
  const eacRuntime = await installedEacRuntime(steamRoot);
  // Keep the caches outside temporary launch views, separately for each prefix.
  const shaderCaches = await prepareShaderCache(compatibilityDataPath);
  const defaultEnvironment = (name: string, value: string) => [
    `if [ "\${${name}+x}" != x ]; then`,
    `  export ${name}=${shellQuote(value)}`,
    'fi',
  ];
  const runner = path.join(compatibilityDataPath, 'xodus-proton-wine');
  const launchScript = path.join(compatibilityDataPath, 'xodus-proton-game');
  const wineOverrides = `dxgi=n;d3d11=n;d3d10core=n;d3d9=n;d3d12=n;d3d12core=n${http2Runtime ? ';winhttp=b;libnghttp2=n' : ''}${dxvkRuntime ? ';d3d8=n' : ''}`;
  // Play keeps the user's launch-option value for these two managed settings,
  // exactly like the previous layering where the game wrapper sat below Wine.
  const sharedScript = (launchLines: string[], extraExports: string[] = [], overridable = false) => [
    '#!/bin/sh',
    `export WINEPREFIX=${shellQuote(path.join(compatibilityDataPath, 'pfx'))}`,
    "export WINEARCH='win64'",
    `export WINEDLLPATH=${shellQuote(wineDllPath)}`,
    `export LD_LIBRARY_PATH=${shellQuote(protonLibraries)}`,
    // Match Proton's environment: Piper initializes eSpeak even before a
    // voice is loaded, and missing data can terminate the whole game process.
    `export ESPEAK_DATA_PATH=${shellQuote(path.join(files, 'share'))}`,
    `export GST_PLUGIN_SYSTEM_PATH_1_0=${shellQuote(gstPlugins)}`,
    "export GST_PLUGIN_PATH_1_0=''",
    `export WINE_GST_REGISTRY_DIR=${shellQuote(path.join(compatibilityDataPath, 'gstreamer-1.0'))}`,
    // The Proton converters may be selected when no native codec is present.
    // Without these fallback assets they fail setup and crash during teardown.
    `export MEDIACONV_BLANK_VIDEO_FILE=${shellQuote(path.join(files, 'share', 'media', 'blank.mkv'))}`,
    `export MEDIACONV_BLANK_AUDIO_FILE=${shellQuote(path.join(files, 'share', 'media', 'blank.ptna'))}`,
    `export PATH=${shellQuote(executablePath)}`,
    // The Proton session enables large-address-aware by default through its own
    // PROTON_FORCE_LARGE_ADDRESS_AWARE handling, so Play never exports a Wine
    // default here. An explicit launch-option value must still win: tell that
    // session to drop its default whenever Wine's own variable is defined. The
    // variable Proton received is never replaced, its own pair stays coherent.
    ...(overridable
      ? [
        ...defaultEnvironment('WINEDLLOVERRIDES', wineOverrides),
        'if [ "${WINE_LARGE_ADDRESS_AWARE+x}" = x ] && [ "${PROTON_FORCE_LARGE_ADDRESS_AWARE+x}" != x ]; then',
        "  export PROTON_FORCE_LARGE_ADDRESS_AWARE='0'",
        'fi',
      ]
      : [`export WINEDLLOVERRIDES=${shellQuote(wineOverrides)}`, "export WINE_LARGE_ADDRESS_AWARE='1'"]),
    // Preserve each explicit setting, including disabled/empty values. Limits
    // apply only when selecting our managed driver directory, not a custom one.
    ...defaultEnvironment('VKD3D_SHADER_CACHE_PATH', shaderCaches.vkd3d),
    'if [ "${__GL_SHADER_DISK_CACHE_PATH+x}" != x ]; then',
    `  export __GL_SHADER_DISK_CACHE_PATH=${shellQuote(shaderCaches.nvidia)}`,
    ...defaultEnvironment('__GL_SHADER_DISK_CACHE', '1'),
    ...defaultEnvironment('__GL_SHADER_DISK_CACHE_SIZE', cacheLimits.bytes),
    'fi',
    'if [ "${MESA_SHADER_CACHE_DIR+x}" != x ]; then',
    `  export MESA_SHADER_CACHE_DIR=${shellQuote(shaderCaches.mesa)}`,
    ...defaultEnvironment('MESA_SHADER_CACHE_MAX_SIZE', cacheLimits.mesa),
    'fi',
    // Use Steam's genuine compatibility bridge only when the launch did not
    // configure it at all. An explicit value, including an empty one, is a
    // choice: it must win over auto-discovery exactly like the settings above.
    ...(eacRuntime ? defaultEnvironment('PROTON_EAC_RUNTIME', eacRuntime) : []),
    // Private lifecycle command uses the exact same prefix/library environment
    // as launch. It is only invoked for explicit Stop/launcher shutdown.
    'if [ "${1:-}" = "--nexus-stop-prefix" ]; then',
    `  exec ${shellQuote(wineserver)} -k`,
    'fi',
    // FEX inspects the first .exe argument as a host path, so it runs before the
    // Play command rewrites a Unix executable into the prefix Z: form below.
    ...fexEnvironment(path.join(compatibilityDataPath, 'proton-fex-config.json'), path.join(files, 'lib', 'wine', 'i386-windows', 'xgameruntime.dll')),
    ...extraExports,
    // Force this after inherited launch options and every managed export: the
    // Proton session is Python and must not create __pycache__ inside the
    // immutable runtime family root.
    "export PYTHONDONTWRITEBYTECODE='1'",
    // Launchers (including EAC) may finish before the game they spawned.
    // Keep Xodus and its temporary launch view/account service alive until
    // the isolated game prefix has no remaining Wine processes.
    `if [ ! -x ${shellQuote(wineserver)} ]; then`,
    ...launchLines.map((line) => `  exec ${line}`),
    'fi',
    'launch_status=0',
    ...launchLines.map((line) => `${line} || launch_status=$?`),
    'wait_status=0',
    `${shellQuote(wineserver)} -w || wait_status=$?`,
    'if [ "$launch_status" -ne 0 ]; then exit "$launch_status"; fi',
    'exit "$wait_status"',
    '',
  ].join('\n');
  // Internal prefix operations and Stop keep using the runtime's Wine directly.
  const temporary = `${runner}.tmp-${process.pid}`;
  await fs.writeFile(temporary, sharedScript([`${shellQuote(winePath)} "$@"`]), { mode: 0o700 });
  await fs.rename(temporary, runner);
  await fs.chmod(runner, 0o700);
  // Play goes through the runtime's Proton session so its per-launch setup runs:
  // Proton derives the prefix from STEAM_COMPAT_DATA_PATH (the same managed
  // prefix), applies its environment and protonfixes, and processes the Proton
  // launch options of that runtime, for example PROTON_USE_OPTISCALER, before it
  // starts the game. Launch options still arrive in this process environment.
  const temporaryLaunch = `${launchScript}.tmp-${process.pid}`;
  const compatLocation = options.installPath ? await steamCompatLocation(options.installPath) : undefined;
  await fs.writeFile(temporaryLaunch, sharedScript([`${shellQuote(proton)} run "$@"`], [
    `export STEAM_COMPAT_DATA_PATH=${shellQuote(compatibilityDataPath)}`,
    `export STEAM_COMPAT_CLIENT_INSTALL_PATH=${shellQuote(steamRoot)}`,
    // Proton's own shader cache switch (PROTON_LOCAL_SHADER_CACHE) reads
    // STEAM_COMPAT_SHADER_PATH. Steam points it at the per-game shader cache, so
    // Nexus maps it to the managed cache of this prefix instead of inventing a
    // Steam library. The runtime keeps the driver caches above: it only applies
    // its own paths through setdefault.
    `export STEAM_COMPAT_SHADER_PATH=${shellQuote(shaderCaches.steamapp)}`,
    // Proton's game drive reads the game location from its environment. Report
    // the real install directory, and the genuine Steam library only when the
    // game is installed inside a `steamapps` directory; a Store installation
    // outside one gets no invented library. These two managed variables must
    // also match the captured context in the other direction: a verified value
    // replaces an inherited Steam/launcher value, and without one Play removes
    // it instead of letting a stale ambient value contradict the launch notice.
    ...(compatLocation
      ? [`export STEAM_COMPAT_INSTALL_PATH=${shellQuote(compatLocation.installPath)}`]
      : ['unset STEAM_COMPAT_INSTALL_PATH']),
    ...(compatLocation?.libraryPaths
      ? [`export STEAM_COMPAT_LIBRARY_PATHS=${shellQuote(compatLocation.libraryPaths)}`]
      : ['unset STEAM_COMPAT_LIBRARY_PATHS']),
    // Proton's session selects its launch route from UMU_ID, UMU_USE_STEAM and
    // whether the executable argument is a Unix path: with UMU_ID unset it runs
    // steam.exe, and a leading "/" selects umu.exe. Nexus starts the runtime's own
    // Wine with the command the backend prepared, so pin the plain-Wine route.
    "export UMU_ID='xodus-nexus'",
    "export UMU_USE_STEAM='0'",
    'case "${1:-}" in',
    '  /*)',
    '    nexus_game_command="Z:$1"',
    '    shift',
    '    set -- "$nexus_game_command" "$@"',
    '    ;;',
    'esac',
  ], true), { mode: 0o700 });
  await fs.rename(temporaryLaunch, launchScript);
  await fs.chmod(launchScript, 0o700);
  return { command: runner, launchCommand: launchScript, compatibilityDataPath, protonRoot, compatibilityLocation: compatLocation, stopPrefix: { command: runner, args: ['--nexus-stop-prefix'] } };
}
