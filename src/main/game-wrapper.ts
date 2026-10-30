import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { commandWords, normalizeLaunchTools, parseLaunchOptions } from '../shared/launch-tools.js';
import type { GameLaunchTools } from '../shared/types.js';

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

async function executable(command: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  const candidates = command.includes('/') ? [path.resolve(cwd, command)] :
    (env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.resolve(cwd, dir, command));
  for (const file of candidates) {
    try { if ((await fs.stat(file)).isFile()) { await fs.access(file, constants.X_OK); return file; } }
    catch { /* Try the next PATH entry. */ }
  }
  throw Error(`Launch tool "${command}" was not found or is not executable. Install it or disable it in this game's settings.`);
}

export interface GameWrapper { command: string; cleanup(): Promise<void> }

/** Only wraps the game's Wine entry point. Auth, service, prefix setup and Stop stay outside. */
export async function prepareGameWrapper(wine: string, value: GameLaunchTools | undefined,
  root: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Promise<GameWrapper> {
  const tools = normalizeLaunchTools(value);
  const { prefix: custom, environment, gameArgs } = parseLaunchOptions(tools.launchOptions);
  if (tools.dualSenseCompatibility || tools.dualShock4Compatibility) {
    const disabled = environment.PROTON_DISABLE_HIDRAW ?? env.PROTON_DISABLE_HIDRAW ?? '';
    // Match Wine's DualShock 4 models (v1, v2 and wireless adapter), separately
    // from the existing DualSense option. SDL remains responsible for mapping.
    const required = [...(tools.dualSenseCompatibility ? ['0x054c/0x0ce6'] : []),
      ...(tools.dualShock4Compatibility ? ['0x054c/0x05c4','0x054c/0x09cc','0x054c/0x0ba0'] : [])];
    const current = disabled === '0' ? '' : disabled;
    const existing = new Set(current.toLowerCase().split(/[,\s]+/));
    environment.PROTON_DISABLE_HIDRAW = disabled === '1' ? disabled
      : [current,...required.filter(device=>!existing.has(device))].filter(Boolean).join(',');
  }
  if (!tools.mangoHud && !tools.gamescope && custom.length === 0 && !Object.keys(environment).length && !gameArgs.length) return { command: wine, cleanup: async () => {} };
  const words: string[] = [];
  if (Object.keys(environment).length) words.push(await executable('env', env, cwd), ...Object.entries(environment).map(([key, value]) => `${key}=${value}`));
  if (custom.length) {
    words.push(await executable(custom[0], env, cwd), ...custom.slice(1));
  }
  if (tools.gamescope) {
    words.push(await executable('gamescope', env, cwd), ...commandWords(tools.gamescopeArgs));
    if (tools.mangoHud) {
      await executable('mangoapp', env, cwd);
      words.push('--mangoapp');
    }
    words.push('--');
  } else if (tools.mangoHud) words.push(await executable('mangohud', env, cwd));
  words.push(wine);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(root, 'game-tools-'));
  const command = path.join(directory, 'wine-wrapper');
  const cleanup = () => fs.rm(directory, { recursive: true, force: true });
  try {
    await fs.writeFile(command, `#!/bin/sh\nexec ${words.map(quote).join(' ')} "$@" ${gameArgs.map(quote).join(' ')}\n`, { mode: 0o700, flag: 'wx' });
    return { command, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
