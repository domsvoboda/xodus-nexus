import type { GameLaunchTools } from './types.js';

export const defaultLaunchTools: GameLaunchTools = { dualSenseCompatibility: false, mangoHud: false, gamescope: false, gamescopeArgs: '', launchOptions: '' };

/** Command words only, never a shell program. Quotes group literal arguments. */
export function commandWords(input: string): string[] {
  if (input.length > 2048 || /[\r\n\0]/.test(input)) throw Error('Launch options must be a single line of at most 2048 characters.');
  const words: string[] = [];
  let word = '', quote = '', started = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '\\' && quote !== "'") {
      if (++i === input.length) throw Error('Launch options end with an incomplete escape.');
      word += input[i]; started = true;
    } else if (quote) {
      if (c === quote) quote = ''; else word += c;
    } else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (/\s/.test(c)) { if (started) { words.push(word); word = ''; started = false; } }
    else {
      if (/[|&;<>()`$]/.test(c)) throw Error('Shell operators and substitutions are not supported in launch options.');
      word += c; started = true;
    }
  }
  if (quote) throw Error('Launch options contain an unclosed quote.');
  if (started) words.push(word);
  return words;
}

export function parseLaunchOptions(input: string): { environment: Record<string, string>; prefix: string[]; gameArgs: string[] } {
  const words = commandWords(input);
  const marker = words.indexOf('%command%');
  if (words.some((word, index) => word.includes('%command%') && index !== marker)) throw Error('Use %command% only once, as a separate word.');
  const prefix = marker < 0 ? words : words.slice(0, marker);
  const environment: Record<string, string> = Object.create(null);
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(prefix[0] ?? '')) {
    const assignment = prefix.shift()!, equals = assignment.indexOf('=');
    const name = assignment.slice(0, equals);
    if (/^(?:WINEPREFIX|WINEARCH|WINE_DLL_FILE_MAP|XODUS_.*|STEAM_COMPAT_.*)$/.test(name)) throw Error(`${name} is managed by Nexus and cannot be overridden in launch options.`);
    environment[name] = assignment.slice(equals + 1);
  }
  return { environment, prefix, gameArgs: marker < 0 ? [] : words.slice(marker + 1) };
}

export function normalizeLaunchTools(value: unknown): GameLaunchTools {
  if (value === undefined) return { ...defaultLaunchTools };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid game launch tools.');
  const tools = value as Record<string, unknown>;
  if (typeof tools.mangoHud !== 'boolean' || typeof tools.gamescope !== 'boolean' || typeof tools.gamescopeArgs !== 'string' || typeof tools.launchOptions !== 'string') throw Error('Invalid game launch tools.');
  if (tools.dualSenseCompatibility !== undefined && typeof tools.dualSenseCompatibility !== 'boolean') throw Error('Invalid DualSense compatibility setting.');
  if (tools.dualShock4Compatibility !== undefined && typeof tools.dualShock4Compatibility !== 'boolean') throw Error('Invalid DualShock 4 compatibility setting.');
  const result = { ...(tools.dualShock4Compatibility !== undefined ? {dualShock4Compatibility:tools.dualShock4Compatibility} : {}), dualSenseCompatibility: tools.dualSenseCompatibility ?? false, mangoHud: tools.mangoHud, gamescope: tools.gamescope, gamescopeArgs: tools.gamescopeArgs.trim(), launchOptions: tools.launchOptions.trim() };
  const args = commandWords(result.gamescopeArgs);
  if (args.includes('--') || args.some(arg => arg.includes('%command%'))) throw Error('Gamescope options must not include -- or %command%; Nexus adds the game command.');
  parseLaunchOptions(result.launchOptions);
  return result;
}
