import { describe, expect, it } from 'vitest';
import { spawnGameProcess } from './game-process.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function ready(check: () => boolean) {
  for (let i = 0; i < 150; i++) { if (check()) return; await delay(10); }
  throw new Error('Fixture did not become ready');
}

describe('game process', () => {
  it('launches directly and monitors output and exit status', async () => {
    const lines: string[] = [];
    const game = await spawnGameProcess('printf', ['game output\n'], { onLine: (line) => lines.push(line) });
    const result = await game.result;
    expect(result.code).toBe(0);
    expect(result.output).toContain('game output');
    expect(lines).toContain('game output');
    await game.cleanup();
  });

  it('routes output through a followed file, which a late reader can still pick up', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nexus-game-output-'));
    try {
      const outputFile = path.join(root, 'game.output');
      const lines: string[] = [];
      const game = await spawnGameProcess(process.execPath, ['-e', "console.log('out line');console.error('err line');process.stdout.write('tail')"],
        { onLine: (line) => lines.push(line) }, { outputFile });
      const result = await game.result;
      expect(result.code).toBe(0);
      expect(lines).toEqual(['out line', 'err line', 'tail']);
      expect(result.output).toContain('err line');
      expect(await readFile(outputFile, 'utf8')).toBe('out line\nerr line\ntail');
      await game.cleanup();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('stops the game process group without signalling unrelated processes', async () => {
    const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const lines: string[] = [];
    const game = await spawnGameProcess(process.execPath, ['-e', `
      const {spawn}=require('child_process');
      const c=spawn(process.execPath,['-e',"process.on('SIGINT',()=>{console.log('CHILD_STOP');process.exit(0)});console.log('CHILD_READY');setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit']});
      process.on('SIGINT',()=>{console.log('PARENT_STOP');c.once('exit',()=>process.exit(0))});
      setInterval(()=>{},1000);
    `], { onLine: (line) => lines.push(line) });
    try {
      await ready(() => lines.includes('CHILD_READY'));
      await game.stop();
      expect((await game.result).code).toBe(0);
      expect(lines).toContain('CHILD_STOP');
      expect(lines).toContain('PARENT_STOP');
      expect(other.exitCode).toBeNull();
      expect(other.signalCode).toBeNull();
    } finally { await game.forceStop(); await game.cleanup(); other.kill('SIGTERM'); await once(other, 'close'); }
  });

  it('finishes after actual backend exit despite an inherited pipe and cleans its helper', async () => {
    const game = await spawnGameProcess(process.execPath, ['-e', `
      require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});
      console.log('BACKEND_DONE');process.exit(7);
    `], { outputDrainMs: 50 });
    try {
      expect((await game.result).code).toBe(7);
      expect(game.child.exitCode).toBe(7);
      await game.cleanup();
      expect(() => process.kill(-game.child.pid!, 0)).toThrow();
    } finally { await game.forceStop(); }
  });

  it('force-stops through the exact prefix control and kills a signal-resistant group', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nexus-game-stop-'));
    const marker = path.join(directory, 'prefix-control');
    const lines: string[] = [];
    const game = await spawnGameProcess(process.execPath, ['-e', "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});console.log('READY');setInterval(()=>{},1000)"], {
      onLine: (line) => lines.push(line),
    }, { stopPrefix: { command: process.execPath, args: ['-e', 'require("fs").writeFileSync(process.argv[1],"stopped")', marker] } });
    try {
      await ready(() => lines.includes('READY'));
      await game.forceStop();
      await game.result;
      expect(await readFile(marker, 'utf8')).toBe('stopped');
      expect(game.child.signalCode).toBe('SIGKILL');
    } finally { await game.cleanup(); await rm(directory, { recursive: true, force: true }); }
  });
});
