import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DownloadTask, Game, Settings } from '../shared/types.js';
import { downloadLimitKiB } from '../shared/download-bandwidth.js';
import {defaultXboxOverlay,xboxOverlaySettings,xboxOverlayPatch} from '../shared/xbox-overlay-settings.js';
import { DEFAULT_SHADER_CACHE_GIB, shaderCacheLimits } from '../shared/shader-cache.js';
import { interfaceLanguagePreference } from '../shared/interface-language.js';
import { resolvePackageFile } from './windows-path.js';
import { parsePackageXml, XmlNode } from './package-xml.js';
import { hasIncompleteUpdate, INCOMPLETE_UPDATE_MESSAGE } from './installation-state.js';
import { manifestAttr as attr, manifestText as text, manifestElements, manifestAttribute } from './manifest-xml.js';

interface PersistedState {
  games: Game[];
  downloads: DownloadTask[];
  settings: Settings;
}

const defaultDataRoot = path.join(os.homedir(), '.local', 'share', 'xodus-nexus');
const defaultSettings: Settings = {
  closeToTray: false,
  interfaceLanguage: 'system',
  installRoot: path.join(os.homedir(), 'Games', 'Xodus Nexus'),
  market: 'neutral',
  parallelDownloads: 4,
  downloadLimitMiB: 0,
  shaderCacheLimitGiB: DEFAULT_SHADER_CACHE_GIB,
  winePath: '',
  externalXodusRoot: '',
  runtimeRoot: path.join(defaultDataRoot, 'runtimes'),
  verboseLogs: false,
  ...defaultXboxOverlay,
};

export class StateStore {
  private writes: Promise<void> = Promise.resolve();
  private state: PersistedState = { games: [], downloads: [], settings: defaultSettings };
  private readonly file: string;

  constructor(userData: string) {
    this.file = path.join(userData, 'launcher-state.json');
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<PersistedState>;
      let downloadLimitMiB = 0;
      try { downloadLimitKiB(parsed.settings?.downloadLimitMiB); downloadLimitMiB = parsed.settings?.downloadLimitMiB ?? 0; } catch { /* Ignore invalid saved preference; show the default in Settings. */ }
      let shaderCacheLimitGiB = DEFAULT_SHADER_CACHE_GIB;
      try { shaderCacheLimitGiB = shaderCacheLimits(parsed.settings?.shaderCacheLimitGiB).gib; } catch { /* Invalid legacy values use the finite default. */ }
      this.state = {
        games: Array.isArray(parsed.games) ? parsed.games.map((game) => {
          // Remove obsolete route/compatibility claims from existing profiles.
          const { launchSupport: _route, launchBlockReason: _reason, ...current } = game as Game & {
            launchSupport?: unknown; launchBlockReason?: unknown;
          };
          return current;
        }) : [],
        downloads: Array.isArray(parsed.downloads) ? parsed.downloads.map((task: DownloadTask) =>
          ['running', 'paused', 'queued'].includes(task.status) ? {
            ...task, status: 'paused' as const, canPause: true, controlPending: false,
            transferRate: undefined, phase: 'Paused — resume to reconnect and restore saved download checkpoints',
          } : task) : [],
        settings: Object.fromEntries(Object.entries({ ...defaultSettings, ...parsed.settings, ...xboxOverlaySettings(parsed.settings??{}), downloadLimitMiB, shaderCacheLimitGiB, closeToTray: parsed.settings?.closeToTray === true, interfaceLanguage: interfaceLanguagePreference(parsed.settings?.interfaceLanguage) }).filter(([key]) => key !== 'separateGameProcess')) as unknown as Settings,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('State could not be loaded', error);
    }
  }

  get games(): Game[] { return this.state.games; }
  get downloads(): DownloadTask[] { return this.state.downloads; }
  get settings(): Settings { return this.state.settings; }

