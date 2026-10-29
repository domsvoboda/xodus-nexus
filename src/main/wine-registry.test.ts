import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyPrefixSettings, GAMING_SERVICES_VERSION, prefixInUse, qwordValue, withoutKeyTree, withQwords } from './wine-registry.js';

const linux = process.platform === 'linux';
const system = [
  'WINE REGISTRY Version 2', ';; All keys relative to \\\\Machine', '', '#arch=win64', '',
  '[Software\\\\Microsoft\\\\GamingServices] 1700000000', '#time=1d000000000000', '"CurrentVersion"=hex(b):01,00,00,00,00,00,00,00', '"Other"=dword:00000001', '',
  '[Software\\\\Wine] 1700000000', '#time=1d000000000000', '"Version"="win10"', '', ''].join('\n');

describe('Wine registry files', () => {
  it('writes REG_QWORD as Wine does', () => {
    expect(qwordValue(GAMING_SERVICES_VERSION)).toBe('hex(b):00,00,79,69,75,00,26,00');
  });
  it('updates values in an existing section and keeps the rest', () => {
    const updated = withQwords(system, 'Software\\Microsoft\\GamingServices', { AvailableVersion: 2n, CurrentVersion: GAMING_SERVICES_VERSION });
    expect(updated).toContain('"CurrentVersion"=hex(b):00,00,79,69,75,00,26,00\n"Other"=dword:00000001\n"AvailableVersion"=hex(b):02,00,00,00,00,00,00,00\n\n[Software\\\\Wine]');
    expect(updated.startsWith('WINE REGISTRY Version 2\n')).toBe(true);
    expect(updated).toContain('"Version"="win10"');
  });
  it('adds a missing section with Wine\'s header lines', () => {
    const now = new Date(1_800_000_000_000);
    const updated = withQwords(system.replace(/\[Software\\\\Microsoft[^]*?\n\n/, ''), 'Software\\Microsoft\\GamingServices', { CurrentVersion: 1n }, now);
    expect(updated).toContain('"Version"="win10"\n\n[Software\\\\Microsoft\\\\GamingServices] 1800000000\n#time=');
    expect(updated.trimEnd().endsWith('"CurrentVersion"=hex(b):01,00,00,00,00,00,00,00')).toBe(true);
  });
  it('replaces a value that continues over several lines', () => {
    const long = system.replace('"CurrentVersion"=hex(b):01,00,00,00,00,00,00,00', '"CurrentVersion"=hex(b):01,\\\n  02,03');
    const updated = withQwords(long, 'software\\microsoft\\gamingservices', { CurrentVersion: 3n });
    expect(updated).not.toContain('  02,03');
    expect(updated.match(/"CurrentVersion"/g)).toHaveLength(1);
  });
  it('removes a key and its subkeys only', () => {
    const user = ['WINE REGISTRY Version 2', '', '[Control Panel\\\\International] 1', '"LocaleName"="en-US"', '',
      '[Control Panel\\\\International\\\\Geo] 1', '"Nation"="244"', '', '[Control Panel\\\\InternationalOther] 1', '', '[Software] 1', ''].join('\n');
    const updated = withoutKeyTree(user, 'Control Panel\\International')!;
    expect(updated).not.toContain('LocaleName');
    expect(updated).not.toContain('Nation');
    expect(updated).toContain('[Control Panel\\\\InternationalOther]');
    expect(updated).toContain('[Software]');
    expect(withoutKeyTree(updated, 'Control Panel\\International')).toBeUndefined();
  });
  it('finds Wine processes of a prefix by their WINEPREFIX', async () => {
    const proc = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-proc-'));
    try {
      await fs.mkdir(path.join(proc, '42'));
      await fs.writeFile(path.join(proc, '42', 'environ'), 'HOME=/h\0WINEPREFIX=/data/compatdata/1/pfx\0');
      expect(await prefixInUse('/data/compatdata/1/pfx', proc)).toBe(true);
      expect(await prefixInUse('/data/compatdata/1/pfx2', proc)).toBe(false);
    } finally { await fs.rm(proc, { recursive: true, force: true }); }
  });
});

describe.skipIf(!linux)('Steam prefix settings', () => {
  let prefix: string;
  beforeEach(async () => {
    prefix = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-pfx-'));
    await fs.writeFile(path.join(prefix, 'system.reg'), system, { mode: 0o644 });
    await fs.writeFile(path.join(prefix, 'user.reg'), 'WINE REGISTRY Version 2\n\n[Control Panel\\\\International] 1\n"LocaleName"="en-US"\n\n', { mode: 0o644 });
  });
  afterEach(async () => { await fs.rm(prefix, { recursive: true, force: true }); });

  it('applies the Gaming Services override and the language reset', async () => {
    const lines: string[] = [];
    await applyPrefixSettings(prefix, { gamingServices: true, resetLocale: true }, line => lines.push(line));
    const systemReg = await fs.readFile(path.join(prefix, 'system.reg'), 'utf8');
    expect(systemReg).toContain('"AvailableVersion"=hex(b):00,00,79,69,75,00,26,00');
    expect(systemReg).toContain('"CurrentVersion"=hex(b):00,00,79,69,75,00,26,00');
    expect(await fs.readFile(path.join(prefix, 'user.reg'), 'utf8')).not.toContain('International');
    expect(lines).toHaveLength(2);
    expect((await fs.stat(path.join(prefix, 'system.reg'))).mode & 0o777).toBe(0o644);
    // A second run has nothing left to change.
    lines.length = 0;
    await applyPrefixSettings(prefix, { gamingServices: true, resetLocale: true }, line => lines.push(line));
    expect(lines).toEqual([]);
  });

  it('refuses a linked registry file', async () => {
    await fs.rm(path.join(prefix, 'system.reg'));
    const target = path.join(prefix, 'elsewhere.reg');
    await fs.writeFile(target, system);
    await fs.symlink(target, path.join(prefix, 'system.reg'));
    await expect(applyPrefixSettings(prefix, { gamingServices: true, resetLocale: false }, () => {})).rejects.toThrow('Unsafe');
    expect(await fs.readFile(target, 'utf8')).toBe(system);
  });
});
