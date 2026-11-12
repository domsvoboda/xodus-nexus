import { externalFontEnvironment } from './launcher-fonts.js';

/** The marker is set only by the pre-GTK wrapper, not by desktop launch paths. */
export function launcherSteamImeActive(environment: NodeJS.ProcessEnv = process.env, platform = process.platform): boolean {
  return platform === 'linux' && environment.XODUS_NEXUS_STEAM_IME === '1'
    && environment.GTK_IM_MODULE === 'simple'
    && Boolean(environment.XDG_CURRENT_DESKTOP?.split(':').some(value => value.toLowerCase() === 'gamescope'));
}

/** Keep launcher-only native UI workarounds out of games and external tools. */
export function externalLauncherEnvironment(source: NodeJS.ProcessEnv = process.env, platform = process.platform): NodeJS.ProcessEnv {
  const environment = externalFontEnvironment(source);
  if (launcherSteamImeActive(environment, platform)) environment.GTK_IM_MODULE = 'Steam';
  delete environment.XODUS_NEXUS_STEAM_IME;
  return environment;
}

/** Native file dialogs are separate top-level windows that gamescope neither
 * raises nor routes input to, so Gaming Mode must not open them. */
export function nativeDialogsAvailable(environment: NodeJS.ProcessEnv = process.env): boolean {
  return !environment.XDG_CURRENT_DESKTOP?.split(':').some(value => value.toLowerCase() === 'gamescope');
}
