/**
 * Explicit GitHub repositories accepted for launcher component delivery.
 *
 * The launcher repository is being renamed from `xodus-nexus` to
 * `nexus-launcher`. Both names are accepted only for exact tag and asset-name
 * URLs. Never replace these checks with a generic HTTPS or owner-prefix check.
 */
export const RENAMED_LAUNCHER_REPOSITORY = 'domsvoboda/nexus-launcher';
export const LEGACY_LAUNCHER_REPOSITORY = 'domsvoboda/xodus-nexus';

/**
 * Update feeds and artifact URL aliases. The canonical name is first so it wins
 * a tie for the same release version. The legacy name stays accepted while the
 * repository rename and its redirects settle.
 */
export const LAUNCHER_RELEASE_REPOSITORIES = [RENAMED_LAUNCHER_REPOSITORY, LEGACY_LAUNCHER_REPOSITORY] as const;

/** Alias-only list for the already released backend artifacts, not a new feed. */
export const BACKEND_RELEASE_REPOSITORIES = LAUNCHER_RELEASE_REPOSITORIES;

export type LauncherReleaseRepository = typeof LAUNCHER_RELEASE_REPOSITORIES[number];
export type ReleaseRepository = LauncherReleaseRepository;

/** The only accepted artifact URL form for a trusted repository, tag and name. */
export function releaseAssetUrl(repository: ReleaseRepository, tag: string, name: string): string {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${name}`;
}

/** Exact repository, tag and asset-name equality. Never a host or prefix check. */
export function assetRepository<T extends ReleaseRepository>(
  repositories: readonly T[], tag: string, name: string, url: unknown,
): T | undefined {
  return repositories.find(repository => url === releaseAssetUrl(repository, tag, name));
}
