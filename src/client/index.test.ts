import { describe, expect, it } from 'vitest';
import { showLaunchError } from './index.js';

describe('thin client launch errors', () => {
  it('opens no dialog without a display, so headless runs only print the error', async () => {
    const started = Date.now();
    await showLaunchError(undefined, 'refused', { PATH: process.env.PATH });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
