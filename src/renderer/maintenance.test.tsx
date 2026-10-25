import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { demoSnapshot } from '../shared/demo-data';
import { DiagnosticDialog, DownloadsPage, LibraryPage, SettingsPage, Sidebar, TopStatus } from './App';
it('has one sidebar queue entry below Settings', () => {
  const html = renderToStaticMarkup(<Sidebar data={demoSnapshot()} page="downloads" go={() => {}} />);
  expect(html.match(/class="queue-summary /g)).toHaveLength(1); expect(html.indexOf('Settings')).toBeLessThan(html.indexOf('Install Queue')); expect(html).toContain('aria-current="page"');
});
it('keeps backend health and launcher update notices distinct', () => {
  const data = demoSnapshot(); data.launcherUpdate!.latestVersion = '0.3.1';
  const html = renderToStaticMarkup(<TopStatus data={data} go={() => {}} />);
  expect(html).toContain('Update available'); expect(html).toContain('Xodus ready');
});
it('shows the offline verdict only while the backend itself is available', () => {
  const data = demoSnapshot(); data.connectivity = { state: 'offline', reason: 'No network interface is connected.' };
  const offline = renderToStaticMarkup(<TopStatus data={data} go={() => {}} />);
  expect(offline).toContain('status-dot amber'); expect(offline).toContain('>Offline<'); expect(offline).toContain('stored offline licenses');
  data.backend.available = false;
  const noBackend = renderToStaticMarkup(<TopStatus data={data} go={() => {}} />);
  expect(noBackend).toContain('status-dot red'); expect(noBackend).toContain('Backend offline'); expect(noBackend).not.toContain('>Offline<');
  data.backend.available = true; data.connectivity = { state: 'unknown' };
  expect(renderToStaticMarkup(<TopStatus data={data} go={() => {}} />)).toContain('Xodus ready');
});
it.each([
  [false, false, false], [true, false, false], [false, true, false], [false, false, true],
  [true, true, false], [true, false, true], [false, true, true], [true, true, true],
])('shows one update notice for launcher=%s backend=%s runtime=%s', (launcher, backend, runtime) => {
  const data = demoSnapshot();
  if (launcher) data.launcherUpdate!.latestVersion = '0.3.9';
  data.backend.releaseAvailable = true; data.backend.updateAvailable = backend; data.backend.releaseVersion = '0.2.9';
  data.runtime.nexusAvailable = true; data.runtime.nexusVersion = 'runtime-11.0-new';
  data.runtime.nexusName = 'xodus-nexus-runtime-11.0-new-x86_64.tar.xz';
  data.runtime.name = runtime ? 'xodus-nexus-runtime-11.0-old' : 'xodus-nexus-runtime-11.0-new';
  const html = renderToStaticMarkup(<TopStatus data={data} go={() => {}} />);
  expect(html.match(/class="update-notice"/g) ?? []).toHaveLength(launcher || backend || runtime ? 1 : 0);
  for (const [available, label] of [[launcher, 'Launcher 0.3.9'], [backend, 'Backend 0.2.9'], [runtime, 'Runtime 11.0-new']] as const) {
    if (available) expect(html).toContain(label); else expect(html).not.toContain(label);
  }
  expect(html).toContain('Xodus ready');
});
it('does not advertise failed, incomplete or already installed component releases', () => {
  const data = demoSnapshot();
  data.backend.releaseAvailable = false; data.backend.updateAvailable = true;
  data.runtime.nexusAvailable = false; data.runtime.nexusName = 'future-x86_64.tar.xz';
  const render = () => renderToStaticMarkup(<TopStatus data={data} go={() => {}} />);
  expect(render()).not.toContain('update-notice');
  data.runtime.nexusAvailable = true; data.runtime.nexusName = undefined;
  expect(render()).not.toContain('update-notice');
});
it('preserves the launcher restart notice while listing pending backend and runtime updates', () => {
  const data = demoSnapshot(); data.launcherUpdate!.restartRequired = true;
  data.backend.updateAvailable = true; data.backend.releaseAvailable = true; data.backend.releaseVersion = '0.2.9';
  data.runtime.nexusAvailable = true; data.runtime.nexusName = 'xodus-nexus-runtime-next-x86_64.tar.xz';
  const html = renderToStaticMarkup(<TopStatus data={data} go={() => {}} />);
  expect(html).toContain('Restart available'); expect(html).toContain('Restart to finish launcher update.');
  expect(html).toContain('Backend 0.2.9'); expect(html).toContain('Runtime'); expect(html).not.toContain('undefined');
});
it('offers verified in-app install with independent backend version labels', () => {
  const data = demoSnapshot(); data.launcherUpdate = { currentVersion: '9.0.0', checking: false, latestVersion: '9.0.1', canInstall: true }; data.backend.version = '0.2.1';
  const html = renderToStaticMarkup(<SettingsPage data={data} toast={() => {}} />);
  expect(html).toContain('Install launcher update'); expect(html).toContain('Nexus backend 0.2.1'); expect(html).not.toContain('Backend updates are versioned independently');
});
it('shows game update badges and a separate version-check action', () => {
  const data = demoSnapshot(); data.gameUpdates = { [data.games[0].id]: { checking: false, available: true, latestVersion: '1.10.0.0' } };
  const html = renderToStaticMarkup(<LibraryPage data={data} selection={{ id: data.games[0].id }} toast={() => {}} />);
  expect(html).toContain('Update available'); expect(html).toContain('Update game'); expect(html).toContain('Check game updates');
});
it('renders diagnostic logs as escaped text rather than executable HTML', () => {
  const html = renderToStaticMarkup(<DiagnosticDialog log={{ name: 'game.log', content: '<script>bad()</script>', truncated: true }} close={() => {}} />);
  expect(html).not.toContain('<script>'); expect(html).toContain('&lt;script&gt;'); expect(html).toContain('512 KiB');
  expect(html).toContain('Copy log'); expect(html).not.toContain('Copy excerpt');
  expect(html).toContain('Copy log copies the complete file');
});
it('offers a complete game log without changing untruncated backend copies', () => {
  const html = renderToStaticMarkup(<DiagnosticDialog log={{ name: 'game.log', content: 'full text', truncated: false }} close={() => {}} revealFile={async () => {}} />);
  expect(html).toContain('Show log file'); expect(html).toContain('Copy log');
  expect(html).not.toContain('Copy excerpt'); expect(html).not.toContain('512 KiB');
});
it('offers Resume and Cancel for paused downloads, without treating them as finished', () => {
  const data = demoSnapshot();
  data.downloads = [{ id:'paused', title:'Game', destination:'/tmp/demo', productId:'TEST', status:'paused',
    canPause:true, progress:25, phase:'Paused', log:[], startedAt:'today' }];
  const html = renderToStaticMarkup(<DownloadsPage data={data} toast={() => {}} />);
  expect(html).toContain('Resume download'); expect(html).toContain('Cancel download');
  expect(html).not.toContain('Clear finished'); expect(html).not.toContain('Remove from queue');
  expect(html).not.toContain('util-linux');
});
