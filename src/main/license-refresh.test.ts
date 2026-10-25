import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LICENSE_REFRESH_INTERVAL_MS, parseLicenseRefresh, refreshOfflineLicenses } from './license-refresh.js';

const NOW = Date.UTC(2026, 9, 25, 12);
const summary = (fields: Record<string, unknown>) => JSON.stringify({ schema: 1, checked: 2, renewed: 2, onlineOnly: 0, refused: 0, failed: 0, unreachable: false, earliestExpiresAt: 1_795_000_000, ...fields });

let root: string;
let lines: string[];
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-license-refresh-')); lines = []; });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('parseLicenseRefresh', () => {
  it('reads the last schema-1 summary line and ignores diagnostics', () => {
    expect(parseLicenseRefresh(`NEXUS_CONTENT_LICENSE_DIAGNOSTIC_V1 content-cache-stored 0\n${summary({ renewed: 1, refused: 1 })}\n`))
      .toEqual({ checked: 2, renewed: 1, onlineOnly: 0, refused: 1, failed: 0, unreachable: false, earliestExpiresAt: 1_795_000_000 });
    expect(parseLicenseRefresh(summary({ unreachable: true, earliestExpiresAt: null }))).toMatchObject({ unreachable: true, earliestExpiresAt: null });
    expect(parseLicenseRefresh('{"schema":2}\nnot json\n')).toBeUndefined();
    expect(parseLicenseRefresh('')).toBeUndefined();
  });
});

describe('refreshOfflineLicenses', () => {
  it('skips an empty or missing cache without running the backend', async () => {
    const runner = vi.fn();
    expect(await refreshOfflineLicenses('/bin/xodus-cli', path.join(root, 'missing'), line => lines.push(line), NOW, runner)).toBeUndefined();
    await fs.writeFile(path.join(root, 'notes.txt'), '');
    expect(await refreshOfflineLicenses('/bin/xodus-cli', root, line => lines.push(line), NOW, runner)).toBeUndefined();
    expect(runner).not.toHaveBeenCalled();
  });

  it('renews once a day and stamps only answers that reached Microsoft', async () => {
    await fs.writeFile(path.join(root, 'content-a.json'), '{}');
    const runner = vi.fn(async () => ({ code: 1, output: summary({ unreachable: true, renewed: 0, checked: 1, earliestExpiresAt: null }) }));
    expect((await refreshOfflineLicenses('/bin/xodus-cli', root, line => lines.push(line), NOW, runner))?.unreachable).toBe(true);
    expect(runner).toHaveBeenCalledWith('/bin/xodus-cli', ['license-refresh', '--license-cache', root]);
    expect(lines.at(-1)).toContain('unreachable');
    // Unreachable leaves no stamp, so the next session tries again.
    runner.mockImplementation(async () => ({ code: 0, output: summary({ onlineOnly: 1, renewed: 1 }) }));
    const renewed = await refreshOfflineLicenses('/bin/xodus-cli', root, line => lines.push(line), Date.now(), runner);
    expect(renewed?.renewed).toBe(1);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(lines.at(-1)).toMatch(/1 of 2 renewed, 1 removed; offline play now valid until at least \d{4}-\d{2}-\d{2}\./);
    const stamped = (await fs.stat(path.join(root, '.last-refresh'))).mtimeMs;
    expect(await refreshOfflineLicenses('/bin/xodus-cli', root, line => lines.push(line), stamped + 60_000, runner)).toBeUndefined();
    expect(runner).toHaveBeenCalledTimes(2);
    await refreshOfflineLicenses('/bin/xodus-cli', root, line => lines.push(line), stamped + LICENSE_REFRESH_INTERVAL_MS + 1, runner);
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it('reports a backend without a summary or one that cannot start, and never throws', async () => {
    await fs.writeFile(path.join(root, 'content-a.json'), '{}');
    expect(await refreshOfflineLicenses('/bin/xodus-cli', root, line => lines.push(line), NOW, async () => ({ code: 2, output: 'error: unrecognized subcommand' }))).toBeUndefined();
    expect(lines.at(-1)).toBe('Offline license renewal failed (xodus-cli exited with code 2).');
    expect(await refreshOfflineLicenses('/bin/xodus-cli', root, line => lines.push(line), NOW, async () => { throw Error('ENOENT'); })).toBeUndefined();
    expect(lines.at(-1)).toBe('Offline license renewal could not start: ENOENT');
  });
});
