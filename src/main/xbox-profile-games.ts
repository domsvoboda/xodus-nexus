import type {XboxProfileGames} from '../shared/types.js';
import type {XboxSocialContext} from './xbox-native-social.js';
import {withXboxProfileArtwork} from './xbox-profile-artwork.js';

export interface XboxProfileGamesSource {
  context(): XboxSocialContext | undefined;
  matches(context: XboxSocialContext): boolean;
  games(xuid: string, context?: XboxSocialContext): Promise<XboxProfileGames>;
}

const changed = () => Error('Xbox account changed. Open Social again.');

/**
 * Read one player's title history on an exact social identity binding.
 * The context is checked before the native read, after it and after optional
 * artwork enrichment. A clear or account/role change during the artwork wait
 * rejects instead of returning the previous account's history. Artwork failure
 * stays optional, but it can never skip the final identity check.
 */
export async function readXboxProfileGames(
  source: XboxProfileGamesSource,
  xuid: string,
  resolveArtwork: (titleIds: string[]) => Promise<Map<string, string>>,
): Promise<XboxProfileGames> {
  const context = source.context();
  if (!context) throw Error('Sign in and use a Nexus backend with Xbox social support.');
  if (!source.matches(context)) throw changed();
  const games = await source.games(xuid, context);
  if (!source.matches(context)) throw changed();
  const enriched = await withXboxProfileArtwork(games, resolveArtwork);
  if (!source.matches(context)) throw changed();
  return enriched;
}