  save(): Promise<void> {
    const data = JSON.stringify(this.state, null, 2);
    const write = this.writes.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      await fs.writeFile(temporary, data, { mode: 0o600 });
      await fs.rename(temporary, this.file);
    });
    this.writes = write.catch(() => {});
    return write;
  }

  async setSettings(patch: Partial<Settings>): Promise<Settings> {
    if (patch.closeToTray !== undefined && typeof patch.closeToTray !== 'boolean') throw Error('Invalid close-to-tray setting.');
    const overlay=xboxOverlayPatch(patch);patch={...patch,...overlay};
    if (patch.interfaceLanguage !== undefined && interfaceLanguagePreference(patch.interfaceLanguage) !== patch.interfaceLanguage) throw Error('Invalid interface language.');
    if (patch.downloadLimitMiB !== undefined) downloadLimitKiB(patch.downloadLimitMiB);
    if (patch.shaderCacheLimitGiB !== undefined) shaderCacheLimits(patch.shaderCacheLimitGiB);
    this.state.settings = { ...this.state.settings, ...patch };
    await this.save();
    return this.state.settings;
  }

  async upsertGame(game: Game): Promise<Game> {
    const index = this.state.games.findIndex((entry) => entry.id === game.id || entry.path === game.path);
    if (index >= 0) this.state.games[index] = { ...this.state.games[index], ...game };
    else this.state.games.unshift(game);
    await this.save();
    return game;
  }

  async patchGame(id: string, patch: Partial<Game>): Promise<Game> {
    const game = this.state.games.find((entry) => entry.id === id);
    if (!game) throw new Error('Game not found.');
    Object.assign(game, patch);
    await this.save();
    return game;
  }

  async removeGame(id: string): Promise<void> {
    this.state.games = this.state.games.filter((entry) => entry.id !== id);
    await this.save();
  }

  async addDownload(task: DownloadTask): Promise<void> {
    this.state.downloads.unshift(task);
    let finished = 0;
    this.state.downloads = this.state.downloads.filter(entry => ['running', 'queued', 'paused'].includes(entry.status) || finished++ < 30);
    await this.save();
  }

  async updateDownload(id: string, patch: Partial<DownloadTask>): Promise<void> {
    const task = this.state.downloads.find((entry) => entry.id === id);
    if (task) Object.assign(task, patch);
    await this.save();
  }

  async removeDownload(id: string): Promise<void> {
    const task = this.state.downloads.find((entry) => entry.id === id);
    if (!task) throw new Error('Queue entry not found.');
    if (task.status === 'running' || task.status === 'queued' || task.status === 'paused') throw new Error('Stop the installation before removing it from the queue.');
    this.state.downloads = this.state.downloads.filter((entry) => entry.id !== id);
    await this.save();
  }

  async clearFinishedDownloads(): Promise<void> {
    this.state.downloads = this.state.downloads.filter((entry) => entry.status === 'running' || entry.status === 'queued' || entry.status === 'paused');
    await this.save();
  }
}

