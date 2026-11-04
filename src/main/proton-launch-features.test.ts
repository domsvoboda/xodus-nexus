import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { protonLaunchFeatureNotices } from './proton.js';
import { acceptSteamHandoff, captureSteamLaunchEnvironment, offerSteamHandoff, steamGameEnvironment, steamHandoffRequest } from './steam-launch-context.js';

const created: string[] = [];
const offers: { close(): void }[] = [];
const leases: { close(): void }[] = [];

afterEach(async () => {
  for (const lease of leases.splice(0)) lease.close();
  for (const offer of offers.splice(0)) offer.close();
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/**
 * A runtime root is the only thing these notices inspect. Neither family is
 * emulated beyond the reviewed capability files: protonfixes for the CachyOS
 * feature set and the native Discord bridge payload.
 */
async function runtime(options: { protonfixes?: boolean; discordBridge?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'nexus-proton-features-')); created.push(root);
  if (options.protonfixes) {
    await mkdir(path.join(root, 'protonfixes'), { recursive: true });
    await writeFile(path.join(root, 'protonfixes', 'utilities.py'), 'fixture');
  }
  if (options.discordBridge) {
    await mkdir(path.join(root, 'files', 'lib', 'wine', 'discord-rpc-bridge'), { recursive: true });
    await writeFile(path.join(root, 'files', 'lib', 'wine', 'discord-rpc-bridge', 'bridge.exe'), 'fixture');
  }
  return root;
}

/** A notice must never claim that a feature Nexus cannot serve is working. */
function expectNoPositiveClaim(notices: string[]): void {
  for (const notice of notices) expect(notice).not.toMatch(/is active|has been started|will be started|is enabled/i);
}

describe('protonLaunchFeatureNotices', () => {
  it.each([undefined, '', '0'])('stays silent for an unrequested option (%j)', async (value) => {
    const root = await runtime();
    const environment = {
      PROTON_DISCORD_BRIDGE: value, PROTON_LOCAL_SHADER_CACHE: value, PROTON_LOG: value, PROTON_SET_GAME_DRIVE: value,
    } as Record<string, string | undefined>;
    expect(await protonLaunchFeatureNotices(environment, root)).toEqual([]);
  });

  it('reports unsupported context-dependent options of a runtime without them', async () => {
    const root = await runtime();
    const notices = await protonLaunchFeatureNotices({
      PROTON_LOCAL_SHADER_CACHE: '1', PROTON_DISCORD_BRIDGE: '1', PROTON_LOG: '1', PROTON_SET_GAME_DRIVE: '1',
    }, root);
    expect(notices).toHaveLength(4);
    expect(notices[0]).toContain('does not include the Discord RPC bridge');
    expect(notices[0]).toContain('no effect');
    expect(notices[1]).toContain('PROTON_LOCAL_SHADER_CACHE');
    expect(notices[1]).toContain('does not implement it');
    expect(notices[2]).toContain('Steam game id');
    expect(notices[2]).toContain('Wine and DXVK logging');
    expect(notices[3]).toContain('S: game drive');
    expect(notices[3]).toContain('Steam library');
    expect(notices[3]).toContain('does not fabricate one');
    expectNoPositiveClaim(notices);
  });

  // The S: drive is created by Proton only from a real `steamapps` library, so
  // the notice follows the verified location context of this launch. A genuinely
  // mapped library must never be reported as inactive, and vice versa.
  const plainLocation = { installPath: '/games/Game' };
  const libraryLocation = { installPath: '/steam-library/steamapps/common/Game', libraryPaths: '/steam-library/steamapps' };

  it('warns about the S: game drive only when the launch has no verified Steam library', async () => {
    const root = await runtime();
    const environment = { PROTON_SET_GAME_DRIVE: '1' };
    // No captured location at all, and a captured plain Nexus install.
    for (const location of [undefined, plainLocation]) {
      const notices = await protonLaunchFeatureNotices(environment, root, location);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('not installed inside a verified Steam library');
      expect(notices[0]).toContain('S: game drive');
      expectNoPositiveClaim(notices);
    }
    // A real Steam library is mapped by Proton: no negative claim at all.
    expect(await protonLaunchFeatureNotices(environment, root, libraryLocation)).toEqual([]);
    // An explicit disabled request is not a request, with any location.
    for (const value of ['0', '']) {
      for (const location of [undefined, plainLocation, libraryLocation]) {
        expect(await protonLaunchFeatureNotices({ PROTON_SET_GAME_DRIVE: value }, root, location)).toEqual([]);
      }
    }
  });

  it.each([
    ['Standard', {}],
    ['CachyOS', { protonfixes: true, discordBridge: true }],
  ])('uses the verified location context for %s runtimes', async (_family, options) => {
    const root = await runtime(options);
    // Other requested options are independent of the location context.
    const requested = { PROTON_SET_GAME_DRIVE: '1', PROTON_LOG: '1' };
    const plain = await protonLaunchFeatureNotices(requested, root, plainLocation);
    expect(plain).toHaveLength(2);
    expect(plain[1]).toContain('not installed inside a verified Steam library');
    const mapped = await protonLaunchFeatureNotices(requested, root, libraryLocation);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toContain('PROTON_LOG');
    expect(mapped.join(' ')).not.toContain('S: game drive');
  });

  it('accepts the local shader cache when the runtime implements it and keeps the bridge inactive', async () => {
    const root = await runtime({ protonfixes: true, discordBridge: true });
    // The CachyOS feature set implements local shader caches through protonfixes.
    expect(await protonLaunchFeatureNotices({ PROTON_LOCAL_SHADER_CACHE: '1' }, root)).toEqual([]);
    // The bridge payload alone is not a running service: only the runtime's
    // umu/Steam helper starts it, and this launch path does not use that helper.
    const notices = await protonLaunchFeatureNotices({ PROTON_DISCORD_BRIDGE: '1' }, root);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('Discord RPC bridge is installed');
    expect(notices[0]).toContain('helper');
    expect(notices[0]).toContain('does not start the bridge');
    expect(notices[0]).toContain('inactive');
    // The reason is the direct Proton session launch, not a missing identity.
    expect(notices[0]).not.toContain('Steam game id');
    expectNoPositiveClaim(notices);
  });

  // Pinned setup_logging creates the Proton log file when the effective
  // environment carries a Steam game id (key presence, not the value). The
  // notice must follow that and never claim the launch has no id when a genuine
  // Steam shortcut handoff forwarded one.
  it('reports PROTON_LOG only when the effective environment has no Steam game id', async () => {
    const root = await runtime();
    for (const steamGameId of ['16968485195965530112', '0', '']) {
      const forwarded = steamGameEnvironment({ HOME: '/home/test' }, { SteamGameId: steamGameId });
      expect(forwarded.SteamGameId).toBe(steamGameId);
      expect(await protonLaunchFeatureNotices({ ...forwarded, PROTON_LOG: '1' }, root)).toEqual([]);
    }
    // Ambient presence satisfies the pinned check exactly like a handoff does.
    expect(await protonLaunchFeatureNotices({ SteamGameId: '123', PROTON_LOG: '1' }, root)).toEqual([]);
    const notices = await protonLaunchFeatureNotices({ PROTON_LOG: '1' }, root);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('Steam game id');
    expect(notices[0]).toContain('Wine and DXVK logging');
    // No log path or identifier leaks into the notice.
    expect(notices[0]).not.toContain('steam-');
    expect(notices[0]).not.toContain('16968485195965530112');
    // An explicit disabled value is not a request in either context.
    for (const value of ['0', '']) {
      for (const environment of [{}, { SteamGameId: '16968485195965530112' }]) {
        expect(await protonLaunchFeatureNotices({ ...environment, PROTON_LOG: value }, root)).toEqual([]);
      }
    }
  });

  it('honours a forwarded authenticated Steam shortcut environment in the notices', async () => {
    const root = await runtime({ protonfixes: true, discordBridge: true });
    const captured = captureSteamLaunchEnvironment({
      SteamGameId: '16968485195965530112',
      SteamAppId: '16968485195965530112',
      SDL_GAMECONTROLLERCONFIG: 'Xbox mapping',
    });
    expect(captured).toBeDefined();
    const offer = offerSteamHandoff(captured!, () => {});
    offers.push(offer);
    // The launcher receives the handoff as IPC data and authenticates its lease.
    const request = steamHandoffRequest(JSON.parse(JSON.stringify({ nexusSteam: offer.handoff })))!;
    const lease = await acceptSteamHandoff(request);
    leases.push(lease);
    expect(request.lease.token).toMatch(/^[a-f0-9]{64}$/);
    // A wrong lease token is still rejected, so this is the authenticated path.
    await expect(acceptSteamHandoff({ ...request, lease: { ...request.lease, token: '0'.repeat(64) } }))
      .rejects.toThrow();
    const forwarded = steamGameEnvironment({ HOME: '/home/test' }, captured);
    expect(forwarded.SteamGameId).toBe('16968485195965530112');
    expect(forwarded.SDL_GAMECONTROLLERCONFIG).toBe('Xbox mapping');
    const notices = await protonLaunchFeatureNotices({ ...forwarded, PROTON_LOG: '1', PROTON_DISCORD_BRIDGE: '1' }, root);
    // Logging works in this genuine Steam context, so no no-log claim appears.
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('PROTON_DISCORD_BRIDGE');
    expect(notices[0]).toContain('does not start the bridge');
    expect(notices.join(' ')).not.toContain('Steam game id');
  });

  it('follows Proton nonzero semantics for whitespace-only values', async () => {
    const root = await runtime();
    // Upstream only treats an empty or literal "0" value as disabled.
    expect(await protonLaunchFeatureNotices({ PROTON_DISCORD_BRIDGE: ' ' }, root)).toHaveLength(1);
    expect(await protonLaunchFeatureNotices({ PROTON_DISCORD_BRIDGE: '0' }, root)).toEqual([]);
  });

  it('does not throw or overclaim for a runtime that is not a Proton payload', async () => {
    const root = await runtime();
    const notices = await protonLaunchFeatureNotices({ PROTON_DISCORD_BRIDGE: '1' }, path.join(root, 'absent'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('no effect');
  });
});
