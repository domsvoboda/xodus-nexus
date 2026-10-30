import { constants, promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Game } from '../shared/types.js';
import { steamArgument, type SteamLaunch } from './steam-shortcuts.js';

export type ShortcutDestination = 'desktop' | 'applications';
const validId = (id: string) => /^[a-f0-9]{16}$/.test(id);
const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
const desktopValue = (value: string) => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
// Desktop Exec is NOT a shell command. Escape both the value and Exec layers.
export const desktopArgument = (value: string) => desktopValue(`"${value.replace(/%/g, '%%').replace(/["`$\\]/g, '\\$&')}"`);

export function shortcutTitleStem(title: string): string {
  const clean = title.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '');
  let stem = '', escapedBytes = 0;
  for (const char of clean) {
    const cost = /^[A-Za-z0-9_.]$/.test(char) ? 1 : Buffer.byteLength(char) * 4;
    if (escapedBytes + cost > 150 || Buffer.byteLength(stem + char) > 120) break;
    stem += char; escapedBytes += cost;
  }
  return stem.trimEnd() || 'Xodus Nexus game';
}

export function shortcutArguments(argv: string[]): { gameId?: string; profile?: string } {
  const result: { gameId?: string; profile?: string } = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag !== '--launch-game' && flag !== '--nexus-profile') continue;
    const value = argv[++index];
    if (flag === '--launch-game') {
      if (result.gameId || !value || !validId(value)) throw new Error('Invalid game shortcut ID.');
      result.gameId = value;
    } else {
      if (result.profile || !value || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error('Invalid Nexus profile path.');
      result.profile = value;
    }
  }
  return result;
}

/** Chromium reorders switches in second-instance argv. Send the parsed request
 * through Electron's JSON handoff instead of parsing that transformed argv. */
export function shortcutInstanceData(request: ReturnType<typeof shortcutArguments>, invalid = false): Record<string, unknown> {
  return { nexusShortcut: invalid ? { schema: 1, invalid: true } : { schema: 1, request } };
}

export function shortcutInstanceRequest(data: unknown, currentProfile: string): ReturnType<typeof shortcutArguments> {
  const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
  if (!object(data) || !object(data.nexusShortcut)) throw Error('Missing Nexus shortcut handoff. Restart Nexus using the updated launcher.');
  const message = data.nexusShortcut;
  if (message.schema !== 1 || message.invalid !== undefined || !object(message.request)) throw Error('Invalid Nexus shortcut request.');
  const request = message.request;
  if (Object.keys(request).some(key => key !== 'profile' && key !== 'gameId')) throw Error('Invalid Nexus shortcut request.');
  const argv: string[] = [];
  if (Object.hasOwn(request, 'profile')) {
    if (typeof request.profile !== 'string') throw Error('Invalid Nexus profile path.');
    argv.push('--nexus-profile', request.profile);
  }
  if (Object.hasOwn(request, 'gameId')) {
    if (typeof request.gameId !== 'string') throw Error('Invalid game shortcut ID.');
    argv.push('--launch-game', request.gameId);
  }
  const result = shortcutArguments(argv);
  if (result.profile && path.resolve(result.profile) !== path.resolve(currentProfile)) throw Error('Shortcut belongs to a different Nexus profile.');
  return result;
}

interface Locations { userData: string; desktop: string; applications: string; launcher?: string; icon: string }
export async function shortcutLauncherPath(appImage:string,argv0?:string):Promise<string>{
  const resolved=await fs.realpath(appImage);
  const stable=path.join(path.dirname(appImage),'Xodus-Nexus.AppImage');
  try{if((await fs.lstat(stable)).isSymbolicLink()&&await fs.realpath(stable)===resolved)return stable;}catch{}
  if(argv0&&path.isAbsolute(argv0)&&!/[\0\r\n]/.test(argv0)){
    try{if(await fs.realpath(argv0)===resolved)return argv0;}catch{}
  }
  return appImage;
}
export class GameShortcuts {
  private entry?: string;
  private icon?: string;
  private nexusEntry?: string;
  private readonly profileId: string;
  constructor(private locations: Locations) {
    this.profileId = createHash('sha256').update(path.resolve(locations.userData)).digest('hex').slice(0, 12);
  }
  get available(): boolean { return Boolean(this.entry); }
  get reason(): string | undefined { return this.available ? undefined : 'Shortcuts require an installed Linux launcher or AppImage with a persistent executable path.'; }
  private get marker(): string { return `X-Xodus-Nexus-Profile=${this.profileId}`; }

