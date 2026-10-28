import type { BackendCapabilities } from './types.js';
import { contentLicenseFailure } from './content-license.js';
import { transferFailure } from './transfer-failure.js';

const COMMAND_LINE = /^[ \t]{2}([a-z][a-z0-9-]+)[ \t]{2,}/gm;

// Loose semver comparison ("v1.2.3-rc" style tags included): true when the
// candidate version is strictly newer than the current one.
export function isNewerVersion(candidate: string | undefined, current: string): boolean {
  if (!candidate) return false;
  const parse = (value: string) => value.trim().replace(/^v/i, '').split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(candidate);
  const right = parse(current);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

export function parseBackendHelp(help: string): BackendCapabilities {
  const commands = [...help.matchAll(COMMAND_LINE)].map((match) => match[1]);
  const version = help.match(/xodus-cli\s+([\w.+-]+)/i)?.[1];
  return {
    commands,
    account: commands.includes('account'),
    profile: commands.includes('profile'),
    gameActivity: commands.includes('game-activity'),
    achievements: commands.includes('achievements'),
    library: commands.includes('library'),
    nativeSocial: commands.includes('native-social'),
    login: commands.includes('login'),
    externalAuth: /(?:^|\s)--external-webview-stdio(?:\s|$)/m.test(help),
    logout: commands.includes('logout'),
    download: commands.includes('download'),
    streaming: commands.includes('streaming'),
    run: commands.includes('run'),
    offlinePc: commands.includes('offline-pc'),
    version,
  };
}

export function stripAnsi(value: string): string {
  // ANSI CSI/OSC sequences emitted by indicatif and tracing.
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n');
}

export function progressFromLine(line: string): number | null {
  const explicit = line.match(/(?:^|\s)(100|\d{1,2}(?:\.\d+)?)%/);
  if (explicit) return Math.min(100, Number(explicit[1]));
  const bytes = progressBytesFromLine(line);
  return bytes ? Math.min(100, (bytes.current / bytes.total) * 100) : null;
}

export function progressBytesFromLine(line: string): { current: number; total: number } | null {
  const bytes = line.match(/([\d.]+)\s*(B|KiB|MiB|GiB|TiB|KB|MB|GB|TB)\s*\/\s*([\d.]+)\s*(B|KiB|MiB|GiB|TiB|KB|MB|GB|TB)/i);
  if (!bytes) return null;
  const units: Record<string, number> = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4 };
  const current = Number(bytes[1]) * units[bytes[2].toLowerCase()];
  const total = Number(bytes[3]) * units[bytes[4].toLowerCase()];
  return Number.isFinite(current) && Number.isFinite(total) && total > 0 ? { current, total } : null;
}

export function downloadFailure(log: string[], exitCode: number): string {
  const transfer = transferFailure(log);
  if (transfer) return `Xodus exited with code ${exitCode}: ${transfer}`;
  const licensing = contentLicenseFailure(log);
  if (licensing) return `Xodus exited with code ${exitCode}: ${licensing}`;
  const detail = [...log].reverse().find((line) =>
    line.trim().length > 0
    && !/^\d+% ·/.test(line)
    && !/^note: run with\b.*RUST_BACKTRACE=/i.test(line)
    && !/^session terminated/i.test(line)
    && !/^script done/i.test(line),
  );
  return detail ? `Xodus exited with code ${exitCode}: ${detail.slice(0, 300)}` : `Xodus exited with code ${exitCode}`;
}

export function safeProductId(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9-]{6,40}$/.test(normalized)) {
    throw new Error('Enter a valid Store/Product ID (6–40 characters: A–Z, 0–9, or a hyphen).');
  }
  return normalized;
}

// Estimated time remaining for a download, derived from the transfer rate
// Xodus reports (for example "86.4 MiB/s") and the byte counters.
export function estimateTimeRemaining(transferRate: string | undefined, downloadedBytes: number | null | undefined, totalBytes: number | null | undefined): string | undefined {
  if (!transferRate || downloadedBytes == null || totalBytes == null) return undefined;
  const remaining = totalBytes - downloadedBytes;
  if (remaining <= 0) return undefined;
  const match = transferRate.trim().match(/^([\d.]+)\s*(KiB|MiB|GiB|TiB|KB|MB|GB|TB|B)\/s$/i);
  if (!match) return undefined;
  const binary: Record<string, number> = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
  const decimal: Record<string, number> = { b: 1, kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4 };
  const unit = match[2].toLowerCase();
  const multiplier = binary[unit] ?? decimal[unit];
  const bytesPerSecond = Number(match[1]) * multiplier;
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return undefined;
  const seconds = remaining / bytesPerSecond;
  if (!Number.isFinite(seconds)) return undefined;
  const rounded = Math.round(seconds);
  if (rounded < 60) return `~${rounded}s left`;
  const minutes = Math.round(rounded / 60);
  if (minutes < 60) return `~${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `~${hours}h ${minutes % 60}m left`;
  return `~${Math.floor(hours / 24)}d ${hours % 24}h left`;
}
