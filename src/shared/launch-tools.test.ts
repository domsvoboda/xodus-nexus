import { expect, it } from 'vitest';
import { commandWords, defaultLaunchTools, normalizeLaunchTools, parseLaunchOptions } from './launch-tools.js';

it('parses Steam-style environment, wrapper and trailing game arguments without shell evaluation', () => {
  expect(parseLaunchOptions('WINEDLLOVERRIDES="dxgi=n,b;winhttp=b" PROTON_ENABLE_WAYLAND=1 gamemoderun %command% --launcher-skip "two words"')).toEqual({
    environment: { WINEDLLOVERRIDES: 'dxgi=n,b;winhttp=b', PROTON_ENABLE_WAYLAND: '1' }, prefix: ['gamemoderun'], gameArgs: ['--launcher-skip', 'two words'],
  });
  expect(parseLaunchOptions('DXVK_HUD=')).toEqual({environment:{DXVK_HUD:''},prefix:[],gameArgs:[]});
  expect(commandWords('"/a path/it\'s tool" "literal $HOME" ""')).toEqual(["/a path/it's tool", 'literal $HOME', '']);
});

it.each(['mangohud %command% %command%', 'a%command%', 'bad "quote', 'bad\\', 'x && y', '$(touch bad)', 'x\ny', 'x\0y', 'x'.repeat(2049)])('rejects invalid or shell-based launch options: %s', value => {
  expect(() => parseLaunchOptions(value)).toThrow();
});

it.each(['WINEPREFIX=/other', 'XODUS_SOCKET=/other', 'WINE_DLL_FILE_MAP=bad', 'STEAM_COMPAT_DATA_PATH=/other',
  'STEAM_COMPAT_CONFIGX=1', 'STEAM_COMPAT_CONFIG_EXTRA=1', 'STEAM_COMPAT_INSTALL_PATH=/other',
  'STEAM_COMPAT_LIBRARY_PATHS=/other', 'STEAM_COMPAT_SHADER_PATH=/other', 'STEAM_COMPAT_APP_ID=1',
  'XODUS_ANYTHING=1'])('protects managed identity/prefix settings: %s', value => {
  expect(() => parseLaunchOptions(value)).toThrow('managed by Nexus');
});

it('keeps case variants as inert data because the managed names are exact', () => {
  // Linux environment names are case sensitive: Wine and Proton read the exact
  // upper-case names, so a different spelling cannot shadow them.
  expect(parseLaunchOptions('WinEPREFIX=/other %command%').environment).toEqual({ WinEPREFIX: '/other' });
  expect(parseLaunchOptions('steam_compat_data_path=/other %command%').environment).toEqual({ steam_compat_data_path: '/other' });
});

it('accepts the documented Proton compat-config channel as launch data', () => {
  // Proton reads this variable from its environment and only adds compat option
  // names to its own config set or appends data to its argv.
  expect(parseLaunchOptions('STEAM_COMPAT_CONFIG=wined3d %command%')).toEqual({
    environment: { STEAM_COMPAT_CONFIG: 'wined3d' }, prefix: [], gameArgs: [],
  });
  expect(parseLaunchOptions('STEAM_COMPAT_CONFIG="cmdlineappend:--flag value,wined3d,localshadercache" %command%')).toEqual({
    environment: { STEAM_COMPAT_CONFIG: 'cmdlineappend:--flag value,wined3d,localshadercache' }, prefix: [], gameArgs: [],
  });
  // An explicit empty, literal zero or whitespace-only value is data too: the
  // launcher never rewrites it, Proton applies its own nonzero rule.
  expect(parseLaunchOptions('STEAM_COMPAT_CONFIG= %command%').environment.STEAM_COMPAT_CONFIG).toBe('');
  expect(parseLaunchOptions('STEAM_COMPAT_CONFIG=0 %command%').environment.STEAM_COMPAT_CONFIG).toBe('0');
  expect(parseLaunchOptions('STEAM_COMPAT_CONFIG=" " %command%').environment.STEAM_COMPAT_CONFIG).toBe(' ');
  // Shell-looking characters stay literal inside a quoted assignment.
  expect(parseLaunchOptions('STEAM_COMPAT_CONFIG="cmdlineappend:$(touch /tmp/x) `id`;a" %command%').environment.STEAM_COMPAT_CONFIG)
    .toBe('cmdlineappend:$(touch /tmp/x) `id`;a');
  // A space before the equals sign is not an assignment and never becomes one.
  expect(parseLaunchOptions('STEAM_COMPAT_CONFIG =wined3d %command%').prefix).toEqual(['STEAM_COMPAT_CONFIG', '=wined3d']);
});

it('validates persisted launch tool settings at the IPC boundary', () => {
  expect(normalizeLaunchTools(undefined)).toEqual(defaultLaunchTools);
  expect(() => normalizeLaunchTools({ ...defaultLaunchTools, mangoHud:'yes' })).toThrow();
  expect(() => normalizeLaunchTools({ ...defaultLaunchTools, dualSenseCompatibility:'yes' })).toThrow();
  expect(normalizeLaunchTools({ mangoHud:false, gamescope:false, gamescopeArgs:'', launchOptions:'' }).dualSenseCompatibility).toBe(false);
  expect(normalizeLaunchTools({ ...defaultLaunchTools, dualSenseCompatibility:true }).dualSenseCompatibility).toBe(true);
  expect(() => normalizeLaunchTools({ ...defaultLaunchTools, gamescopeArgs:'-f --' })).toThrow();
  expect(normalizeLaunchTools({ ...defaultLaunchTools, launchOptions:' PROTON_ENABLE_WAYLAND=1 %command% ' }).launchOptions).toBe('PROTON_ENABLE_WAYLAND=1 %command%');
});


it('keeps older controller settings intact and validates the optional DualShock 4 mode',()=>{
  expect(normalizeLaunchTools({...defaultLaunchTools,dualShock4Compatibility:true}).dualShock4Compatibility).toBe(true);
  expect(normalizeLaunchTools({...defaultLaunchTools,dualShock4Compatibility:false}).dualShock4Compatibility).toBe(false);
  expect(normalizeLaunchTools(defaultLaunchTools).dualShock4Compatibility).toBeUndefined();
  expect(()=>normalizeLaunchTools({...defaultLaunchTools,dualShock4Compatibility:'yes'})).toThrow('DualShock 4');
});

it('places the Proton optional component options before %command% as plain environment assignments', () => {
  // The exact form a Proton user writes for CachyOS OptiScaler: environment
  // assignments, %command% as its own word, and nothing after it.
  expect(parseLaunchOptions('PROTON_USE_OPTISCALER=1 %command%')).toEqual({
    environment: { PROTON_USE_OPTISCALER: '1' }, prefix: [], gameArgs: [],
  });
  // The assignment is only accepted before %command%; a bare argument keeps its
  // position as a game argument instead of silently becoming an environment entry.
  expect(parseLaunchOptions('%command% PROTON_USE_OPTISCALER=1')).toEqual({
    environment: {}, prefix: [], gameArgs: ['PROTON_USE_OPTISCALER=1'],
  });
  expect(normalizeLaunchTools({ ...defaultLaunchTools, launchOptions: ' PROTON_USE_OPTISCALER=1 %command% ' }).launchOptions)
    .toBe('PROTON_USE_OPTISCALER=1 %command%');
});
