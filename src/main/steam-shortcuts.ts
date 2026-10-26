import { constants, promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { commandWords } from '../shared/launch-tools.js';
import { selectCompatTool } from './steam-tool.js';

interface Field { type: number; key: string; value: string | number | Field[]; start: number; end: number }
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const empty = Buffer.from('\0shortcuts\0\x08\x08', 'binary');
const png = (bytes?: Buffer) => bytes && bytes.length <= 4 * 1024 * 1024 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
// Large imported libraries can contain over 11,000 shortcuts. Keep independent
// byte/field/depth limits so increasing capacity does not allow unbounded input.
const MAX_SHORTCUT_BYTES = 32 * 1024 * 1024;
const MAX_SHORTCUT_FIELDS = 500_000;

function parse(bytes: Buffer): Field[] {
  if (bytes.length > MAX_SHORTCUT_BYTES) throw Error('Steam shortcuts file is too large.');
  let offset = 0, count = 0;
  const text = () => {
    const end = bytes.indexOf(0, offset);
    if (end < 0 || end - offset > 65536) throw Error('Invalid Steam shortcut string.');
    const value = bytes.toString('utf8', offset, end);
    if (!Buffer.from(value).equals(bytes.subarray(offset, end))) throw Error('Invalid Steam shortcut encoding.');
    offset = end + 1; return value;
  };
  const object = (depth: number): Field[] => {
    if (depth > 8) throw Error('Steam shortcuts nesting is too deep.');
    const fields: Field[] = [];
    while (offset < bytes.length) {
      const start = offset, type = bytes[offset++];
      if (type === 8) return fields;
      if (++count > MAX_SHORTCUT_FIELDS) throw Error('Too many Steam shortcut fields.');
      const key = text(); let value: Field['value'];
      if (type === 0) value = object(depth + 1);
      else if (type === 1) value = text();
      else if ([2, 3, 4, 6, 7, 10].includes(type)) {
        const size = type === 7 || type === 10 ? 8 : 4;
        if (offset + size > bytes.length) throw Error('Truncated Steam shortcuts file.');
        value = bytes.readUInt32LE(offset); offset += size;
      } else throw Error('Unsupported Steam shortcuts format. Original file was not changed.');
      fields.push({ type, key, value, start, end: offset });
    }
    throw Error('Truncated Steam shortcuts file.');
  };
  const root = object(0);
  if (offset !== bytes.length || root.length !== 1 || root[0].type !== 0 || root[0].key !== 'shortcuts') throw Error('Invalid Steam shortcuts root.');
  const entries = root[0].value as Field[];
  if (entries.some(entry => entry.type !== 0 || !/^\d+$/.test(entry.key)) || new Set(entries.map(entry => entry.key)).size !== entries.length) throw Error('Invalid Steam shortcut entry.');
  return entries;
}
const field = (fields: Field[], key: string) => fields.find(value => value.key.toLowerCase() === key.toLowerCase())?.value;
const string = (key: string, value: string) => Buffer.concat([Buffer.from([1]), Buffer.from(key + '\0' + value + '\0')]);
const integer = (key: string, value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value >>> 0); return Buffer.concat([Buffer.from([2]), Buffer.from(key + '\0'), bytes]); };
export function steamArgument(value: string): string {
  if (/[\0\r\n]/.test(value) || value.includes('%command%')) throw Error('This path cannot be used in a Steam shortcut.');
  return '"' + value.replace(/["`$\\]/g, '\\$&') + '"';
}
export interface SteamLaunch { title: string; executable: string; options: string; directory: string; identity: string; icon: string }
/** Game shortcuts end in Steam's `%command%`, so a compatibility tool chosen in Steam reaches Nexus. */
export const STEAM_COMMAND = ' %command%';
/** ArmadaOS's per-game settings wrapper; its Decky plugin leaves options that already name it alone. */
export const ARMADA_LAUNCH_WRAPPER = '/usr/libexec/armada/armada-game-launch';
const ARMADA_SUFFIX = ` ${ARMADA_LAUNCH_WRAPPER}${STEAM_COMMAND}`;

/** The shortcut script and game id first, then Steam's command (behind ArmadaOS's wrapper there). */
export function steamCommandOptions(base: string, armada: boolean): string {
  return base + (armada ? ARMADA_SUFFIX : STEAM_COMMAND);
}

/**
 * Every older form of these options, still recognized and upgraded in place:
 * without `%command%`, as ArmadaOS wrapped it (`<wrapper> %command% <base>`),
 * and the other platform's form.
 */
function olderOptions(options: string): string[] {
  const base = options.endsWith(ARMADA_SUFFIX) ? options.slice(0, -ARMADA_SUFFIX.length)
    : options.endsWith(STEAM_COMMAND) ? options.slice(0, -STEAM_COMMAND.length) : undefined;
  if (base === undefined) return [];
  return [base, `${ARMADA_LAUNCH_WRAPPER}${STEAM_COMMAND} ${base}`, base + STEAM_COMMAND, base + ARMADA_SUFFIX].filter(form => form !== options);
}
export function findSteamLaunch(bytes: Buffer, launch: SteamLaunch): number | undefined {
  return findSteamLaunches(bytes, launch)[0];
}
export function findSteamLaunches(bytes: Buffer, launch: SteamLaunch): number[] {
  const sameWords = (left: unknown, right: string) => {
    if (typeof left !== 'string') return false;
    try { return JSON.stringify(commandWords(left)) === JSON.stringify(commandWords(right)); }
    catch { return left === right; }
  };
  const matches = new Set<number>();
  for (const entry of parse(bytes)) {
    const fields = entry.value as Field[];
    const known = [launch.options, ...olderOptions(launch.options)];
    if (!sameWords(field(fields, 'Exe'), launch.executable) || !known.some(form => sameWords(field(fields, 'LaunchOptions'), form))) continue;
    const appid = field(fields, 'appid');
    if (typeof appid === 'number' && (appid & 0x80000000)) matches.add(appid);
  }
  return [...matches];
}
export function planSteamShortcut(original: Buffer | undefined, launch: SteamLaunch): { bytes: Buffer; appid: number; added: boolean } {
  const bytes = original ?? empty, entries = parse(bytes);
  if ([launch.title, launch.executable, launch.options, launch.directory, launch.identity, launch.icon].some(value => /\0/.test(value) || value.length > 4096)) throw Error('Invalid Steam shortcut data.');
  const older = olderOptions(launch.options);
  for (const entry of entries) {
    const fields = entry.value as Field[];
    const options = fields.find(value => value.key.toLowerCase() === 'launchoptions');
    if (field(fields, 'exe') !== launch.executable || !options || (options.value !== launch.options && !older.includes(options.value as string))) continue;
    const appid = field(fields, 'appid');
    if (typeof appid !== 'number' || !(appid & 0x80000000)) throw Error('Invalid existing Steam shortcut ID.');
    if (options.value === launch.options) return { bytes, appid, added: false };
    // Upgrade only this entry's launch options; its id, artwork and Steam
    // settings (such as the chosen compatibility tool) stay as they are.
    const updated = Buffer.concat([bytes.subarray(0, options.start), string(options.key, launch.options), bytes.subarray(options.end)]);
    parse(updated);
    return { bytes: updated, appid, added: true };
  }
  // Steam stores the ID explicitly. Include the profile/game identity so games
  // with the same title and shared /bin/sh executable cannot collide silently.
  let crc = 0xffffffff;
  for (const byte of Buffer.from(launch.executable + launch.title + launch.identity)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const appid = ((crc ^ 0xffffffff) | 0x80000000) >>> 0;
  if (entries.some(entry => field(entry.value as Field[], 'appid') === appid)) throw Error('Steam shortcut ID collision. No existing entry was changed.');
  const index = entries.reduce((highest, entry) => Math.max(highest, Number(entry.key)), -1) + 1;
  if (!Number.isSafeInteger(index)) throw Error('Invalid Steam shortcut index.');
  const block = Buffer.concat([Buffer.from('\0' + index + '\0'), integer('appid', appid), string('AppName', launch.title),
    string('Exe', launch.executable), string('StartDir', steamArgument(launch.directory)), string('icon', launch.icon),
    string('ShortcutPath', ''), string('LaunchOptions', launch.options), integer('IsHidden', 0), integer('AllowDesktopConfig', 1),
    integer('AllowOverlay', 1), integer('OpenVR', 0), integer('Devkit', 0), string('DevkitGameID', ''),
    integer('DevkitOverrideAppID', 0), integer('LastPlayTime', 0), string('FlatpakAppID', ''),
    Buffer.from('\0tags\0\x01' + '0\0Xodus Nexus\0\x08\x08')]);
  const updated = Buffer.concat([bytes.subarray(0, -2), block, bytes.subarray(-2)]);
  parse(updated);
  return { bytes: updated, appid, added: true };
}

export async function steamRunning(): Promise<boolean> {
  for (const pid of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if ((await fs.stat(`/proc/${pid}`)).uid !== process.getuid?.()) continue;
      if (/^(steam|steamwebhelper)$/i.test((await fs.readFile(`/proc/${pid}/comm`, 'utf8')).trim())) return true;
    } catch (error) { if (!missing(error) && (error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  return false;
}
async function safeDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw Error('Unsafe Steam configuration directory.');
}
export async function readSteamShortcuts(file: string): Promise<Buffer | undefined> {
  try {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o022) || stat.size > MAX_SHORTCUT_BYTES) throw Error('Unsafe Steam shortcuts file.');
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw Error('Steam shortcuts changed concurrently.');
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw Error('Steam shortcuts changed concurrently.');
      return bytes;
    } finally { await handle.close(); }
  } catch (error) { if (!missing(error)) throw error; }
}
export async function steamAccounts(home: string): Promise<string[]> {
  const accounts = new Set<string>();
  for (const candidate of [path.join(home, '.steam/steam'), path.join(home, '.local/share/Steam'),
    path.join(home, '.var/app/com.valvesoftware.Steam/.local/share/Steam')]) {
    try {
      const root = await fs.realpath(candidate);
      await safeDirectory(root);
      const userdata = path.join(root, 'userdata'); await safeDirectory(userdata);
      for (const id of await fs.readdir(userdata)) if (/^\d+$/.test(id) && id !== '0') {
        const user = path.join(userdata, id); await safeDirectory(user);
        const config = path.join(user, 'config');
        try { await safeDirectory(config); accounts.add(config); } catch (error) { if (!missing(error)) throw error; }
      }
    } catch (error) { if (!missing(error)) throw error; }
  }
  return [...accounts];
}
export async function writeSteamArtwork(config: string, appid: number, artwork: { cover?: Buffer; wide?: Buffer }): Promise<void> {
  if (!Number.isInteger(appid) || appid < 0x80000000 || appid > 0xffffffff) throw Error('Invalid Steam shortcut ID.');
  await safeDirectory(config);
  const grid = path.join(config, 'grid');
  await fs.mkdir(grid, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await safeDirectory(grid);
  const art = [[`${appid}p.png`, artwork.cover], [`${appid}.png`, artwork.wide ?? artwork.cover],
    [`${appid}_hero.png`, artwork.wide ?? artwork.cover]] as const;
  for (const [name, bytes] of art) if (png(bytes)) {
    try { await fs.writeFile(path.join(grid, name), bytes!, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
}
export async function addSteamShortcut(config: string, launch: SteamLaunch, artwork: { cover?: Buffer; wide?: Buffer },
  running = steamRunning, compatTool?: string): Promise<string> {
  const stopped = async () => { if (await running()) throw Error('Close Steam completely, then try Add to Steam again. Nexus will not close Steam for you.'); };
  await stopped(); await safeDirectory(config);
  const lockPath = path.join(config, '.xodus-nexus-shortcuts.lock');
  const lock = await fs.open(lockPath, 'wx', 0o600).catch(() => { throw Error('Another Steam shortcut update is in progress.'); });
  const file = path.join(config, 'shortcuts.vdf'), temp = file + '.nexus-' + randomUUID();
  try {
    const original = await readSteamShortcuts(file);
    const planned = planSteamShortcut(original, launch);
    await stopped();
    // Existing custom artwork is always preserved, including artwork on an
    // already-added shortcut. Exclusive creation never follows existing links.
    await writeSteamArtwork(config, planned.appid, artwork);
    if (planned.added) {
      await fs.writeFile(temp, planned.bytes, { flag: 'wx', mode: 0o600 });
      if (original) await fs.writeFile(file + '.nexus-backup-' + randomUUID(), original, { flag: 'wx', mode: 0o600 });
      const current = await readSteamShortcuts(file);
      if (original ? !current?.equals(original) : current !== undefined) throw Error('Steam shortcuts changed concurrently. Try again after closing Steam.');
      await stopped();
      if (original) await fs.rename(temp, file);
      else await fs.link(temp, file);
    }
    // The shortcut's Compatibility choice, unless the player already made one.
    if (compatTool) {
      await stopped();
      await selectCompatTool(path.resolve(config, '..', '..', '..'), planned.appid, compatTool)
        .catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
    return `steam://rungameid/${(BigInt(planned.appid) << 32n) | 0x02000000n}`;
  } finally {
    await fs.rm(temp, { force: true });
    await lock.close(); await fs.unlink(lockPath);
  }
}