  private async directory(directory: string): Promise<void> {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022))
      throw new Error('Shortcut directory must be owned by your user and not writable by others.');
  }
  private async write(file: string, bytes: string | Buffer, mode: number, marker?: string | string[]): Promise<void> {
    try {
      const stat = await fs.lstat(file);
      const markers = marker ? (Array.isArray(marker) ? marker : [marker]) : [];
      const lines = markers.length && stat.isFile() ? (await fs.readFile(file, 'utf8')).split('\n') : [];
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) ||
          !markers.every(value => lines.includes(value)))
        throw new Error('Refusing to replace an unrelated or unsafe shortcut file.');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const temporary = `${file}.${randomUUID()}`;
    try {
      await fs.writeFile(temporary, bytes, { flag: 'wx', mode });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async initialize(): Promise<void> {
    if (!this.locations.launcher) return;
    const launcher = this.locations.launcher;
    if (/[\0\r\n]/.test(launcher) || !path.isAbsolute(launcher) || !(await fs.stat(launcher)).isFile()) throw new Error('Invalid launcher executable.');
    await fs.access(launcher, constants.X_OK);
    const directory = path.join(this.locations.userData, 'shortcuts');
    await this.directory(directory);
    const entry = path.join(directory, 'launch-game');
    // No tokens or runtime paths in shortcuts. Refresh after moving/updating the app.
    const body = (game: boolean) => `#!/bin/sh\n# ${this.marker}\nunset APPIMAGE APPDIR ARGV0 OWD ELECTRON_RUN_AS_NODE VITE_DEV_SERVER_URL XODUS_DEMO XODUS_DEMO_TOUR XODUS_DEMO_CAPTURE_DIR XODUS_SMOKE_SCREENSHOT\nexec ${shellQuote(launcher)} --nexus-profile ${shellQuote(this.locations.userData)}${game ? ' --launch-game' : ''} "$@"\n`;
    await this.write(entry, body(true), 0o700, `# ${this.marker}`);
    const nexusEntry = path.join(directory, 'launch-nexus');
    await this.write(nexusEntry, body(false), 0o700, `# ${this.marker}`);
    const icon = path.join(directory, 'nexus.png');
    await this.write(icon, await fs.readFile(this.locations.icon), 0o600);
    this.entry = entry; this.icon = icon; this.nexusEntry = nexusEntry;
  }
  private legacyFilename(id: string): string {
    if (!validId(id)) throw new Error('Invalid game shortcut ID.');
    return `xodus-nexus-${this.profileId}-${id}.desktop`;
  }
  private gameMarker(id: string): string { return `X-Xodus-Nexus-Game=${id}`; }
  private async owns(file: string, id: string): Promise<boolean> {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) || stat.size > 128 * 1024) return false;
      const lines = (await fs.readFile(file, 'utf8')).split('\n');
      return lines.includes(this.marker) && (lines.includes(this.gameMarker(id)) || path.basename(file) === this.legacyFilename(id));
    } catch (error) { if (['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return false; throw error; }
  }
  private async ownedFiles(directory: string, id: string): Promise<string[]> {
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw Error('Unsafe shortcut directory.');
      const files: string[] = [];
      for (const name of await fs.readdir(directory)) {
        const file = path.join(directory, name);
        if (name.endsWith('.desktop') && await this.owns(file, id)) files.push(file);
      }
      return files;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  private async writeEntry(directory: string, stem: string, id: string, body: string, mode: number): Promise<string> {
    const temporary = path.join(directory, `.nexus-${randomUUID()}`);
    await fs.writeFile(temporary, body, { flag: 'wx', mode });
    try {
      for (let index = 0; index < 100; index++) {
        const suffix = index === 0 ? '' : index === 1 ? ` (${id.slice(0, 8)})` : ` (${id.slice(0, 8)}-${this.profileId.slice(0, 6)}${index > 2 ? `-${index}` : ''})`;
        const target = path.join(directory, `${stem}${suffix}.desktop`);
        try {
          // Atomic no-clobber publication, even when two games share a title.
          await fs.link(temporary, target);
          return target;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if (!await this.owns(target, id)) continue;
          await this.write(target, body, mode, [this.marker, this.gameMarker(id)]);
          return target;
        }
      }
      throw Error('No free shortcut filename could be found for this game.');
    } finally { await fs.rm(temporary, { force: true }); }
  }
  private async gameIcon(id: string, png?: Buffer): Promise<string> {
    const iconDirectory = path.join(this.locations.userData, 'shortcuts', 'icons');
    const gameIcon = path.join(iconDirectory, `${id}.png`);
    let icon = this.icon!;
    if (png?.length && png.length <= 4 * 1024 * 1024 && png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
      await this.directory(iconDirectory);
      await this.write(gameIcon, png, 0o600);
      icon = gameIcon;
    } else {
      try {
        const stat = await fs.lstat(gameIcon);
        if (stat.isFile() && stat.uid === process.getuid?.() && !(stat.mode & 0o022) && stat.size <= 4 * 1024 * 1024 &&
            (await fs.readFile(gameIcon)).subarray(0, 8).toString('hex') === '89504e470d0a1a0a') icon = gameIcon;
      } catch { /* No cached artwork, keep the Nexus fallback. */ }
    }
    return icon;
  }
  async steamLaunch(game?: Pick<Game, 'id' | 'title' | 'installState'>, png?: Buffer): Promise<SteamLaunch> {
    if (!this.entry || !this.icon || !this.nexusEntry) throw new Error(this.reason);
    if (game && (game.installState !== 'ready' || !validId(game.id))) throw Error('Only installed, ready games can be added to Steam.');
    const entry = game ? this.entry : this.nexusEntry;
    return { title: game ? game.title.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 256) || 'Xodus Nexus game' : 'Xodus Nexus',
      executable: steamArgument('/bin/sh'), options: steamArgument(entry) + (game ? ' ' + steamArgument(game.id) : ''),
      directory: path.dirname(entry), identity: this.profileId + ':' + (game?.id ?? 'launcher'),
      icon: game ? await this.gameIcon(game.id, png) : this.icon };
  }
  async steamDesktop(game?: Pick<Game, 'id' | 'title' | 'installState'>, png?: Buffer): Promise<{ launch: SteamLaunch; file: string }> {
    const launch = await this.steamLaunch(game, png);
    const directory = path.join(this.locations.userData, 'shortcuts', 'steam');
    await this.directory(directory);
    const file = path.join(directory, `${game?.id ?? 'launcher'}.desktop`);
    const identity = `X-Xodus-Nexus-Steam=${game?.id ?? 'launcher'}`;
    const entry = game ? this.entry! : this.nexusEntry!;
    const body = `[Desktop Entry]\nType=Application\nName=${desktopValue(launch.title)}\nExec=/bin/sh ${desktopArgument(entry)}${game ? ' ' + desktopArgument(game.id) : ''}\nPath=${desktopValue(launch.directory)}\nIcon=${desktopValue(launch.icon)}\nTerminal=false\nCategories=Game;\n${this.marker}\n${identity}\n`;
    await this.write(file, body, 0o600, [this.marker, identity]);
    return { launch, file };
  }
  async create(game: Pick<Game, 'id' | 'title' | 'installState'>, destination: ShortcutDestination, png?: Buffer): Promise<string> {
    if (!this.entry || !this.icon) throw new Error(this.reason);
    if (destination !== 'desktop' && destination !== 'applications') throw new Error('Invalid shortcut destination.');
    if (game.installState !== 'ready') throw new Error('Only installed, ready games can have launch shortcuts.');
    if (!validId(game.id)) throw new Error('Invalid game shortcut ID.');
    const directory = this.locations[destination];
    await this.directory(directory);
    const icon = await this.gameIcon(game.id, png);
    const title = game.title.replace(/[\0\r\n\t]/g, ' ').trim() || 'Xodus Nexus game';
    // Keep the executable field constant: desktop loaders may check it before
    // expanding %% in arguments. /bin/sh runs a file, never a shell -c string.
    const body = `[Desktop Entry]\nType=Application\nVersion=1.0\nName=${desktopValue(title)}\nComment=Play with Xodus Nexus\nExec=/bin/sh ${desktopArgument(this.entry)} ${desktopArgument(game.id)}\nIcon=${desktopValue(icon)}\nTerminal=false\nCategories=Game;\nStartupNotify=false\n${this.marker}\n${this.gameMarker(game.id)}\n`;
    const target = await this.writeEntry(directory, shortcutTitleStem(title), game.id, body, destination === 'desktop' ? 0o755 : 0o644);
    // Migrate only this game's managed entries, after the replacement is safe.
    const windowEntry = path.join(this.locations.applications, `xodus-nexus-game-${this.profileId}-${game.id}.desktop`);
    for (const old of await this.ownedFiles(directory, game.id)) if (old !== target && old !== windowEntry && await this.owns(old, game.id)) await fs.unlink(old);
    return target;
  }
  async windowIdentity(game: Pick<Game, 'id' | 'title' | 'installState'>, png?: Buffer): Promise<string> {
    if (!this.entry || !this.icon) throw new Error(this.reason);
    if (game.installState !== 'ready' || !validId(game.id)) throw new Error('Invalid game window identity.');
    const identity = `xodus-nexus-game-${this.profileId}-${game.id}`;
    const icon = await this.gameIcon(game.id, png);
    await this.directory(this.locations.applications);
    const title = game.title.replace(/[\0\r\n\t]/g, ' ').trim() || 'Xodus Nexus game';
    const body = `[Desktop Entry]\nType=Application\nName=${desktopValue(title)}\nExec=/bin/sh ${desktopArgument(this.entry)} ${desktopArgument(game.id)}\nIcon=${desktopValue(icon)}\nTerminal=false\nNoDisplay=true\nStartupNotify=false\nStartupWMClass=${identity}\nCategories=Game;\n${this.marker}\n${this.gameMarker(game.id)}\n`;
    await this.write(path.join(this.locations.applications, `${identity}.desktop`), body, 0o644,
      [this.marker, this.gameMarker(game.id)]);
    return identity;
  }
  async remove(id: string): Promise<void> {
    if (!validId(id)) throw new Error('Invalid game shortcut ID.');
    for (const directory of [this.locations.desktop, this.locations.applications]) {
      for (const target of await this.ownedFiles(directory, id)) if (await this.owns(target, id)) await fs.unlink(target);
    }
  }
}
