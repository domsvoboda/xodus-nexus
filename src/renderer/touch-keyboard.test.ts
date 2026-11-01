// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installTouchKeyboard } from './touch-keyboard';
import { gamepadHarness } from './gamepad-test-harness';

let harness: ReturnType<typeof gamepadHarness>;
let field: HTMLInputElement;
let stop: () => void;
let show: ReturnType<typeof vi.fn>;
let listeners: Map<string, (event: unknown) => void>;
beforeEach(() => {
  harness = gamepadHarness();
  document.body.innerHTML = '<input type="search" value="kept" data-test-rect="20,600,300,40">';
  field = document.querySelector('input')!;
  show = vi.fn(async () => true);
  const listen = vi.spyOn(window, 'addEventListener');
  stop = installTouchKeyboard(window, show);
  listeners = new Map(listen.mock.calls.map(([name, handler]) => [name, handler as (event: unknown) => void]));
});
afterEach(() => { stop(); vi.restoreAllMocks(); document.body.innerHTML = ''; });
const fire = (name = 'pointerup', patch = {}) => listeners.get(name)!({ isTrusted: true, pointerType: 'touch', target: field, ...patch });

it('handles native touch release even if its compatibility click has no pointerType', () => {
  fire(); // Focus is applied by the browser after the event handler.
  field.focus(); fire('click', { pointerType: undefined }); harness.step();
  expect(show).toHaveBeenCalledOnce();
  expect(show).toHaveBeenCalledWith({ x: 20, y: 600, width: 300, height: 40, mode: 0 });
  expect(field.value).toBe('kept'); expect(document.activeElement).toBe(field);
});

it('coalesces a native touch/pen release and click into one request', () => {
  field.focus(); fire('pointerup', { pointerType: 'pen' }); fire('click', { pointerType: 'pen' }); harness.step();
  expect(show).toHaveBeenCalledOnce();
});

it('ignores synthetic events, mouse clicks, non-text fields and fields no longer focused', () => {
  field.focus();
  for (const patch of [{ isTrusted: false }, { pointerType: 'mouse' }, { target: null }]) fire('pointerup', patch);
  field.type = 'checkbox'; fire(); field.type = 'search';
  fire(); field.blur(); harness.step(); expect(show).not.toHaveBeenCalled();
});

it('rejects disabled, readonly, inert, removed and zero-sized fields', () => {
  field.focus(); field.disabled = true; fire(); field.disabled = false;
  field.readOnly = true; fire(); field.readOnly = false;
  field.inert = true; fire(); field.inert = false;
  field.dataset.testRect = '0,0,0,0'; fire(); harness.step();
  field.remove(); fire(); harness.step(); expect(show).not.toHaveBeenCalled();
});

it('cancels pending requests on pointer cancellation or uninstall', () => {
  field.focus(); fire(); fire('pointercancel'); harness.step(); expect(show).not.toHaveBeenCalled();
  fire(); stop(); harness.step(); expect(show).not.toHaveBeenCalled();
});

it.each([['textarea', undefined, 1], ['input', 'email', 2], ['input', 'number', 3], ['input', 'password', 0]] as const)('chooses the appropriate mode for %s %s', (tag, type, mode) => {
  const next = document.createElement(tag); if (type) (next as HTMLInputElement).type = type;
  document.body.append(next); next.focus(); fire('pointerup', { target: next }); harness.step();
  expect(show).toHaveBeenCalledWith(expect.objectContaining({ mode }));
});
