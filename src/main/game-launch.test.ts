import { describe, expect, it } from 'vitest';
import { gameLaunchArguments, launchEnvironmentForRuntime, preparedGameWine } from './game-launch.js';
import { LINUX_RUN_PATCH } from './backend.js';

describe('generic package launch', () => {
  it('keeps the prepared Proton prefix runner when no launch tools are enabled', () => {
    const wine = preparedGameWine({ command: '/compat/pfx-runner' }, '/runtime/wine');
    expect(gameLaunchArguments({ path: '/package', executable: 'Dungeons.exe' }, wine, '', LINUX_RUN_PATCH)[2])
      .toBe('/compat/pfx-runner');
  });
  it('uses the prepared game runner for tools and the configured wrapper without Proton', () => {
    expect(preparedGameWine({ command: '/compat/pfx-runner', launchCommand: '/compat/game-runner' }, '/tools/wrapper'))
      .toBe('/compat/game-runner');
    expect(preparedGameWine(undefined, '/tools/wrapper')).toBe('/tools/wrapper');
  });
  it.each(['start_protected_game.exe', 'Dungeons.exe', 'FSD/Binaries/WinGDK/Shipping.exe', 'Game.exe'])(
    'uses the manifest entry and the same launch policy for %s', (executable) => {
      const args = gameLaunchArguments({ path: '/package', executable }, '/runtime/wine', 'US', LINUX_RUN_PATCH);
      expect(args).toEqual(['run', '/package', '/runtime/wine', '--exe', executable, '--materialize-chain', '--market', 'US']);
      expect(args).not.toContain('--materialize-exe');
    },
  );
  it('does not let EAC metadata, title or legacy profile fields override the manifest', () => {
    const game = { path: '/package', executable: 'Launcher.exe', title: 'Any title',
      antiCheat: { executable: 'HiddenGame.exe' }, launchSupport: 'offline-only-eac', winePath: '/old/per-game/wine' };
    expect(gameLaunchArguments(game, '/shared/wine', '', LINUX_RUN_PATCH))
      .toEqual(['run', '/package', '/shared/wine', '--exe', 'Launcher.exe', '--materialize-chain']);
  });
  it('passes the offline license cache only when the launcher provides one', () => {
    expect(gameLaunchArguments({ path: '/package', executable: 'Game.exe' }, '/wine', 'US', LINUX_RUN_PATCH, '/data/license-cache'))
      .toEqual(['run', '/package', '/wine', '--exe', 'Game.exe', '--materialize-chain', '--market', 'US', '--license-cache', '/data/license-cache']);
    for (const cache of [undefined, '']) {
      expect(gameLaunchArguments({ path: '/package', executable: 'Game.exe' }, '/wine', '', LINUX_RUN_PATCH, cache)).not.toContain('--license-cache');
    }
  });
  it('requests an offline launch only when the launcher decided Microsoft is unreachable', () => {
    expect(gameLaunchArguments({ path: '/package', executable: 'Game.exe' }, '/wine', 'US', LINUX_RUN_PATCH, '/data/license-cache', true))
      .toEqual(['run', '/package', '/wine', '--exe', 'Game.exe', '--materialize-chain', '--market', 'US', '--license-cache', '/data/license-cache', '--offline']);
    expect(gameLaunchArguments({ path: '/package', executable: 'Game.exe' }, '/wine', 'US', LINUX_RUN_PATCH, '/data/license-cache', false)).not.toContain('--offline');
    expect(gameLaunchArguments({ path: '/package', executable: 'Game.exe' }, '/wine', 'US', LINUX_RUN_PATCH, '/data/license-cache')).not.toContain('--offline');
  });
  it('fails closed on an old backend or a missing manifest entry', () => {
    expect(() => gameLaunchArguments({ path: '/package', executable: 'Game.exe' }, '/wine', '', 'old')).toThrow('Update the backend');
    expect(() => gameLaunchArguments({ path: '/package' }, '/wine', '', LINUX_RUN_PATCH)).toThrow('manifest has no launch executable');
  });
});

describe('runtime launch environment', () => {
  it('replaces inherited Proton-only settings for a Proton session and leaves a standalone Wine alone', () => {
    // A shell leftover must not replace the runtime's own values when Proton runs.
    expect(launchEnvironmentForRuntime(
      { WINEDLLOVERRIDES: 'dxgi=b', WINE_LARGE_ADDRESS_AWARE: '0', KEEP: '1' }, true))
      .toEqual({ KEEP: '1' });
    // A standalone custom Wine keeps exactly the environment it has always received.
    const standalone = { WINEDLLOVERRIDES: 'dxgi=b', WINE_LARGE_ADDRESS_AWARE: '0', KEEP: '1' };
    expect(launchEnvironmentForRuntime(standalone, false)).toBe(standalone);
    expect(standalone).toEqual({ WINEDLLOVERRIDES: 'dxgi=b', WINE_LARGE_ADDRESS_AWARE: '0', KEEP: '1' });
  });
  it('leaves launch-option precedence to the wrapper above the runtime command', () => {
    // The wrapper applies the game's launch options after this environment, so the
    // user's WINEDLLOVERRIDES still wins for Play (covered in proton.test.ts).
    const environment = launchEnvironmentForRuntime({ WINEDLLOVERRIDES: 'dxgi=b' }, true);
    expect(environment.WINEDLLOVERRIDES).toBeUndefined();
  });
});
