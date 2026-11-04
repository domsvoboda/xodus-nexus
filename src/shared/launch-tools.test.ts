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

it.each(['WINEPREFIX=/other', 'XODUS_SOCKET=/other', 'WINE_DLL_FILE_MAP=bad', 'STEAM_COMPAT_DATA_PATH=/other'])('protects managed identity/prefix settings: %s', value => {
  expect(() => parseLaunchOptions(value)).toThrow('managed by Nexus');
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
