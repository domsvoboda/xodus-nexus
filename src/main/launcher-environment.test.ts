import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {externalLauncherEnvironment, launcherSteamImeActive, nativeDialogsAvailable} from './launcher-environment.js';
import { configureLauncherFonts } from './launcher-fonts.js';
import { spawnTracked } from './process.js';
import { prepareGameWrapper } from './game-wrapper.js';
import { defaultLaunchTools } from '../shared/launch-tools.js';

const session = { XDG_CURRENT_DESKTOP: 'gamescope', GTK_IM_MODULE: 'simple',
  XODUS_NEXUS_STEAM_IME: '1', QT_IM_MODULE: 'steam', SteamGameId: '123', DISPLAY: ':1' };
let root: string | undefined;
let fonts: ReturnType<typeof configureLauncherFonts> | undefined;
afterEach(() => {
  fonts?.dispose(); fonts = undefined;
  if (root) rmSync(root, { recursive: true, force: true }); root = undefined;
});

describe('launcher-only Steam input fallback', () => {
  it('restores original Steam IME for external processes without mutating the caller', () => {
    const environment = { ...session };
    expect(launcherSteamImeActive(environment, 'linux')).toBe(true);
    expect(externalLauncherEnvironment(environment, 'linux')).toEqual({
      XDG_CURRENT_DESKTOP: 'gamescope', GTK_IM_MODULE: 'Steam',
      QT_IM_MODULE: 'steam', SteamGameId: '123', DISPLAY: ':1',
    });
    expect(environment).toEqual(session);
  });

  it.each(['ibus', 'fcitx', 'Steam', '', undefined])
  ('preserves an explicit subprocess IME override: %j', ime => {
    expect(externalLauncherEnvironment({ ...session, GTK_IM_MODULE: ime }, 'linux').GTK_IM_MODULE).toBe(ime);
  });

  it('leaves controller, Proton, display and session settings byte-for-byte unchanged', () => {
    const environment = { ...session, PROTON_DISABLE_HIDRAW: '0x054c/0x0ce6',
      SDL_GAMECONTROLLERCONFIG: '03000000,Custom Xbox,a:b0,b:b1,',
      SDL_GAMECONTROLLER_IGNORE_DEVICES: '0x1234/0xabcd', WINEPREFIX: '/tmp/prefix with spaces',
      WAYLAND_DISPLAY: 'gamescope-0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' };
    const { XODUS_NEXUS_STEAM_IME: _marker, ...original } = environment;
    expect(externalLauncherEnvironment(environment, 'linux')).toEqual({ ...original, GTK_IM_MODULE: 'Steam' });
  });

  it.each([
    { ...session, XODUS_NEXUS_STEAM_IME: undefined },
    { ...session, XODUS_NEXUS_STEAM_IME: 'invalid' },
    { ...session, XDG_CURRENT_DESKTOP: 'KDE' },
    { ...session, XDG_CURRENT_DESKTOP: 'gamescope-nested' },
  ])('does not restore an unrelated simple IME: %j', environment => {
    expect(launcherSteamImeActive(environment, 'linux')).toBe(false);
    const external = externalLauncherEnvironment(environment, 'linux');
    expect(external.GTK_IM_MODULE).toBe('simple');
    expect(external.XODUS_NEXUS_STEAM_IME).toBeUndefined();
  });

  it.each(['win32', 'darwin'] as const)('does not apply the Linux fallback on %s', platform => {
    expect(launcherSteamImeActive(session, platform)).toBe(false);
    expect(externalLauncherEnvironment(session, platform).GTK_IM_MODULE).toBe('simple');
  });

  it('composes with fallback fonts and is idempotent for relaunch', () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'nexus-input-test-'));
    const environment: NodeJS.ProcessEnv = { ...session, FONTCONFIG_FILE: '/host/fonts.conf' };
    fonts = configureLauncherFonts(path.resolve('assets/fonts'), path.join(root, 'cache'), environment, root);
    const external = externalLauncherEnvironment(environment, 'linux');
    expect(external.FONTCONFIG_FILE).toBe('/host/fonts.conf');
    expect(external.GTK_IM_MODULE).toBe('Steam');
    expect(externalLauncherEnvironment(external, 'linux')).toEqual(external);
    expect(environment.GTK_IM_MODULE).toBe('simple');
    expect(environment.FONTCONFIG_FILE).not.toBe('/host/fonts.conf');
  });

  it('gives an actual tracked child the original input without the private marker', async () => {
    const script = `process.stdout.write(JSON.stringify({ime:process.env.GTK_IM_MODULE,
      marker:process.env.XODUS_NEXUS_STEAM_IME, qt:process.env.QT_IM_MODULE,
      steam:process.env.SteamGameId, display:process.env.DISPLAY}))`;
    const result = await spawnTracked(process.execPath, ['-e', script], { env: { ...process.env, ...session } }).result;
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toEqual({ ime: 'Steam', qt: 'steam', steam: '123', display: ':1' });
  });

  it('keeps per-game input overrides in the actual generated wrapper', async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'nexus-input-test-'));
    const wrapper = await prepareGameWrapper(process.execPath,
      { ...defaultLaunchTools, launchOptions: 'GTK_IM_MODULE=ibus %command%' }, root);
    try {
      const result = await spawnTracked(wrapper.command, ['-e', 'process.stdout.write(process.env.GTK_IM_MODULE)'],
        { env: { ...process.env, ...session } }).result;
      expect(result.code).toBe(0);
      expect(result.output).toBe('ibus');
    } finally { await wrapper.cleanup(); }
  });
});

describe('native file dialogs', () => {
  it('are refused under gamescope and allowed on desktops', () => {
    expect(nativeDialogsAvailable({ XDG_CURRENT_DESKTOP: 'gamescope' })).toBe(false);
    expect(nativeDialogsAvailable({ XDG_CURRENT_DESKTOP: 'KDE:gamescope' })).toBe(false);
    expect(nativeDialogsAvailable({ XDG_CURRENT_DESKTOP: 'KDE' })).toBe(true);
    expect(nativeDialogsAvailable({})).toBe(true);
  });
});
