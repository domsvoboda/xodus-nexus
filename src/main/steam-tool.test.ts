import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isNexusTool, NEXUS_TOOL_NAME, registerNexusTool, selectCompatTool, withCompatTool } from './steam-tool.js';

const linux = process.platform === 'linux';

// The shape of Steam's config.vdf on the Armada (tabs, nested blocks).
const config = [
  '"InstallConfigStore"', '{', '\t"Software"', '\t{', '\t\t"Valve"', '\t\t{', '\t\t\t"Steam"', '\t\t\t{',
  '\t\t\t\t"CompatToolMapping"', '\t\t\t\t{',
  '\t\t\t\t\t"0"', '\t\t\t\t\t{', '\t\t\t\t\t\t"name"\t\t"Proton-CachyOS Latest"', '\t\t\t\t\t\t"config"\t\t""', '\t\t\t\t\t\t"priority"\t\t"75"', '\t\t\t\t\t}',
  '\t\t\t\t\t"4231820"', '\t\t\t\t\t{', '\t\t\t\t\t\t"name"\t\t"Proton-CachyOS Latest"', '\t\t\t\t\t\t"config"\t\t"a \\"quoted\\" {brace}"', '\t\t\t\t\t\t"priority"\t\t"250"', '\t\t\t\t\t}',
  '\t\t\t\t}', '\t\t\t\t"Other"\t\t"x"', '\t\t\t}', '\t\t}', '\t}', '}', ''].join('\n');

describe('Steam CompatToolMapping', () => {
  it('adds the tool for a shortcut without a choice, in Steam\'s formatting', () => {
    const updated = withCompatTool(config, 3715325483, NEXUS_TOOL_NAME)!;
    expect(updated).toContain('\t\t\t\t\t"3715325483"\n\t\t\t\t\t{\n\t\t\t\t\t\t"name"\t\t"xodus-nexus"\n\t\t\t\t\t\t"config"\t\t""\n\t\t\t\t\t\t"priority"\t\t"250"\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t\t"Other"');
    // Everything else stays byte for byte.
    expect(updated.replace(/\t\t\t\t\t"3715325483"\n(?:.*\n){5}/, '')).toBe(config);
  });
  it('keeps a choice the player already made, even one in a nested-looking value', () => {
    expect(withCompatTool(config, 4231820, NEXUS_TOOL_NAME)).toBeUndefined();
    expect(withCompatTool(config, 0, NEXUS_TOOL_NAME)).toBeUndefined();
    // "name" inside an entry is not a mapping key.
    expect(withCompatTool(config.replace('"0"', '"5"'), 0, NEXUS_TOOL_NAME)).toContain('\t\t\t\t\t"0"\n\t\t\t\t\t{\n\t\t\t\t\t\t"name"\t\t"xodus-nexus"');
  });
  it('changes nothing without a mapping block and rejects odd input', () => {
    expect(withCompatTool('"InstallConfigStore"\n{\n}\n', 1, NEXUS_TOOL_NAME)).toBeUndefined();
    expect(() => withCompatTool(config, 1, 'bad"tool')).toThrow();
    expect(() => withCompatTool('"CompatToolMapping"\n{\n\t"1"\n\t{\n', 2, NEXUS_TOOL_NAME)).toThrow('unterminated');
  });
});

describe.skipIf(!linux)('Xodus Nexus compatibility tool', () => {
  let home: string;
  beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-tool-')); });
  afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });

  async function runtime(manifest?: string) {
    const root = path.join(home, '.local/share/xodus-nexus/runtimes/releases/runtime-a');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'proton'), '#!/usr/bin/env python3\n', { mode: 0o755 });
    if (manifest) await fs.writeFile(path.join(root, 'toolmanifest.vdf'), manifest);
    return root;
  }

  it('registers a stable tool that hands over to the current runtime and is recognized at launch', async () => {
    const steam = path.join(home, '.local/share/Steam');
    await fs.mkdir(steam, { recursive: true, mode: 0o755 });
    const manifest = '"manifest"\n{\n  "version" "2"\n  "commandline" "/proton %verb%"\n  "require_tool_appid" "4185400"\n}\n';
    const root = await runtime(manifest);
    expect(await registerNexusTool(home, root)).toEqual({ changed: [steam], created: [steam] });
    const tool = path.join(steam, 'compatibilitytools.d', NEXUS_TOOL_NAME);
    expect(await fs.readFile(path.join(tool, 'compatibilitytool.vdf'), 'utf8')).toContain('"display_name" "Xodus Nexus"');
    expect(await fs.readFile(path.join(tool, 'toolmanifest.vdf'), 'utf8')).toBe(manifest);
    expect(await fs.readFile(path.join(tool, 'proton'), 'utf8')).toBe(`#!/bin/sh\n# Xodus Nexus compatibility tool: the current Nexus runtime.\nexec '${root}/proton' "$@"\n`);
    expect((await fs.stat(path.join(tool, 'proton'))).mode & 0o777).toBe(0o755);
    expect(await isNexusTool(tool)).toBe(true);
    expect(await isNexusTool(root)).toBe(false);
    // Unchanged files are not rewritten, and the tool is no longer new.
    expect(await registerNexusTool(home, root)).toEqual({ changed: [], created: [] });
    // A runtime update rewrites the hand-over but keeps the known tool name.
    const update = path.join(path.dirname(root), 'runtime-b');
    await fs.mkdir(update);
    await fs.writeFile(path.join(update, 'proton'), '#!/usr/bin/env python3\n', { mode: 0o755 });
    expect(await registerNexusTool(home, update)).toEqual({ changed: [steam], created: [] });
  });

  it('refuses a symlinked tool directory and needs a runnable runtime', async () => {
    const steam = path.join(home, '.local/share/Steam');
    await fs.mkdir(path.join(steam, 'compatibilitytools.d'), { recursive: true });
    const elsewhere = path.join(home, 'elsewhere');
    await fs.mkdir(elsewhere);
    await fs.symlink(elsewhere, path.join(steam, 'compatibilitytools.d', NEXUS_TOOL_NAME));
    await expect(registerNexusTool(home, await runtime())).rejects.toThrow('Unsafe');
    expect(await fs.readdir(elsewhere)).toEqual([]);
    await expect(registerNexusTool(home, path.join(home, 'missing'))).rejects.toThrow();
  });

  it('selects the tool in a stopped Steam\'s config.vdf, with a backup', async () => {
    const steam = path.join(home, 'Steam');
    await fs.mkdir(path.join(steam, 'config'), { recursive: true });
    await fs.writeFile(path.join(steam, 'config/config.vdf'), config, { mode: 0o600 });
    expect(await selectCompatTool(steam, 3715325483)).toBe(true);
    expect(await fs.readFile(path.join(steam, 'config/config.vdf'), 'utf8')).toContain('"3715325483"');
    expect((await fs.readdir(path.join(steam, 'config'))).filter(name => name.includes('nexus-backup'))).toHaveLength(1);
    expect(await selectCompatTool(steam, 3715325483)).toBe(false);
  });
});
