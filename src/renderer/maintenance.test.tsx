import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { demoSnapshot } from '../shared/demo-data';
import { DiagnosticDialog, DownloadsPage, LibraryPage, SettingsPage, Sidebar, TopStatus } from './App';
it('has one sidebar queue entry below Settings', () => {
  const html = renderToStaticMarkup(<Sidebar data={demoSnapshot()} page="downloads" go={() => {}} />);
  expect(html.match(/class="queue-summary /g)).toHaveLength(1); expect(html.indexOf('Settings')).toBeLessThan(html.indexOf('Install Queue')); expect(html).toContain('aria-current="page"');
});
it('keeps Social out of the sidebar now that Friends has its own dock',()=>{
  const html=renderToStaticMarkup(<Sidebar data={demoSnapshot()} page="social" go={()=>{}}/>);
  expect(html).not.toContain('Xbox Social');expect(html).toContain('Settings');
});
it('offers an app-owned overlay shortcut and left/right shelf settings with left as the default',()=>{
  const html=renderToStaticMarkup(<SettingsPage data={demoSnapshot()} toast={()=>{}}/>);
  expect(html).toContain('Keyboard shortcut');expect(html).toContain('Super+G');expect(html).toContain('Shelf position');expect(html).toContain('value="left" selected');
  expect(html.indexOf('Storage and launch paths')).toBeLessThan(html.indexOf('aria-label="Nexus Overlay"'));
  expect(html).toMatch(/<details class="settings-card settings-guide" aria-label="Nexus Overlay">/);
  expect(html).not.toContain('Desktop portal');
});
it('shows one update action without a permanent ready badge or duplicate settings control', () => {
  const data = demoSnapshot(); data.launcherUpdate!.latestVersion = '0.3.1';
  const html = renderToStaticMarkup(<TopStatus data={data} go={() => {}} />);
  expect(html).toContain('Update available'); expect(html).toContain('Launcher 0.3.1');
  expect(html).not.toContain('Xodus ready'); expect(html).not.toContain('status-dot');
  expect(html.match(/<button/g) ?? []).toHaveLength(1);
});
it('leaves the decluttered header empty while the backend is reachable, offline or unavailable', () => {
  const data = demoSnapshot(); data.connectivity = { state: 'offline', reason: 'No network interface is connected.' };
  expect(renderToStaticMarkup(<TopStatus data={data} go={() => {}} />)).toBe('');
  data.backend.available = false;
  expect(renderToStaticMarkup(<TopStatus data={data} go={() => {}} />)).toBe('');
  data.backend.available = true; data.connectivity = { state: 'unknown' };
  expect(renderToStaticMarkup(<TopStatus data={data} go={() => {}} />)).toBe('');
});
const managedRuntimeUpdate = (id: 'nexus' | 'nexus-cachyos') => ({
  id, checking: false, installing: false, version: 'runtime-10.0', channel: 'stable' as const, updateAvailable: true,
  installed: { id, label: id === 'nexus' ? 'Standard' : 'CachyOS', buildId: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), manifestSha256: 'c'.repeat(64) },
  available: { version: id === 'nexus' ? 'runtime-11.0-new' : 'runtime-cachyos-11.0-new', candidateSha256: 'd'.repeat(64), sourceCommit: 'e'.repeat(40), archiveName: 'runtime.tar.xz', requiresBackendVersion: '0.2.3', requiresLauncherVersion: '0.5.0' },
});
it.each([
  [false, false, false], [true, false, false], [false, true, false], [false, false, true],
  [true, true, false], [true, false, true], [false, true, true], [true, true, true],
])('shows one update notice for launcher=%s backend=%s runtime=%s', (launcher, backend, runtime) => {
  const data = demoSnapshot();
  if (launcher) data.launcherUpdate!.latestVersion = '0.3.9';
  data.backend.releaseAvailable = true; data.backend.updateAvailable = backend; data.backend.releaseVersion = '0.2.9';
  data.runtime.managedFamilies = runtime ? [managedRuntimeUpdate('nexus')] : [];
  const html = renderToStaticMarkup(<TopStatus data={data} go={() => {}} />);
  expect(html.match(/class="update-notice"/g) ?? []).toHaveLength(launcher || backend || runtime ? 1 : 0);
  for (const [available, label] of [[launcher, 'Launcher 0.3.9'], [backend, 'Backend 0.2.9'], [runtime, 'Standard 11.0-new']] as const) {
    if (available) expect(html).toContain(label); else expect(html).not.toContain(label);
  }
});
it('advertises only managed family updates and never the legacy global pointer', () => {
  const data = demoSnapshot();
  data.runtime = { ...data.runtime, installed: true,
    name: 'nexus-runtime-cachyos-11.0-experimental-ge36f73cb-local',
    nexusAvailable: true, nexusVersion: 'runtime-11.0-new', nexusName: 'nexus-runtime-11.0-new-x86_64.tar.xz' };
  expect(renderToStaticMarkup(<TopStatus data={data} go={() => {}} />)).not.toContain('update-notice');
  data.runtime.managedFamilies = [managedRuntimeUpdate('nexus-cachyos')];
  const cachy = renderToStaticMarkup(<TopStatus data={data} go={() => {}} />);
  expect(cachy).toContain('update-notice');
  expect(cachy).toContain('CachyOS 11.0-new');
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
  data.runtime.managedFamilies = [managedRuntimeUpdate('nexus')];
  const html = renderToStaticMarkup(<TopStatus data={data} go={() => {}} />);
  expect(html).toContain('Restart available'); expect(html).toContain('Restart to finish launcher update.');
  expect(html).toContain('Backend 0.2.9'); expect(html).toContain('Standard 11.0-new'); expect(html).not.toContain('undefined');
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
