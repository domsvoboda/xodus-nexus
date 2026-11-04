import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { gameSteamPortrait, nexusSteamArtwork } from './steam-artwork.js';

const { windows } = vi.hoisted(() => ({ windows: [] as any[] }));
vi.mock('electron', () => ({ BrowserWindow: class {
  options: any;
  setContentSize = vi.fn();
  loadURL = vi.fn(async () => {});
  destroy = vi.fn();
  webContents = { executeJavaScript: vi.fn(async () => {}), capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from('image') })) };
  constructor(options: any) { this.options = options; windows.push(this); }
} }));
beforeEach(() => { windows.length = 0; });
afterEach(() => vi.useRealTimers());
it('letterboxes a square game cover into only the portrait slot without stretching or changing wide artwork', async () => {
  await gameSteamPortrait(Buffer.from('square game cover'));
  const window = windows[0];
  expect(window.setContentSize.mock.calls).toEqual([[600, 900]]);
  const html = decodeURIComponent(window.loadURL.mock.calls[0][0]);
  expect(html).toContain('object-fit:contain');
  expect(html).toContain('filter:blur(35px)');
  expect(html).toContain(Buffer.from('square game cover').toString('base64'));
  expect(window.destroy).toHaveBeenCalledOnce();
});
it('renders separate portrait/wide brand layouts in a hidden sandbox, with no remote content', async () => {
  const result = await nexusSteamArtwork(Buffer.from('bundled icon'));
  expect(result.cover).toEqual(Buffer.from('image'));
  expect(result.wide).toEqual(Buffer.from('image'));
  const window = windows[0];
  expect(window.options).toMatchObject({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true } });
  expect(window.setContentSize.mock.calls).toEqual([[600, 900], [1280, 720]]);
  for (const [url] of window.loadURL.mock.calls) {
    const html = decodeURIComponent(url.slice('data:text/html;charset=utf-8,'.length));
    expect(html).toContain("default-src 'none'; img-src data:");
    expect(html).toContain('<h1>NEXUS</h1>');
    expect(html).not.toContain('XODUS NEXUS');
    expect(html).not.toMatch(/https?:|<script/);
    expect(html).toContain(Buffer.from('bundled icon').toString('base64'));
  }
  expect(window.destroy).toHaveBeenCalledOnce();
});
it('destroys its hidden window when capture fails', async () => {
  const result = nexusSteamArtwork(Buffer.from('icon'));
  windows[0].webContents.capturePage.mockRejectedValue(Error('capture failed'));
  await expect(result).rejects.toThrow('capture failed');
  expect(windows[0].destroy).toHaveBeenCalledOnce();
});
it('bounds a stuck renderer and releases its hidden window', async () => {
  vi.useFakeTimers();
  const result = nexusSteamArtwork(Buffer.from('icon'));
  windows[0].webContents.executeJavaScript.mockImplementation(() => new Promise(() => {}));
  const rejected = expect(result).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
  expect(windows[0].destroy).toHaveBeenCalledOnce();
});
