import { expect, it, vi } from 'vitest';
import { AccountRefresh, readAccount } from './account-refresh.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

it('coalesces repeated refreshes for the same backend identity', async () => {
  const gate = new AccountRefresh();
  let finish!: (value: string) => void;
  const read = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
  const publish = vi.fn(async (_value: string) => {});
  const jobs = Array.from({ length: 5 }, () => gate.run('same', read, publish, () => true));
  await Promise.resolve(); expect(read).toHaveBeenCalledTimes(1);
  finish('current'); await Promise.all(jobs);
  expect(publish).toHaveBeenCalledTimes(1); expect(publish).toHaveBeenCalledWith('current');
});

it('cannot let a pre-login response overwrite a newer account or clear its library', async () => {
  const gate = new AccountRefresh();
  let finish!: (value: boolean) => void;
  let stored = false;
  const publish = vi.fn(async (value: boolean) => { stored = value; });
  const old = gate.run('backend', () => new Promise<boolean>(resolve => { finish = resolve; }), publish, () => true);
  await Promise.resolve(); gate.invalidate();
  await gate.run('backend', async () => true, publish, () => true);
  finish(false); await old;
  expect(stored).toBe(true); expect(publish).toHaveBeenCalledTimes(1);
});

it('discards changed backend/market reads and permits retries after failure', async () => {
  const gate = new AccountRefresh(), publish = vi.fn(async (_value: number) => {});
  await gate.run('old', async () => 1, publish, () => false);
  expect(publish).not.toHaveBeenCalled();
  await expect(gate.run('new', async () => { throw Error('failed'); }, publish, () => true)).rejects.toThrow('failed');
  await gate.run('new', async () => 2, publish, () => true);
  expect(publish).toHaveBeenCalledTimes(1); expect(publish).toHaveBeenCalledWith(2);
});

it('cancels an obsolete read without allowing its rejection to clear the new account', async () => {
  const gate = new AccountRefresh(), publish = vi.fn(async (_value: string) => {});
  let signal!: AbortSignal;
  const old = gate.run('old', current => { signal = current; return new Promise<string>((_resolve, reject) => current.addEventListener('abort', () => reject(Error('aborted')), { once: true })); }, publish, () => true);
  await Promise.resolve();
  await gate.run('new', async () => 'current', publish, () => true);
  await old;
  expect(signal.aborted).toBe(true); expect(publish).toHaveBeenCalledTimes(1); expect(publish).toHaveBeenCalledWith('current');
});

it('reads only account stdout and cancels an obsolete synthetic status subprocess', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-account-read-'));
  const binary = path.join(root, 'cli');
  try {
    await fs.writeFile(binary, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({stored:true,username:"sample@example.test"}));process.stderr.write(JSON.stringify({stored:false}));\n', { mode: 0o700 });
    const result = await readAccount(binary, new AbortController().signal);
    expect(JSON.parse(result.output).stored).toBe(true);
    await fs.writeFile(binary, '#!/usr/bin/env node\nsetInterval(()=>{},1000);\n', { mode: 0o700 });
    const controller = new AbortController();
    const pending = readAccount(binary, controller.signal); controller.abort();
    expect((await pending).code).not.toBe(0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});


it('finishes a read-only account command when a detached keyring helper inherits its pipes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-account-helper-'));
  const binary = path.join(root, 'cli');
  try {
    await fs.writeFile(binary, `#!${process.execPath}
const {spawn}=require('node:child_process');
spawn(process.execPath,['-e','setTimeout(()=>{},2000)'],{detached:true,stdio:['ignore',1,2]}).unref();
process.stdout.write(JSON.stringify({stored:true,username:'sample@example.test'}));
process.exit(23);
`, {mode:0o700});
    const start=performance.now();
    const result=await readAccount(binary,new AbortController().signal);
    expect(result.code).toBe(23);
    expect(JSON.parse(result.output)).toEqual({stored:true,username:'sample@example.test'});
    expect(performance.now()-start).toBeLessThan(1500);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