async function readable(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

async function beginsWithMz(file: string): Promise<boolean> {
  try {
    const handle = await fs.open(file, 'r');
    try {
      const header = Buffer.alloc(2);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      return bytesRead === 2 && header[0] === 0x4d && header[1] === 0x5a;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

function getFirstValidConfigExecutable(configXml: XmlNode | undefined): string | undefined {
  if (!configXml) return;

  const configExecutables = manifestElements(configXml, "Executable")
  if (!configExecutables) return;

  for (const executable of configExecutables) {
    const isDevOnly = manifestAttribute(executable, "isDevOnly")
    const name = manifestAttribute(executable, "Name")
    if ( (isDevOnly !== undefined) && (isDevOnly === "false") && (name !== undefined)) {
      return name
    } else if ((isDevOnly === undefined) && (name !== undefined)) {
      return name
    }
  }
  return;
}

export async function inspectGameDirectory(directory: string): Promise<Game> {
  const canonical = await fs.realpath(directory);
  // GDK titles are authored on Windows, where the manifest name is
  // case-insensitive; some ship "MicrosoftGame.Config", which a case-sensitive
  // Linux filesystem does not find by the canonical name.
  const entries = await fs.readdir(canonical).catch(() => [] as string[]);
  const findEntry = (name: string) => entries.find((entry) => entry.toLowerCase() === name);
  const gameConfig = path.join(canonical, findEntry('microsoftgame.config') ?? 'MicrosoftGame.config');
  const appxManifest = path.join(canonical, findEntry('appxmanifest.xml') ?? 'appxmanifest.xml');
  const configSource = await fs.readFile(gameConfig, 'utf8').catch(() => '');
  const appxSource = await fs.readFile(appxManifest, 'utf8').catch(() => '');
  if (!configSource && !appxSource) {
    throw new Error('The selected directory does not contain MicrosoftGame.config or appxmanifest.xml.');
  }
  const configXml = configSource ? parsePackageXml(configSource) : undefined;
  const appxXml = appxSource ? parsePackageXml(appxSource) : undefined;

  const title = attr(configXml, 'ShellVisuals', 'DefaultDisplayName')
    ?? text(appxXml, 'DisplayName')
    ?? path.basename(canonical);
  const executable = getFirstValidConfigExecutable(configXml)
    ?? attr(appxXml, 'Application', 'Executable');

  const storeId = text(configXml, 'StoreId');
  const publisher = attr(configXml, 'ShellVisuals', 'PublisherDisplayName')
    ?? text(appxXml, 'PublisherDisplayName');
  const finalContainer = path.join(canonical, '.xodus-streaming.msixvc');
  const temporaryContainer = path.join(canonical, '.xodus-streaming-tmp.msixvc');
  const hasFinal = await readable(finalContainer);
  const hasTemporary = await readable(temporaryContainer);
  const exeExists = executable ? Boolean(await resolvePackageFile(canonical, executable)) : false;
  const vcRedistPath = path.join(canonical, 'Engine', 'Extras', 'Redist', 'en-us', 'vc_redist.x64.exe');
  const vcRedistEncrypted = [...manifestElements(configXml, 'KnownDependency')]
    .some(node => manifestAttribute(node, 'Name')?.toUpperCase() === 'VC14')
    && await readable(vcRedistPath) && !await beginsWithMz(vcRedistPath);
  let antiCheat: Game['antiCheat'];
  for (const eacDirectory of ['EasyAntiCheat', 'EasyAntiCheat_EOS']) {
    let settings: { executable?: unknown };
    try {
      settings = JSON.parse(await fs.readFile(path.join(canonical, eacDirectory, 'Settings.json'), 'utf8')) as { executable?: unknown };
    } catch { continue; }
    const eacExecutable = typeof settings.executable === 'string' && settings.executable.trim() ? settings.executable : undefined;
    const encryptedTarget = eacExecutable
      ? !await beginsWithMz(path.join(canonical, eacExecutable.replace(/\\/g, path.sep)))
      : false;
    antiCheat = { provider: 'Easy Anti-Cheat', executable: eacExecutable, encryptedTarget };
    break;
  }

  let coverDataUrl: string | undefined;
  const coverRelative = attr(configXml, 'ShellVisuals', 'Square480x480Logo')
    ?? attr(configXml, 'ShellVisuals', 'Square150x150Logo')
    ?? attr(appxXml, 'VisualElements', 'Square150x150Logo')
    ?? attr(appxXml, 'VisualElements', 'Square44x44Logo');
  if (coverRelative) {
    const cover = path.join(canonical, coverRelative.replace(/\\/g, path.sep));
    try {
      const buffer = await fs.readFile(cover);
      if (buffer.length < 3_000_000) coverDataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
    } catch { /* Artwork is optional. */ }
  }

  const updateIncomplete = await hasIncompleteUpdate(canonical);
  const installState = updateIncomplete ? 'incomplete' : hasFinal && exeExists ? 'ready' : hasTemporary ? 'incomplete' : 'imported';
  const installMessage = updateIncomplete ? INCOMPLETE_UPDATE_MESSAGE : installState === 'incomplete'
    ? 'A temporary Xodus container was found; the download was not completed.'
    : installState === 'imported' && !hasFinal
      ? 'The .xodus-streaming.msixvc container is missing; Xodus run may not work.'
      : installState === 'imported' && !exeExists
        ? 'The manifest executable is missing, ambiguous, or outside the installation directory.'
        : undefined;

  return {
    id: createHash('sha256').update(canonical).digest('hex').slice(0, 16),
    title,
    path: canonical,
    storeId,
    publisher,
    installedVersion: attr(configXml, 'Identity', 'Version') ?? attr(appxXml, 'Identity', 'Version'),
    packageName: attr(configXml, 'Identity', 'Name') ?? attr(appxXml, 'Identity', 'Name'),
    executable,
    coverDataUrl,
    installState,
    installMessage,
    updateIncomplete: updateIncomplete || undefined,
    vcRedistEncrypted,
    antiCheat,
    addedAt: new Date().toISOString(),
  };
}
