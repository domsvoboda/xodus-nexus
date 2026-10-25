// Demo fixtures served by the main process when the launcher runs with
// XODUS_DEMO=1, so screenshots and UI tours show plausible content without
// any account, backend or installed games. Store pages keep using the live
// Microsoft Store catalog, and library covers are fetched from the Store by
// the real Product IDs below. No real credentials, tokens or account data.
import type { AccountLibraryPage, AppSnapshot, Game, GameLaunchOptions } from './types.js';

export interface DemoArtwork { coverUrl?: string; heroUrl?: string }
export interface DemoVersions {
  launcher: string;
  backend: string;
  backendCommit: string;
  backendCompatibility: string;
}

// Product IDs are real Microsoft Store products so display-catalog lookups
// return the genuine published artwork.
export const demoGames: Game[] = [
  { id: 'demo-1', title: 'Forza Horizon 6', path: '/home/demo/Games/Xodus Nexus/ForzaHorizon6', storeId: '9N431PX143P8', publisher: 'Xbox Game Studios', executable: 'ForzaHorizon6.exe', installState: 'ready', addedAt: '2026-10-08T18:12:00.000Z' },
  { id: 'demo-2', title: 'Gears of War: E-Day', path: '/home/demo/Games/Xodus Nexus/GearsEDay', storeId: '9N4PT8HGCDHQ', publisher: 'The Coalition', executable: 'start_protected_game.exe', installState: 'ready', antiCheat: { provider: 'Easy Anti-Cheat', encryptedTarget: true }, addedAt: '2026-10-08T21:40:00.000Z' },
  { id: 'demo-3', title: 'Minecraft Dungeons II', path: '/home/demo/Games/Xodus Nexus/Minecraft-Dungeons-II', storeId: '9PM3J18QM4Q3', publisher: 'Mojang', executable: 'Binaries/WinGDK/Dungeons.exe', installState: 'ready', addedAt: '2026-10-09T09:05:00.000Z' },
  { id: 'demo-4', title: 'Sea of Thieves', path: '/home/demo/Games/Xodus Nexus/SeaOfThieves', storeId: '9P2N57MC619K', publisher: 'Rare', executable: 'SoTGame.exe', installState: 'incomplete', installMessage: 'Package verification pending', addedAt: '2026-10-10T14:22:00.000Z' },
  { id: 'demo-5', title: 'Grounded', path: '/home/demo/Games/Xodus Nexus/Grounded', storeId: '9PJTHRNVH62H', publisher: 'Obsidian', executable: 'Indiana/Binaries/WinGDK/Indiana.exe', installState: 'imported', addedAt: '2026-10-10T16:48:00.000Z' },
  { id: 'demo-6', title: 'A Game About Digging A Hole', path: '/home/demo/Games/Xodus Nexus/DiggingHole', storeId: '9NGLST31DG26', publisher: 'Local import', executable: 'Dig.exe', installState: 'ready', addedAt: '2026-10-11T10:02:00.000Z' },
];

export const demoDownloads: AppSnapshot['downloads'] = [
  { id: 'demo-download-1', kind: 'install', title: 'Age of Mythology: Retold', productId: '9NPKGVXPFRSX', destination: '/home/demo/Games/Xodus Nexus', status: 'running', progress: 42, downloadedBytes: 18_612_245_504, totalBytes: 44_258_432_000, transferRate: '86.4 MiB/s', phase: 'Streaming package', log: [], startedAt: new Date().toISOString() },
  { id: 'demo-download-2', kind: 'install', title: 'Sea of Thieves', productId: '9P2N57MC619K', destination: '/home/demo/Games/Xodus Nexus', status: 'queued', progress: null, phase: 'Queued', log: [], startedAt: new Date().toISOString() },
  { id: 'demo-download-3', kind: 'install', title: 'Grounded', productId: '9PJTHRNVH62H', destination: '/home/demo/Games/Xodus Nexus', status: 'complete', progress: 100, phase: 'Complete', log: [], startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() },
];

