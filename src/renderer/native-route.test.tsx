import {Writable} from 'node:stream';
import {renderToPipeableStream} from 'react-dom/server';
import {expect, it, vi} from 'vitest';
import {NativeRoute} from './NativeRoute';

const loaded = vi.hoisted(() => ({chat: 0, party: 0}));
vi.mock('./App', () => ({default: () => <main>Launcher</main>}));
vi.mock('./native-windows/chat', () => {
  loaded.chat++;
  return {render: ({route}:{route:string}) => <main>Chat {route}</main>};
});
vi.mock('./native-windows/party', () => {
  loaded.party++;
  return {render: () => <main>Party</main>};
});

function render(route:string):Promise<string> {
  return new Promise((resolve, reject) => {
    let html = '';
    const sink = new Writable({write(chunk, _encoding, done) {html += chunk.toString(); done();}});
    sink.on('finish', () => resolve(html));
    sink.on('error', reject);
    const stream = renderToPipeableStream(<NativeRoute route={route}/>, {
      onAllReady() {stream.pipe(sink);},
      onError: reject,
    });
  });
}

it('loads only the selected native window, while invalid hashes retain the launcher', async () => {
  for (const route of ['', '#library', '#xbox-chat=0', '#xbox-chat=-1', '#xbox-chat=01',
    '#xbox-chat=123456789012345678901', '#xbox-chat=1&extra', '#xbox-media-extra']) {
    expect(await render(route)).toContain('Launcher');
  }
  expect(loaded).toEqual({chat: 0, party: 0});
  expect(await render('#xbox-chat=12345678901234567890')).toContain('12345678901234567890');
  expect(loaded).toEqual({chat: 1, party: 0});
  expect(await render('#xbox-chat=2')).toContain('#xbox-chat=2');
  expect(loaded).toEqual({chat: 1, party: 0});
  expect(await render('#xbox-media')).toContain('Party');
  expect(loaded).toEqual({chat: 1, party: 1});
  expect(await render('#library')).toContain('Launcher');
});
