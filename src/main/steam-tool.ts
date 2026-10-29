import { constants, promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/**
 * Xodus Nexus as an entry in Steam's Compatibility dropdown. The tool lives in
 * `compatibilitytools.d/xodus-nexus` under a stable internal name, so shortcuts
 * keep pointing at it across runtime updates; its `proton` hands over to the
 * current Nexus runtime. For a Nexus shortcut the launcher recognizes the
 * tool and runs the game exactly as without one (Nexus prefix and runtime).
 */
export const NEXUS_TOOL_NAME = 'xodus-nexus';
const MARKER = 'xodus-nexus-tool.json';
const DEFAULT_MANIFEST = '"manifest"\n{\n  "version" "2"\n  "commandline" "/proton %verb%"\n}\n';

const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

/** Whether a Proton directory from Steam's launch command is the Nexus tool. */
export async function isNexusTool(protonRoot: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await fs.readFile(path.join(protonRoot, MARKER), 'utf8')) as { schema?: unknown; tool?: unknown };
    return marker.schema === 1 && marker.tool === NEXUS_TOOL_NAME;
  } catch { return false; }
}

/** The native Steam installations of this user (never Flatpak Steam, which cannot see the runtime). */
export async function steamRoots(home: string): Promise<string[]> {
  const roots = new Set<string>();
  for (const candidate of [path.join(home, '.steam/root'), path.join(home, '.steam/steam'), path.join(home, '.local/share/Steam')]) {
    try {
      const root = await fs.realpath(candidate);
      const stat = await fs.lstat(root);
      if (stat.isDirectory() && stat.uid === process.getuid?.() && !(stat.mode & 0o022)) roots.add(root);
    } catch { /* Not installed here. */ }
  }
  return [...roots];
}

async function ownedDirectory(directory: string, create: boolean): Promise<void> {
  if (create) await fs.mkdir(directory, { mode: 0o755 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) {
    throw new Error(`Unsafe Steam compatibility tool directory: ${directory}`);
  }
}

async function writeIfChanged(file: string, content: string, mode: number): Promise<boolean> {
  const current = await fs.readFile(file, 'utf8').catch(() => undefined);
  if (current === content) {
    await fs.chmod(file, mode);
    return false;
  }
  const temporary = `${file}.nexus-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, content, { mode, flag: 'wx' });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
  return true;
}

/** The tool's files for a Nexus runtime release (a complete Proton tree). */
export async function nexusToolFiles(runtimeRoot: string): Promise<Record<string, { content: string; mode: number }>> {
  if (!path.isAbsolute(runtimeRoot) || /[\0\r\n]/.test(runtimeRoot)) throw new Error('Invalid Nexus runtime path.');
  await fs.access(path.join(runtimeRoot, 'proton'), constants.X_OK);
  // Steam reads the tool's needs (its Steam Linux Runtime) from this manifest.
  const manifest = await fs.readFile(path.join(runtimeRoot, 'toolmanifest.vdf'), 'utf8').catch(() => DEFAULT_MANIFEST);
  return {
    'compatibilitytool.vdf': { mode: 0o644, content: [
      '"compatibilitytools"', '{', '  "compat_tools"', '  {', `    "${NEXUS_TOOL_NAME}"`, '    {',
      '      "install_path" "."', '      "display_name" "Xodus Nexus"', '      "from_oslist"  "windows"', '      "to_oslist"    "linux"',
      '    }', '  }', '}', ''].join('\n') },
    'toolmanifest.vdf': { mode: 0o644, content: manifest },
    // Games that are not Nexus shortcuts run with the Nexus runtime's own Proton.
    proton: { mode: 0o755, content: `#!/bin/sh\n# Xodus Nexus compatibility tool: the current Nexus runtime.\nexec ${shellQuote(path.join(runtimeRoot, 'proton'))} "$@"\n` },
    [MARKER]: { mode: 0o644, content: JSON.stringify({ schema: 1, tool: NEXUS_TOOL_NAME, runtime: runtimeRoot }, null, 2) + '\n' },
  };
}

/**
 * Registers or refreshes the tool in every native Steam installation. Returns
 * the roots where files changed, and those where the tool is new: Steam lists
 * a new tool only after a restart, so it cannot be selected there before.
 */
export async function registerNexusTool(home: string, runtimeRoot: string): Promise<{ changed: string[]; created: string[] }> {
  const files = await nexusToolFiles(runtimeRoot);
  const changed: string[] = [], created: string[] = [];
  for (const root of await steamRoots(home)) {
    const tools = path.join(root, 'compatibilitytools.d');
    await ownedDirectory(tools, true);
    const directory = path.join(tools, NEXUS_TOOL_NAME);
    const isNew = !await isNexusTool(directory);
    await ownedDirectory(directory, true);
    let any = false;
    for (const [name, file] of Object.entries(files)) any = await writeIfChanged(path.join(directory, name), file.content, file.mode) || any;
    if (any) changed.push(root);
    if (isNew) created.push(root);
  }
  return { changed, created };
}

/**
 * Adds `"<appid>" { "name" "<tool>" … }` to Steam's CompatToolMapping unless
 * the shortcut already has a choice. Text VDF; only the one block changes.
 * Returns the new content, or undefined when nothing needs to change.
 */
export function withCompatTool(text: string, appid: number, tool: string): string | undefined {
  if (!Number.isInteger(appid) || appid < 0 || !/^[A-Za-z0-9._-]+$/.test(tool)) throw new Error('Invalid compatibility tool mapping.');
  const start = text.search(/"CompatToolMapping"\s*\{/);
  if (start < 0) return undefined;
  const open = text.indexOf('{', start);
  let depth = 0, quoted = false, close = -1;
  const keys: string[] = [];
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '\\') index++;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      if (depth === 1) {
        const end = text.indexOf('"', index + 1);
        // A key at depth 1 is followed by its block.
        if (/^\s*\{/.test(text.slice(end + 1))) keys.push(text.slice(index + 1, end));
        index = end;
        continue;
      }
      quoted = true;
    } else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) { close = index; break; }
  }
  if (close < 0) throw new Error('Steam config.vdf has an unterminated CompatToolMapping block.');
  if (keys.includes(String(appid))) return undefined;
  const lineStart = text.lastIndexOf('\n', close) + 1;
  const indent = text.slice(lineStart, close).match(/^\t*/)?.[0] ?? '';
  const entry = `${indent}\t"${appid}"\n${indent}\t{\n${indent}\t\t"name"\t\t"${tool}"\n${indent}\t\t"config"\t\t""\n${indent}\t\t"priority"\t\t"250"\n${indent}\t}\n`;
  return text.slice(0, lineStart) + entry + text.slice(lineStart);
}

/** Selects the tool for a shortcut in a stopped Steam's config.vdf (backup kept). */
export async function selectCompatTool(steamRoot: string, appid: number, tool = NEXUS_TOOL_NAME): Promise<boolean> {
  const file = path.join(steamRoot, 'config', 'config.vdf');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) || stat.size > 32 * 1024 * 1024) throw new Error('Unsafe Steam config.vdf.');
  const original = await fs.readFile(file, 'utf8');
  const updated = withCompatTool(original, appid, tool);
  if (updated === undefined) return false;
  await fs.writeFile(`${file}.nexus-backup-${randomUUID()}`, original, { flag: 'wx', mode: 0o600 });
  const temporary = `${file}.nexus-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, updated, { flag: 'wx', mode: stat.mode & 0o777 });
    if ((await fs.readFile(file, 'utf8')) !== original) throw new Error('Steam config.vdf changed concurrently. Try again after closing Steam.');
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
  return true;
}