// Explicit sample entitlements, never inferred from or fetched for a real user.
export const demoAccountProducts = [
  { productId: '9N26X2PMTWBT', title: 'Wolfenstein II: The New Colossus', publisher: 'Bethesda Softworks', access: 'owned' as const },
  { productId: '9P74BRFBXXC6', title: 'DOOM Eternal (BATTLEMODE - PC)', publisher: 'Bethesda Softworks', access: 'owned' as const },
  { productId: '9NPKGVXPFRSX', title: 'Age of Mythology: Retold', publisher: 'Xbox Game Studios', access: 'gamepass' as const },
];

export function demoAccountLibrary(kind: AccountLibraryPage['kind'], artwork: ReadonlyMap<string, DemoArtwork>): AccountLibraryPage {
  const accessByProductId: AccountLibraryPage['accessByProductId'] = {};
  for (const [index, game] of demoGames.entries()) if (game.storeId) accessByProductId[game.storeId] = index === 1 ? 'owned' : 'gamepass';
  for (const product of demoAccountProducts) accessByProductId[product.productId] = product.access;
  return { kind, checkedAt: new Date().toISOString(), accessByProductId,
    products: demoAccountProducts.filter(product => kind === 'all' || product.access === kind).map(product => ({
      ...product, description: 'Sample library entry for the account-free demo.', categories: [],
      posterUrl: artwork.get(product.productId)?.coverUrl, heroUrl: artwork.get(product.productId)?.heroUrl,
      installability: 'supported', supportNote: 'Demo data only.',
    })) };
}

export function demoSnapshot(versions: DemoVersions = { launcher: '0.0.0', backend: '0.0.0',
  backendCommit: '0'.repeat(40), backendCompatibility: 'demo' }, artwork: ReadonlyMap<string, DemoArtwork> = new Map()): AppSnapshot {
  return {
    connectivity: { state: 'online', checkedAt: '2026-01-01T00:00:00.000Z' },
    backend: {
      available: true, source: 'managed', binaryPath: '/home/demo/.config/xodus-nexus/xodus-backends/current', commit: versions.backendCommit, upstreamCommit: versions.backendCommit, updateAvailable: false, checking: false, updating: false, externalRoot: '',
      capabilities: { commands: ['login', 'logout', 'download', 'streaming', 'run', 'license', 'extract', 'profile', 'library'], account: true, profile: true, library: true, login: true, externalAuth: true, logout: true, download: true, streaming: true, streamingProgressJson: true, streamingControls: true, run: true, version: '0.5.0' },
      prerequisites: { git: true, cargo: true, rustc: true, protoc: true },
      linuxRunPatch: versions.backendCompatibility,
      version: versions.backend, delivery: 'release', releaseAvailable: true, releaseVersion: versions.backend,
    },
    runtime: {
      installed: true, checking: false, updating: false, runtimeRoot: '/home/demo/.local/share/xodus-nexus/runtimes', name: 'xodus-nexus-runtime-demo', winePath: '/home/demo/.local/share/xodus-nexus/runtimes/demo/files/bin/wine', artifactAvailable: false,
      prerequisites: { gh: true, authenticated: true, tar: true, sha512sum: true },
    },
    games: structuredClone([...demoGames.slice(1, 2), ...demoGames.slice(0, 1), ...demoGames.slice(2)]).map((game) => ({ ...game, ...(game.storeId ? artwork.get(game.storeId) : undefined) })),
    downloads: structuredClone(demoDownloads).map((task) => ({ ...task, coverUrl: task.productId ? artwork.get(task.productId)?.coverUrl : undefined })),
    settings: { installRoot: '/home/demo/Games/Xodus Nexus', market: 'US', parallelDownloads: 4, winePath: '', externalXodusRoot: '', runtimeRoot: '', verboseLogs: false, firstRunCompleted: true },
    auth: { running: false, stored: true, username: 'sample@example.test', gamertag: 'NexusPlayer',
      subscription: { status: 'active', productIds: ['CFQ7TTC0KGQ8'], checkedAt: new Date().toISOString() },
      lastResult: 'success', note: 'Demo mode: sample data only. Store pages show the live Microsoft Store catalog.' },
    launcherUpdate: { currentVersion: versions.launcher, checking: false, checkedAt: new Date().toISOString() },
  };
}

export const demoLaunchOptions: GameLaunchOptions = { cloudSaves: true, vcInstall: true };
export const demoLocales = ['en-US', 'en-GB', 'cs-CZ', 'de-DE', 'fr-FR', 'ja-JP'];
