import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OutputTail } from './output-tail.js';

describe('OutputTail', () => {
  let root: string;
  let file: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-tail-')); file = path.join(root, 'out'); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('emits complete lines without ANSI, then the trailing partial line on drain', async () => {
    await fs.writeFile(file, '');
    const lines: string[] = [];
    const tail = new OutputTail(file, line => lines.push(line), { from: 0, pollMs: 10 }).start();
    await fs.appendFile(file, '\x1b[31mred\x1b[0m\r\nsecond\npar');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(lines).toEqual(['red', 'second']);
    await fs.appendFile(file, 'tial');
    await tail.drain();
    expect(lines).toEqual(['red', 'second', 'partial']);
  });

  it('starts at the end of the file when no offset is given', async () => {
    await fs.writeFile(file, 'old line\n');
    const lines: string[] = [];
    const tail = new OutputTail(file, line => lines.push(line), { pollMs: 10 }).start();
    await new Promise(resolve => setTimeout(resolve, 30));
    await fs.appendFile(file, 'new line\n');
    await tail.drain();
    expect(lines).toEqual(['new line']);
  });

  it('truncates the file once it has read past the rotation size, and keeps following', async () => {
    await fs.writeFile(file, '');
    const lines: string[] = [];
    const tail = new OutputTail(file, line => lines.push(line), { from: 0, pollMs: 10, rotateBytes: 8 }).start();
    await fs.appendFile(file, 'abcdefghij\n');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect((await fs.stat(file)).size).toBe(0);
    await fs.appendFile(file, 'after\n');
    await tail.drain();
    expect(lines).toEqual(['abcdefghij', 'after']);
  });
});
