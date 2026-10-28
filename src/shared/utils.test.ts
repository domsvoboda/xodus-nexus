import { describe, expect, it } from 'vitest';
import { downloadFailure, estimateTimeRemaining, isNewerVersion, parseBackendHelp, progressBytesFromLine, progressFromLine, safeProductId, stripAnsi } from './utils.js';

describe('parseBackendHelp', () => {
  it('discovers native social commands without assuming support from login alone',()=>{
    expect(parseBackendHelp('  native-social     Xbox friends and messages\n').nativeSocial).toBe(true);
    expect(parseBackendHelp('  login      Sign in\n').nativeSocial).toBe(false);
  });
  it('negotiates the dedicated sign-in UI only when advertised', () => {
    expect(parseBackendHelp('  login    Login\nOptions:\n  --external-webview-stdio  External UI\n').externalAuth).toBe(true);
    expect(parseBackendHelp('  login    Login\n').externalAuth).toBe(false);
  });
  it('detects only advertised commands', () => {
    const parsed = parseBackendHelp(`Usage: xodus-cli <COMMAND>\n\nCommands:\n  account     Show stored account\n  download    Download files\n  login       \n  logout      \n  streaming   Stream\n  run         Run game\n  help        Help\n`);
    expect(parsed.account).toBe(true);
    expect(parsed.streaming).toBe(true);
    expect(parsed.logout).toBe(true);
    expect(parsed.commands).toContain('run');
    expect(parsed.offlinePc).toBe(false);
    expect(parseBackendHelp(['  offline-pc  Show or change the offline PC', '  run  Run', ''].join(String.fromCharCode(10))).offlinePc).toBe(true);
  });
});

describe('progress parser', () => {
  it('parses percentages and byte ratios', () => {
    expect(progressFromLine('Downloading 42%')).toBe(42);
    expect(progressFromLine('1.5 MiB / 3 MiB')).toBe(50);
    expect(progressFromLine('Downloading                    512 MiB/2 GiB 12 MiB/s [###] 25%')).toBe(25);
    expect(progressBytesFromLine('Downloading                    512 MiB/2 GiB 12 MiB/s [###] 25%')).toEqual({ current: 512 * 1024 ** 2, total: 2 * 1024 ** 3 });
  });
  it('strips terminal control codes', () => expect(stripAnsi('\u001b[32mok\u001b[0m\r')).toContain('ok'));
});

describe('version comparison', () => {
  it('detects newer published releases only', () => {
    expect(isNewerVersion('v0.5.25', '0.5.24')).toBe(true);
    expect(isNewerVersion('0.6.0', '0.5.24')).toBe(true);
    expect(isNewerVersion('1.0.0-rc.1', '0.5.24')).toBe(true);
    expect(isNewerVersion('v0.5.24', '0.5.24')).toBe(false);
    expect(isNewerVersion('0.5.23', '0.5.24')).toBe(false);
    expect(isNewerVersion(undefined, '0.5.24')).toBe(false);
    expect(isNewerVersion('not-a-version', '0.5.24')).toBe(false);
  });
});

describe('estimated time remaining', () => {
  it('estimates from binary and decimal transfer rates', () => {
    // 25_646_186_496 bytes left at 86.4 MiB/s ≈ 283 seconds.
    expect(estimateTimeRemaining('86.4 MiB/s', 18_612_245_504, 44_258_432_000)).toBe('~5m left');
    // 900 KiB left at 3 KiB/s = 300 seconds.
    expect(estimateTimeRemaining('3 KiB/s', 0, 921_600)).toBe('~5m left');
    // 480_000 bytes left at 1 KB/s = 480 seconds.
    expect(estimateTimeRemaining('1 KB/s', 1000, 481_000)).toBe('~8m left');
    // 40 MiB left at 2 MiB/s = 20 seconds.
    expect(estimateTimeRemaining('2 MiB/s', 10 * 1024 ** 2, 50 * 1024 ** 2)).toBe('~20s left');
    // A full 4 GiB download at 512 KiB/s = 8192 seconds.
    expect(estimateTimeRemaining('512 KiB/s', 0, 4 * 1024 ** 3)).toBe('~2h 17m left');
  });

  it('returns nothing without a usable rate or remaining bytes', () => {
    expect(estimateTimeRemaining(undefined, 100, 200)).toBeUndefined();
    expect(estimateTimeRemaining('12 MiB/s', null, 200)).toBeUndefined();
    expect(estimateTimeRemaining('12 MiB/s', 200, null)).toBeUndefined();
    expect(estimateTimeRemaining('0 MiB/s', 100, 200)).toBeUndefined();
    expect(estimateTimeRemaining('12 parsecs/s', 100, 200)).toBeUndefined();
    expect(estimateTimeRemaining('12 MiB/s', 200, 200)).toBeUndefined();
  });
});

describe('download failure summary', () => {
  it('prefers safe license guidance and does not mislabel later extraction failures', () => {
    const marker = 'NEXUS_CONTENT_LICENSE_DIAGNOSTIC_V1 content-http 403';
    expect(downloadFailure([marker, 'untrusted-provider-message'], 1)).toContain('purchased edition');
    expect(downloadFailure([marker, 'untrusted-provider-message'], 1)).not.toContain('untrusted-provider-message');
    const deviceLimit = downloadFailure(['NEXUS_CONTENT_LICENSE_DIAGNOSTIC_V1 content-device-limit 200', 'untrusted-provider-message'], 1);
    expect(deviceLimit).toContain('Microsoft Store device limit reached');
    expect(deviceLimit).toContain('https://account.microsoft.com/devices/content');
    expect(deviceLimit).not.toContain('untrusted-provider-message');
    expect(downloadFailure([marker, 'NEXUS_CONTENT_LICENSE_DIAGNOSTIC_V1 content-parsed 200', 'extraction failed'], 1)).toContain('extraction failed');
  });
  it('shows panic cause instead of Rust backtrace hint', () => {
    const log = [
      '0% · Initializing 0 B/9.13 GiB',
      "thread 'main' panicked at streaming.rs:280:14:",
      'ok: Header(Io(Custom { kind: UnexpectedEof, error: "cache ended before cached_len" }))',
      'note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace',
    ];
    expect(downloadFailure(log, 101)).toContain('cache ended before cached_len');
  });
});

describe('product id validation', () => {
  it('normalizes safe IDs', () => expect(safeProductId(' 9n4pt8hgcdhq ')).toBe('9N4PT8HGCDHQ'));
  it('rejects shell-like input', () => expect(() => safeProductId('foo; rm -rf')).toThrow());
});
