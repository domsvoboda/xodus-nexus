import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { liveSteamShortcut } from './steam-client.js';
import { planSteamShortcut, type SteamLaunch } from './steam-shortcuts.js';

const launch: SteamLaunch = { title: 'A "quoted" game', executable: '"/bin/sh"', options: '"/home/me/launch-game" "0123456789abcdef" %command%',
  directory: '/home/me/shortcuts', identity: 'profile:0123456789abcdef', icon: '/home/me/icon.png' };
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('art')]);

// Stands in for Steam: answers each expression in turn and records them.
function fakeSteam(answers: unknown[]) {
  const expressions: string[] = [];
  return { expressions, evaluate: async (expression: string) => { expressions.push(expression); return answers.shift(); } };
}

describe('live Steam shortcuts', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-live-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('adds a new shortcut with its name, Steam command, tool and artwork', async () => {
    const steam = fakeSteam(['[]', 4000000123]);
    expect(await liveSteamShortcut(steam, [root], launch, '/bin/sh', { cover: png, wide: Buffer.from('not a png') }, 'xodus-nexus'))
      .toEqual({ appid: 4000000123, added: true });
    const [lookup, add, setup, ...art] = steam.expressions;
    expect(lookup).toContain('[]');
    expect(add).toBe(`SteamClient.Apps.AddShortcut(${JSON.stringify(launch.title)}, "/bin/sh", '', '')`);
    // Every value reaches Steam JSON-encoded.
    expect(setup).toContain(`SetShortcutName(appid, ${JSON.stringify(launch.title)})`);
    expect(setup).toContain(`SetShortcutStartDir(appid, ${JSON.stringify('"/home/me/shortcuts"')})`);
    expect(setup).toContain(`SetShortcutLaunchOptions(appid, ${JSON.stringify(launch.options)})`);
    expect(setup).toContain('if (!details?.strCompatToolName) await SteamClient.Apps.SpecifyCompatTool(appid, "xodus-nexus")');
    // Only real PNGs; the invalid wide image falls back to nothing, the cover goes to capsule only.
    expect(art).toHaveLength(1);
    expect(art[0]).toContain(`SetCustomArtworkForApp(4000000123, "${png.toString('base64')}", 'png', 0)`);
  });

  // shortcuts.vdf reads check Linux file ownership.
  it.skipIf(process.platform !== 'linux')('upgrades an existing shortcut in place without touching its name, artwork or tool choice', async () => {
    const existing = planSteamShortcut(undefined, { ...launch, options: '"/home/me/launch-game" "0123456789abcdef"' });
    await fs.writeFile(path.join(root, 'shortcuts.vdf'), existing.bytes);
    const steam = fakeSteam([JSON.stringify([existing.appid])]);
    expect(await liveSteamShortcut(steam, [root], launch, '/bin/sh', { cover: png }, undefined)).toEqual({ appid: existing.appid, added: false });
    expect(steam.expressions).toHaveLength(2);
    expect(steam.expressions[0]).toContain(String(existing.appid));
    expect(steam.expressions[1]).toContain(`SetShortcutLaunchOptions(appid, ${JSON.stringify(launch.options)})`);
    expect(steam.expressions[1]).not.toMatch(/SetShortcutName|SpecifyCompatTool|SetCustomArtwork/);
  });

  it('refuses a relative executable and a failed add', async () => {
    await expect(liveSteamShortcut(fakeSteam([]), [root], launch, 'sh', {}, undefined)).rejects.toThrow('Invalid');
    await expect(liveSteamShortcut(fakeSteam(['[]', 0]), [root], launch, '/bin/sh', {}, undefined)).rejects.toThrow('did not create');
  });
});
