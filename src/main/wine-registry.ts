import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/**
 * Small, exact edits to a Wine prefix's registry files (system.reg, user.reg)
 * while no Wine process uses the prefix, for compatibility tools Nexus cannot
 * run a Windows helper in. A file is a header followed by sections that each
 * start with a `[Key\\Path] <time>` line; key paths are escaped (`\\`).
 */

const escapeKey = (key: string) => key.replace(/\\/g, '\\\\');
const sameKey = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

interface Section { key: string; lines: string[] }

function parse(text: string): { head: string[]; sections: Section[] } {
  const head: string[] = [];
  const sections: Section[] = [];
  for (const line of text.split('\n')) {
    const header = line.match(/^\[((?:[^\\\]]|\\.)*)\]/);
    if (header) sections.push({ key: header[1], lines: [line] });
    else if (sections.length) sections[sections.length - 1].lines.push(line);
    else head.push(line);
  }
  return { head, sections };
}

const serialize = (head: string[], sections: Section[]) => [...head, ...sections.flatMap(section => section.lines)].join('\n');

/** REG_QWORD as Wine writes it: `hex(b):` and eight little-endian bytes. */
export function qwordValue(value: bigint): string {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return `hex(b):${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(',')}`;
}

/** Sets REG_QWORD values under `key`, adding the section when it is missing. */
export function withQwords(text: string, key: string, values: Record<string, bigint>, now = new Date()): string {
  const { head, sections } = parse(text);
  const escaped = escapeKey(key);
  let section = sections.find(item => sameKey(item.key, escaped));
  if (!section) {
    const seconds = Math.floor(now.getTime() / 1000);
    const filetime = (BigInt(seconds) + 11_644_473_600n) * 10_000_000n;
    section = { key: escaped, lines: [`[${escaped}] ${seconds}`, `#time=${filetime.toString(16)}`, ''] };
    // Exactly one blank line separates sections.
    const last = sections[sections.length - 1]?.lines;
    if (last) {
      while (last.length > 1 && last[last.length - 1] === '') last.pop();
      last.push('');
    }
    sections.push(section);
  }
  for (const [name, value] of Object.entries(values)) {
    const line = `"${name}"=${qwordValue(value)}`;
    const index = section.lines.findIndex(item => item.toLowerCase().startsWith(`"${name.toLowerCase()}"=`));
    if (index < 0) {
      // Before the section's trailing blank lines.
      let at = section.lines.length;
      while (at > 1 && section.lines[at - 1] === '') at--;
      section.lines.splice(at, 0, line);
    } else {
      // Drop the old value's continuation lines (two-space indented hex).
      let end = index + 1;
      while (end < section.lines.length && /^  /.test(section.lines[end])) end++;
      section.lines.splice(index, end - index, line);
    }
  }
  return serialize(head, sections);
}

/** Removes `key` and every subkey. Returns undefined when it was not there. */
export function withoutKeyTree(text: string, key: string): string | undefined {
  const { head, sections } = parse(text);
  const escaped = escapeKey(key).toLowerCase();
  const kept = sections.filter(section => {
    const name = section.key.toLowerCase();
    return name !== escaped && !name.startsWith(`${escaped}\\\\`);
  });
  return kept.length === sections.length ? undefined : serialize(head, kept);
}

/** Whether any process (wineserver included) runs with this WINEPREFIX. */
export async function prefixInUse(prefix: string, proc = '/proc'): Promise<boolean> {
  const resolved = path.posix.resolve(prefix);
  const wanted = new Set([`WINEPREFIX=${resolved}`, `WINEPREFIX=${resolved}/`]);
  for (const name of await fs.readdir(proc).catch(() => [] as string[])) {
    if (!/^\d+$/.test(name)) continue;
    const environment = await fs.readFile(path.join(proc, name, 'environ'), 'utf8').catch(() => '');
    if (environment.split('\0').some(entry => wanted.has(entry))) return true;
  }
  return false;
}

/** Waits for a prefix to have no Wine processes (its wineserver lingers briefly after the last one). */
export async function waitForIdlePrefix(prefix: string, timeoutMs = 15_000, proc = '/proc'): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (await prefixInUse(prefix, proc)) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return true;
}

/** Rewrites a registry file atomically, keeping its mode; refuses links and foreign owners. */
export async function updateRegistryFile(file: string, change: (text: string) => string | undefined): Promise<boolean> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw new Error(`Unsafe registry file: ${file}`);
  const original = await fs.readFile(file, 'utf8');
  const updated = change(original);
  if (updated === undefined || updated === original) return false;
  const temporary = `${file}.nexus-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, updated, { flag: 'wx', mode: stat.mode & 0o777 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
  return true;
}

/** The value the runtime's Gaming Services helper writes: 38.117.27001.0. */
export const GAMING_SERVICES_VERSION = 0x0026007569790000n;

/**
 * What the Nexus runtime does with a Windows helper and `reg delete`, done in
 * the files of a prefix another compatibility tool owns. Skipped (with a
 * reason) while Wine runs in it, since Wine would write its copy back.
 */
export async function applyPrefixSettings(prefix: string, settings: { gamingServices: boolean; resetLocale: boolean },
  onLine: (line: string) => void): Promise<void> {
  if (!settings.gamingServices && !settings.resetLocale) return;
  if (!await waitForIdlePrefix(prefix)) {
    onLine('Wine is still running in the Steam prefix; Gaming Services and language settings were not changed this time.');
    return;
  }
  if (settings.gamingServices && await updateRegistryFile(path.join(prefix, 'system.reg'), text =>
    withQwords(text, 'Software\\Microsoft\\GamingServices', { AvailableVersion: GAMING_SERVICES_VERSION, CurrentVersion: GAMING_SERVICES_VERSION }))) {
    onLine('Nexus runtime: TEMPORARY Gaming Services version override 38.117.27001.0; not an installed Microsoft service.');
  }
  if (settings.resetLocale && await updateRegistryFile(path.join(prefix, 'user.reg'), text => withoutKeyTree(text, 'Control Panel\\International'))) {
    onLine('Reset the Windows user locale of the Steam prefix; Wine rebuilds it from the game language.');
  }
}
