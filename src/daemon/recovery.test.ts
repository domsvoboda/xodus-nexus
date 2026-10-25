import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AdoptedGame, processCarries, SessionStateFile, type SessionRecord } from './recovery.js';

const linux = process.platform === 'linux';

describe('SessionStateFile', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-recovery-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('writes atomically, reads back and removes', async () => {
    const file = new SessionStateFile(path.join(root, 'nested', 'state.json'));
    expect(await file.read()).toBeUndefined();
    const record: SessionRecord = { schema: 1, game: { operationId: 'game-1', gameId: '1', title: 'T', pgid: 1234, startedAt: 'now', env: { DISPLAY: ':0' } } };
    await file.write(record);
    expect(await file.read()).toEqual(record);
    expect((await fs.readdir(path.join(root, 'nested'))).filter(name => name !== 'state.json')).toEqual([]);
    await fs.writeFile(file.file, '{"schema":2}');
    expect(await file.read()).toBeUndefined();
    await fs.writeFile(file.file, 'garbage');
    expect(await file.read()).toBeUndefined();
    await file.remove();
    expect(await file.read()).toBeUndefined();
  });
});

describe.skipIf(!linux)('AdoptedGame', () => {
  let child: ChildProcess | undefined;
  afterEach(() => { try { child?.kill('SIGKILL'); } catch { /* gone */ } });

  it('verifies the launch id in the process environment and watches a group it did not spawn', async () => {
    // The environment exists before the script runs; wait for the handlers before signalling.
    child = spawn(process.execPath, ['-e', 'process.on("SIGINT",()=>process.exit(0));setInterval(()=>{},1000);process.stdout.write("READY\\n")'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, XODUS_NEXUS_LAUNCH_ID: 'game-abc' } });
    await once(child.stdout!, 'data');
    const pgid = child.pid!;
    await vi.waitFor(async () => expect(await processCarries(pgid, 'XODUS_NEXUS_LAUNCH_ID', 'game-abc')).toBe(true));
    const record = { operationId: 'game-abc', gameId: 'abc', title: 'Adopted', pgid, startedAt: 'now', env: {} };
    expect(await AdoptedGame.verify(record)).toBe(true);
    expect(await AdoptedGame.verify({ ...record, operationId: 'game-other' })).toBe(false);
    const adopted = new AdoptedGame(record, 20);
    expect(adopted.operation).toMatchObject({ id: 'game-abc', status: 'running', kind: 'launch' });
    await adopted.stop();
    const result = await adopted.result;
    expect(result.code).toBeNull();
    expect(adopted.operation.status).toBe('complete');
    adopted.dispose();
    expect(await AdoptedGame.verify(record)).toBe(false);
  });

  it('force-stops a group that ignores the interrupt', async () => {
    child = spawn(process.execPath, ['-e', 'process.on("SIGINT",()=>{});process.on("SIGTERM",()=>{});setInterval(()=>{},1000);process.stdout.write("READY\\n")'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, XODUS_NEXUS_LAUNCH_ID: 'game-def' } });
    await once(child.stdout!, 'data');
    const record = { operationId: 'game-def', gameId: 'def', title: 'Stubborn', pgid: child.pid!, startedAt: 'now', env: {} };
    await vi.waitFor(async () => expect(await AdoptedGame.verify(record)).toBe(true));
    const adopted = new AdoptedGame(record, 20);
    await adopted.stop();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(await AdoptedGame.verify(record)).toBe(true);
    await adopted.forceStop();
    await adopted.result;
    adopted.dispose();
    expect(await AdoptedGame.verify(record)).toBe(false);
  });
});
