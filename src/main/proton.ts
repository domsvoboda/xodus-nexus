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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export interface ProtonRunner {
  command: string;
  launchCommand?: string;
  compatibilityDataPath: string;
  stopPrefix: { command: string; args: string[] };
}

const REQUIRED_PREFIX_FILES = [
  'drive_c/windows/system32/libvkd3d-utils-1.dll',
  'drive_c/windows/system32/dxgi.dll',
  'drive_c/windows/system32/d3d12.dll',
];

async function missingPrefixFiles(compatibilityDataPath: string): Promise<string[]> {
  const prefix = path.join(compatibilityDataPath, 'pfx');
  const missing: string[] = [];
  for (const relative of REQUIRED_PREFIX_FILES) {
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

export async function prepareProtonRunner(
  winePath: string,
  compatibilityDataPath: string,
  steamRoot: string,
  gameWineCommand = winePath,
  shaderCacheLimitGiB = DEFAULT_SHADER_CACHE_GIB,
): Promise<ProtonRunner | undefined> {
  const cacheLimits = shaderCacheLimits(shaderCacheLimitGiB);
  const protonRoot = path.resolve(path.dirname(winePath), '..', '..');
  const proton = path.join(protonRoot, 'proton');
  const defaultPrefix = path.join(protonRoot, 'files', 'share', 'default_pfx');
  try {
    await fs.access(proton, constants.X_OK);
    await fs.access(defaultPrefix, constants.R_OK);
  } catch {
    return undefined;
  }

  await prepareManagedPrefix(compatibilityDataPath);
  await fs.mkdir(steamRoot, { recursive: true });
  await rebaseRuntimeSymlinks(path.join(compatibilityDataPath, 'pfx'), protonRoot);
  let missing = await missingPrefixFiles(compatibilityDataPath);
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
      },
      maxOutput: 1_000_000,
    });
    missing = await missingPrefixFiles(compatibilityDataPath);
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
    const metadata = JSON.parse(await fs.readFile(path.join(protonRoot, 'XODUS_NEXUS_PATCH.json'), 'utf8')) as { features?: unknown; components?: Record<string, string> };
    hostLibraries = Array.isArray(metadata.features) && metadata.features.includes('wine-host-libraries-v1');
    http2Runtime = Array.isArray(metadata.features) && metadata.features.includes('wine-winhttp-http2-v1');
    jsonRuntime = Array.isArray(metadata.features) && metadata.features.includes('winrt-json-v1');
    shaderRuntime = Array.isArray(metadata.features) && metadata.features.includes('hlsl-state-keywords-v1');
    appStateRuntime = Array.isArray(metadata.features) && metadata.features.includes('appstate-registration-v1');
    dxvkRuntime = Array.isArray(metadata.features) && metadata.features.includes('dxvk-constant-compare-v1');
    const dxvkComponents = ['d3d8.dll', 'd3d9.dll', 'd3d10core.dll', 'd3d11.dll', 'dxgi.dll'];
    const components = [ ...(http2Runtime ? ['libnghttp2.dll'] : []), ...(jsonRuntime ? ['windows.web.dll'] : []), ...(shaderRuntime ? ['libvkd3d-shader-1.dll'] : []), ...(appStateRuntime ? ['twinapi.appcore.dll'] : []), ...(dxvkRuntime ? dxvkComponents : []) ];
    // Validate every component before changing any prefix entry.
    const verified = await Promise.all(components.map(async (name) => {
      // WinHTTP loads nghttp2 with LOAD_LIBRARY_SEARCH_SYSTEM32. WINEDLLPATH
      // alone is insufficient in existing prefixes. Validate before replacing
      // a directory entry so symlinks cannot overwrite another runtime.
      const library = name === 'libvkd3d-shader-1.dll' ? 'vkd3d' : dxvkComponents.includes(name) ? 'wine/dxvk' : 'wine';
      const source = path.join(files, 'lib', library, 'x86_64-windows', name);
      const expected = metadata.components?.[name];
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
  const executablePath = [path.join(files, 'bin'), process.env.PATH ?? ''].filter(Boolean).join(':');
  const eacRuntime = await installedEacRuntime(steamRoot);
  // Keep the caches outside temporary launch views, separately for each prefix.
  const shaderCaches = await prepareShaderCache(compatibilityDataPath);
  const defaultEnvironment = (name: string, value: string) => [
    `if [ "\${${name}+x}" != x ]; then`,
    `  export ${name}=${shellQuote(value)}`,
    'fi',
  ];
  const runner = path.join(compatibilityDataPath, 'xodus-proton-wine');
  const temporary = `${runner}.tmp-${process.pid}`;
  const makeScript = (launchWine: string) => [
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
    `export WINEDLLOVERRIDES='dxgi=n;d3d11=n;d3d10core=n;d3d9=n;d3d12=n;d3d12core=n${http2Runtime ? ';winhttp=b;libnghttp2=n' : ''}${dxvkRuntime ? ';d3d8=n' : ''}'`,
    "export WINE_LARGE_ADDRESS_AWARE='1'",
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
    // Use Steam's genuine compatibility bridge when installed. Never force a
    // particular game to load it or replace an explicit user configuration.
    ...(eacRuntime ? [
      'if [ -z "${PROTON_EAC_RUNTIME:-}" ]; then',
      `  export PROTON_EAC_RUNTIME=${shellQuote(eacRuntime)}`,
      'fi',
    ] : []),
    // Private lifecycle command uses the exact same prefix/library environment
    // as launch. It is only invoked for explicit Stop/launcher shutdown.
    'if [ "${1:-}" = "--nexus-stop-prefix" ]; then',
    `  exec ${shellQuote(path.join(files, 'bin', 'wineserver'))} -k`,
    'fi',
    // Launchers (including EAC) may finish before the game they spawned.
    // Keep Xodus and its temporary launch view/account service alive until
    // the isolated game prefix has no remaining Wine processes.
    `if [ ! -x ${shellQuote(path.join(files, 'bin', 'wineserver'))} ]; then`,
    `  exec ${shellQuote(launchWine)} "$@"`,
    'fi',
    'launch_status=0',
    `${shellQuote(launchWine)} "$@" || launch_status=$?`,
    'wait_status=0',
    `${shellQuote(path.join(files, 'bin', 'wineserver'))} -w || wait_status=$?`,
    'if [ "$launch_status" -ne 0 ]; then exit "$launch_status"; fi',
    'exit "$wait_status"',
    '',
  ].join('\n');
  await fs.writeFile(temporary, makeScript(winePath), { mode: 0o700 });
  await fs.rename(temporary, runner);
  await fs.chmod(runner, 0o700);
  let launchCommand: string | undefined;
  if (gameWineCommand !== winePath) {
    launchCommand = path.join(compatibilityDataPath, 'xodus-proton-game');
    const temporaryLaunch = `${launchCommand}.tmp-${process.pid}`;
    await fs.writeFile(temporaryLaunch, makeScript(gameWineCommand), { mode: 0o700 });
    await fs.rename(temporaryLaunch, launchCommand);
    await fs.chmod(launchCommand, 0o700);
  }
  return { command: runner, ...(launchCommand ? { launchCommand } : {}), compatibilityDataPath, stopPrefix: { command: runner, args: ['--nexus-stop-prefix'] } };
}
