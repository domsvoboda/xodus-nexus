import { vi } from 'vitest';

/** jsdom has no layout or controller hardware. Supply explicit rectangles and
 * advance the real polling loop one frame at a time, without timers. */
export function gamepadHarness() {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0, time = 0;
  const pad = { index: 0, id: 'test pad', connected: true, mapping: 'standard', buttons: [] as { pressed: boolean; value: number }[], axes: [0, 0, 0, 0] };
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++frameId, callback); return frameId; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} });
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [] });
  vi.spyOn(navigator, 'getGamepads').mockReturnValue([pad as unknown as Gamepad]);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const [x = 300, y = 100, width = 100, height = 40] = (this.dataset.testRect ?? '').split(',').filter(Boolean).map(Number);
    return { x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON() {} };
  });
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    return [this.getBoundingClientRect()] as unknown as DOMRectList;
  });
  // inert is implemented by Chromium, but not jsdom 24.
  Object.defineProperty(HTMLElement.prototype, 'inert', { configurable: true, get() { return this.hasAttribute('inert'); }, set(value: boolean) { this.toggleAttribute('inert', value); } });
  function step(buttons: number[] = [], axes = [0, 0, 0, 0]) {
    pad.buttons = Array.from({ length: 17 }, (_, index) => ({ pressed: buttons.includes(index), value: Number(buttons.includes(index)) }));
    pad.axes = axes;
    time += 16;
    const pending = [...frames.values()]; frames.clear();
    pending.forEach(callback => callback(time));
  }
  return { step, press(button: number) { step([button]); step(); }, pending: () => frames.size };
}
