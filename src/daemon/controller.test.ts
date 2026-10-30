import { describe, expect, it } from 'vitest';
import { daemonMarket } from './controller.js';

describe('daemonMarket', () => {
  it('keeps a configured market and takes a neutral one from the session locale', () => {
    expect(daemonMarket('GB', { LANG: 'de_DE.UTF-8' })).toBe('GB');
    expect(daemonMarket('neutral', { LANG: 'de_DE.UTF-8' })).toBe('DE');
    expect(daemonMarket('Neutral', { LC_ALL: 'fr_CA.UTF-8', LANG: 'en_US.UTF-8' })).toBe('CA');
    expect(daemonMarket('neutral', { LANG: 'C.UTF-8' })).toBe('US');
    expect(daemonMarket('neutral', {})).toBe('US');
  });
});
