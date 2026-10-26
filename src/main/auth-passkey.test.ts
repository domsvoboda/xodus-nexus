import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const preload = ts.transpileModule(readFileSync('src/preload/auth.cts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(original: (this: unknown, options?: any) => unknown, hostname = 'login.live.com', invoke = vi.fn(async () => ({ ok: true })), strings?: Record<string,string>) {
  const scripts: string[] = [];
  let exposed: unknown;
  const window = { top: null as unknown, addEventListener: vi.fn() }; window.top = window;
  vm.runInNewContext(preload, { exports: {}, window, process:{argv:strings?['--nexus-auth-ui='+JSON.stringify(strings)]:[]}, location: { protocol: 'https:', port: '', hostname },
    require: () => ({ contextBridge: { exposeInMainWorld: (_name: string, value: unknown) => { exposed = value; } },
      ipcRenderer: { send: vi.fn(), invoke }, webFrame: { executeJavaScript: (script: string) => { scripts.push(script); return Promise.resolve(); } } }),
  });
  const panels: any[] = [];
  const listeners = new Map<string, () => void>();
  const timers = new Map<number, { callback: () => void; at: number }>();
  let time = 0, sequence = 0;
  const document = {
    body: { appendChild: (panel: any) => { panel.connected = true; panels.push(panel); } } as { appendChild(panel: any): void } | null,
    addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
    createElement: () => {
      const button = { click: undefined as (() => void) | undefined, addEventListener: (_name: string, callback: () => void) => { button.click = callback; } };
      const browser = { disabled: false, click: undefined as (() => Promise<void>) | undefined, addEventListener: (_name: string, callback: () => Promise<void>) => { browser.click = callback; } };
      const error = { hidden: true, textContent: '' };
      const heading={textContent:''};
      const shadow = { innerHTML: '', querySelector: (selector: string) => selector === 'h2' ? heading : selector === '[data-browser]' ? browser : selector === '.error' ? error : button };
      return { connected: false, button, browser, error, heading, shadow, style: {}, setAttribute() {}, attachShadow: () => shadow,
        remove() { this.connected = false; } };
    },
  };
  const credentials = { get: original };
  if (scripts.length) vm.runInNewContext(scripts[0], {
    navigator: { credentials }, document, window, external: {}, __nexusAuth: exposed, AbortController,
    setTimeout: (callback: () => void, ms: number) => { timers.set(++sequence, { callback, at: time + ms }); return sequence; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  return { credentials, scripts, panels, document, listeners, invoke,
    advance(ms: number) { time += ms; for (const [id, timer] of timers) if (timer.at <= time) { timers.delete(id); timer.callback(); } },
  };
}
const pending = function (options: any) { return new Promise((_resolve, reject) => {
  if (options.signal.aborted) reject(options.signal.reason);
  else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
}); };

describe('dedicated auth preload passkey control', () => {
  it('inserts translated launcher controls as plain text without changing sign-in requests', async () => {
    const caller=new AbortController(),test=fixture(pending,'login.live.com',vi.fn(async()=>({ok:false})),{title:'<img src=x>',error:'Prohlížeč není dostupný.'});
    const result=test.credentials.get({publicKey:{},signal:caller.signal});const rejection=expect(result).rejects.toMatchObject({name:'AbortError'});
    test.advance(4000);expect(test.panels[0].heading.textContent).toBe('<img src=x>');expect(test.panels[0].shadow.innerHTML).not.toContain('<img src=x>');
    await test.panels[0].browser.click();expect(test.panels[0].error.textContent).toBe('Prohlížeč není dostupný.');
    expect(caller.signal.aborted).toBe(false);caller.abort();await rejection;
  });
  it('only requests browser fallback after an explicit click, without changing WebAuthn verification', async () => {
    const caller = new AbortController(), test = fixture(pending);
    const result = test.credentials.get({ publicKey: {}, signal: caller.signal });
    const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    test.advance(60_000); expect(test.invoke).not.toHaveBeenCalled();
    expect(test.panels[0].shadow.innerHTML).toContain('Continue in browser');
    expect(test.panels[0].shadow.innerHTML).toContain('passkey or security key');
    await test.panels[0].browser.click(); expect(test.invoke).toHaveBeenCalledWith('nexus-auth:browser');
    expect(caller.signal.aborted).toBe(false); caller.abort(); await rejection;
  });
  it('keeps the pending request available if Chrome is missing', async () => {
    const invoke = vi.fn(async () => ({ ok: false })), caller = new AbortController();
    const test = fixture(pending, 'login.live.com', invoke);
    const result = test.credentials.get({ publicKey: {}, signal: caller.signal });
    const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    test.advance(4000); await test.panels[0].browser.click();
    expect(test.panels[0].error.hidden).toBe(false); expect(test.panels[0].error.textContent).toContain('Google Chrome');
    expect(test.panels[0].browser.disabled).toBe(false); expect(caller.signal.aborted).toBe(false);
    caller.abort(); await rejection;
  });
  it('never installs on an untrusted origin', () => {
    const original = vi.fn(); const test = fixture(original, 'example.invalid');
    expect(test.scripts).toEqual([]); expect(test.credentials.get).toBe(original);
  });
  it('leaves non-passkey requests and their receiver unchanged', async () => {
    const value = { synthetic: 'opaque-result' }, options = { mediation: 'optional' };
    let receiver: unknown;
    const original = vi.fn(function (this: unknown) { receiver = this; return Promise.resolve(value); });
    const test = fixture(original);
    expect(await test.credentials.get(options)).toBe(value);
    expect(original).toHaveBeenCalledWith(options); expect(receiver).toBe(test.credentials);
    test.advance(10_000); expect(test.panels).toEqual([]);
  });
  it('offers manual cancellation only after four seconds, without cancelling the caller signal', async () => {
    const test = fixture(pending); const caller = new AbortController();
    const result = test.credentials.get({ publicKey: {}, signal: caller.signal }) as Promise<unknown>;
    const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    test.advance(3999); expect(test.panels).toHaveLength(0);
    test.advance(1); expect(test.panels).toHaveLength(1);
    expect(test.panels[0].shadow.innerHTML).toContain('Cancel passkey request');
    test.panels[0].button.click(); await rejection;
    expect(caller.signal.aborted).toBe(false); expect(test.panels[0].connected).toBe(false);
  });
  it('does not auto-cancel a slow request', async () => {
    let signal: AbortSignal | undefined;
    const test = fixture(function (options) { signal = options.signal; return pending(options); });
    const result = test.credentials.get({ publicKey: {} }) as Promise<unknown>;
    const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    test.advance(60_000); expect(signal?.aborted).toBe(false);
    test.panels[0].button.click(); await rejection;
  });
  it('preserves an original cancellation reason and cleans up the control', async () => {
    const test = fixture(pending); const caller = new AbortController();
    const result = test.credentials.get({ publicKey: {}, signal: caller.signal });
    const reason = Error('synthetic caller cancellation');
    const rejection = expect(result).rejects.toBe(reason);
    test.advance(4000); caller.abort(reason); await rejection;
    expect(test.panels[0].connected).toBe(false);
  });
  it('preserves native results and inherited options without leaving a panel', async () => {
    const value = { synthetic: 'opaque-result' }; let received: any;
    const test = fixture(function (options) { received = options; return Promise.resolve(value); });
    const key = {}; const options = Object.assign(Object.create({ mediation: 'optional' }), { publicKey: key });
    expect(await test.credentials.get(options)).toBe(value);
    expect(received.publicKey).toBe(key); expect(received.mediation).toBe('optional');
    expect(options.signal).toBeUndefined(); test.advance(4000); expect(test.panels).toHaveLength(0);
  });
  it('handles synchronous native errors and malformed signals without intercepting validation', () => {
    const error = Error('synthetic native validation'); const original = vi.fn(() => { throw error; });
    const test = fixture(original);
    expect(() => test.credentials.get({ publicKey: {} })).toThrow(error);
    const options = { publicKey: {}, signal: {} };
    expect(() => test.credentials.get(options)).toThrow(error);
    expect(original).toHaveBeenLastCalledWith(options);
    test.advance(4000); expect(test.panels).toHaveLength(0);
  });
  it('cancels concurrent requests without hiding an unrelated active one early', async () => {
    let resolveFirst: (value: null) => void = () => {}; let count = 0;
    const test = fixture(function (options) { return ++count === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : pending(options); });
    const first = test.credentials.get({ publicKey: {} });
    const second = test.credentials.get({ publicKey: {} }) as Promise<unknown>;
    const rejection = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    test.advance(4000); resolveFirst(null); await first;
    expect(test.panels[0].connected).toBe(true);
    test.panels[0].button.click(); await rejection;
    expect(test.panels[0].connected).toBe(false);
  });
  it('waits for a body when the request starts during document parsing', async () => {
    const test = fixture(pending); const body = test.document.body; test.document.body = null;
    const result = test.credentials.get({ publicKey: {} }) as Promise<unknown>;
    const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    test.advance(4000); expect(test.panels).toHaveLength(0);
    test.document.body = body; test.listeners.get('DOMContentLoaded')!();
    expect(test.panels).toHaveLength(1); test.panels[0].button.click(); await rejection;
  });
});
