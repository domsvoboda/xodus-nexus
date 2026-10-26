import path from 'node:path';
import { findSteamLaunches, readSteamShortcuts, steamArgument, type SteamLaunch } from './steam-shortcuts.js';

/**
 * A running Steam, through the CEF debugger its UI exposes on 127.0.0.1:8080
 * when remote debugging is on (SteamOS with Decky, or Steam's
 * `.cef-enable-remote-debugging`). Steam's own SteamClient.Apps calls add and
 * change shortcuts live, where shortcuts.vdf can only be written with Steam
 * closed and Game Mode ignores steam://addnonsteamgame. Values only ever
 * reach Steam JSON-encoded.
 */
export class SteamClientLink {
  private next = 0;
  private readonly pending = new Map<number, (message: { result?: { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } } }) => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } } };
      if (message.id !== undefined) this.pending.get(message.id)?.(message);
    };
  }

  static async connect(port = 8080, timeoutMs = 1500): Promise<SteamClientLink | undefined> {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(timeoutMs) });
      const targets = await response.json() as Array<{ title?: string; webSocketDebuggerUrl?: string }>;
      const url = targets.find(target => target.title === 'SharedJSContext')?.webSocketDebuggerUrl;
      // Only Steam's own local UI context, never a remote or redirected one.
      if (!url || !new RegExp(`^ws://(127\\.0\\.0\\.1|localhost):${port}/`).test(url)) return undefined;
      const socket = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        socket.onopen = () => { clearTimeout(timer); resolve(); };
        socket.onerror = () => { clearTimeout(timer); reject(new Error('Steam UI connection failed')); };
      });
      const link = new SteamClientLink(socket);
      if (await link.evaluate('typeof SteamClient?.Apps?.AddShortcut') !== 'function') { link.close(); return undefined; }
      return link;
    } catch { return undefined; }
  }

  evaluate(expression: string, timeoutMs = 15_000): Promise<unknown> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Steam did not answer in time.')); }, timeoutMs);
      this.pending.set(id, message => {
        clearTimeout(timer);
        this.pending.delete(id);
        const failure = message.result?.exceptionDetails?.exception?.description;
        if (failure) reject(new Error(`Steam rejected the request: ${failure.split('\n')[0]}`));
        else resolve(message.result?.result?.value);
      });
      this.socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  }

  close(): void { this.socket.close(); }
}

const json = (value: unknown) => JSON.stringify(value);
/** Steam's details feed for one app, as the first callback reports them. */
const detailsOf = (appid: number) => `new Promise((resolve) => {
  let registration;
  const timer = setTimeout(() => { registration?.unregister(); resolve(undefined); }, 8000);
  registration = SteamClient.Apps.RegisterForAppDetails(${json(appid)}, (value) => { clearTimeout(timer); registration.unregister(); resolve(value); });
})`;

export interface LiveShortcut { appid: number; added: boolean }

/**
 * Adds a Nexus shortcut to the running Steam, or brings an existing one (any
 * older launch-options form) up to date. The compatibility tool is selected
 * only when the shortcut has no choice yet, so a player's Proton stays.
 */
export async function liveSteamShortcut(link: Pick<SteamClientLink, 'evaluate'>, configs: string[], launch: SteamLaunch, executable: string,
  artwork: { cover?: Buffer; wide?: Buffer }, tool?: string): Promise<LiveShortcut> {
  if (!path.isAbsolute(executable) || /[\0\r\n]/.test(executable)) throw new Error('Invalid shortcut executable.');
  const known = new Set<number>();
  for (const config of configs) {
    const bytes = await readSteamShortcuts(path.join(config, 'shortcuts.vdf')).catch(() => undefined);
    for (const appid of bytes ? findSteamLaunches(bytes, launch) : []) known.add(appid);
  }
  // shortcuts.vdf may hold several profiles; only the signed-in one is live.
  const live = await link.evaluate(`JSON.stringify(${json([...known])}.filter((id) => appStore.allApps.some((app) => app.appid === id)))`);
  const existing = (JSON.parse(String(live ?? '[]')) as number[])[0];
  const appid = existing ?? Number(await link.evaluate(`SteamClient.Apps.AddShortcut(${json(launch.title)}, ${json(executable)}, '', '')`));
  if (!Number.isInteger(appid) || appid <= 0) throw new Error('Steam did not create the shortcut.');
  await link.evaluate(`(async () => {
    const appid = ${json(appid)};
    ${existing === undefined ? `SteamClient.Apps.SetShortcutName(appid, ${json(launch.title)});
    SteamClient.Apps.SetShortcutStartDir(appid, ${json(steamArgument(launch.directory))});
    SteamClient.Apps.SetShortcutIcon(appid, ${json(launch.icon)});` : ''}
    SteamClient.Apps.SetShortcutLaunchOptions(appid, ${json(launch.options)});
    ${tool ? `const details = await ${detailsOf(appid)};
    if (!details?.strCompatToolName) await SteamClient.Apps.SpecifyCompatTool(appid, ${json(tool)});` : ''}
  })()`);
  // Custom artwork only for a new shortcut: never replace what the player set.
  if (existing === undefined) {
    for (const [asset, bytes] of [[0, artwork.cover], [3, artwork.wide ?? artwork.cover], [1, artwork.wide ?? artwork.cover]] as const) {
      if (bytes?.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && bytes.length <= 4 * 1024 * 1024) {
        await link.evaluate(`SteamClient.Apps.SetCustomArtworkForApp(${json(appid)}, ${json(bytes.toString('base64'))}, 'png', ${asset})`);
      }
    }
  }
  return { appid, added: existing === undefined };
}
