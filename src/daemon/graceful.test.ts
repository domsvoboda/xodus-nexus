import { describe, expect, it, vi } from 'vitest';
import { closeGracefully, type Closable } from './graceful.js';

function game(exitAfter: { close?: number; stop?: number }) {
  let finish!: () => void;
  const result = new Promise<void>(resolve => { finish = resolve; });
  const closable: Closable & { stops: number; forces: number; finish(): void } = {
    result, stops: 0, forces: 0, finish,
    stop: async () => { closable.stops++; if (exitAfter.stop !== undefined) setTimeout(finish, exitAfter.stop); },
    forceStop: async () => { closable.forces++; finish(); },
  };
  return closable;
}

describe('closeGracefully', () => {
  it('asks the window to close and waits for the runtime to exit on its own', async () => {
    const target = game({});
    const run = vi.fn(async (_file: string, args: string[]) => { expect(args).toEqual(['--launch-id', 'game-1', '--timeout-ms', '5000']); setTimeout(target.finish, 10); return 0; });
    const log: string[] = [];
    const outcome = await closeGracefully(target, 'game-1', { helper: '/opt/nexus-close-window', env: { DISPLAY: ':0' }, log: line => log.push(line), run, closeWaitMs: 500 });
    expect(outcome).toBe('closed');
    expect(run).toHaveBeenCalledWith('/opt/nexus-close-window', expect.any(Array), { DISPLAY: ':0' });
    expect(target.stops).toBe(0);
    expect(target.forces).toBe(0);
  });

  it('falls back to the interrupt when the window ignores the request, then to force', async () => {
    const ignoring = game({ stop: 10 });
    const run = vi.fn(async () => 0);
    expect(await closeGracefully(ignoring, 'game-1', { helper: '/h', env: {}, log: () => {}, run, closeWaitMs: 30, stopWaitMs: 500 })).toBe('stopped');
    expect(ignoring.stops).toBe(1);
    expect(ignoring.forces).toBe(0);

    const stubborn = game({});
    expect(await closeGracefully(stubborn, 'game-1', { helper: '/h', env: {}, log: () => {}, run, closeWaitMs: 20, stopWaitMs: 20 })).toBe('forced');
    expect(stubborn.stops).toBe(1);
    expect(stubborn.forces).toBe(1);
  });

  it('skips the helper when none is bundled or when it finds no window', async () => {
    const log: string[] = [];
    const quick = game({ stop: 0 });
    expect(await closeGracefully(quick, 'game-1', { env: {}, log: line => log.push(line), stopWaitMs: 500 })).toBe('stopped');
    expect(log[0]).toContain('No close helper');
    const noWindow = game({ stop: 0 });
    const run = vi.fn(async () => 1);
    expect(await closeGracefully(noWindow, 'game-1', { helper: '/h', env: {}, log: line => log.push(line), run, stopWaitMs: 500 })).toBe('stopped');
    expect(log.some(line => line.includes('No game window'))).toBe(true);
  });
});
