import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { demoSnapshot } from '../shared/demo-data';
import { SettingsPage } from './App';

describe('Settings diagnostics', () => {
  it('uses a neutral Wine / Proton binary label and preserves a custom runtime path', () => {
    const data = demoSnapshot();
    data.settings.winePath = '/runtime/nexus-runtime-11.0-experimental/files/bin/wine';
    const html = renderToStaticMarkup(<SettingsPage data={data} toast={() => {}} />);
    expect(html).toContain('Wine / Proton binary');
    expect(html).toContain(`value="${data.settings.winePath}"`);
    expect(html).not.toContain('Wine / Xodus Proton binary');
  });
  it('explains that explicit sign-out also removes the local device registration', () => {
    const html = renderToStaticMarkup(<SettingsPage data={demoSnapshot()} toast={() => {}} />);
    expect(html).toContain('title="Remove saved sign-in credentials and local device registration. Games and saves are kept."');
    expect(html).toContain('Sign out');
    expect(html).toContain('Sign in again');
  });
  it('does not call an unpublished development build the latest published release', () => {
    const html = renderToStaticMarkup(<SettingsPage data={demoSnapshot()} toast={() => {}} />);
    expect(html).toContain(`<h2>${demoSnapshot().launcherUpdate?.currentVersion}</h2>`);
    expect(html).not.toContain('latest published release');
    expect(html).not.toContain('Check GitHub for launcher updates.');
  });
  it('keeps technical details in a closed disclosure, without a CLI command list', () => {
    const html = renderToStaticMarkup(<SettingsPage data={demoSnapshot()} toast={() => {}} />);
    const details = html.match(/<details\b[^>]*class="settings-card settings-diagnostics"[^>]*>[\s\S]*?<\/details>/)?.[0];
    expect(details).toBeDefined();
    expect(details?.split('>')[0]).not.toMatch(/\bopen\b/);
    expect(details).not.toContain('COMMIT');
    expect(details).not.toContain('Backend details');
    expect(details).not.toContain('Runtime details');
    expect(details).toContain('Detailed game logs');
    expect(details).toContain('Save diagnostics');
    expect(details).not.toContain('Build dependencies');
    expect(details).not.toContain('Build backend from source');
    expect(details).not.toContain('Install upstream snapshot');
    expect(details).not.toContain('Check upstream snapshot');
    const main = html.replace(details!, '');
    expect(main).not.toContain('Build dependencies');
    expect(main).not.toContain('Detailed game logs');
    expect(main).not.toContain('PROTON HEAD');
    expect(main).not.toContain('Install upstream snapshot');
    expect(main).not.toContain('Official GitHub Actions snapshot');
    expect(main).not.toContain('Build backend from source');
    expect(main).not.toContain('Rebuild backend');
    expect(main).not.toContain('Install / update backend');
    expect(html).not.toContain('External Xodus source');
    expect(html).not.toContain('CachyOS binary');
    expect(main).toContain('Standard runtime');
    expect(main).toContain('Open backend diagnostic log');
    expect(main).toContain('No passwords, tokens or account contents');
    expect(main).not.toContain('Install Nexus runtime');
    expect(html).not.toContain('Advertised commands');
  });
  it('shows each managed family independently and never promotes the legacy pointer to a family', () => {
    const data = demoSnapshot();
    data.runtime.name = 'xodus-proton-7c0b4354';
    data.runtime.managedFamilies = [{
      id: 'nexus', checking: false, installing: false, version: 'runtime-10.0', channel: 'stable', updateAvailable: false,
      installed: { id: 'nexus', label: 'Standard', buildId: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), manifestSha256: 'c'.repeat(64) },
    }];
    data.backend.releaseAvailable = false;
    data.backend.blockReason = 'No compatible Nexus backend release has been published yet.';
    const html = renderToStaticMarkup(<SettingsPage data={data} toast={() => {}} />);
    expect(html).toContain('Standard runtime');
    expect(html).toContain('Installed: runtime-10.0');
    expect(html).toContain(data.backend.blockReason);
    expect(html).not.toContain('Active: Xodus Proton runtime');
    expect(html).not.toContain('OTHER RUNTIME');
    expect(html).not.toContain('Install / update backend');
  });
  it('keeps actionable errors visible and unsupported sign-in disabled', () => {
    const data = demoSnapshot();
    data.backend.capabilities.login = false;
    data.backend.blockReason = 'The prebuilt backend could not start on this system.';
    data.runtime.managedFamilies = [{ id: 'nexus-cachyos', checking: false, installing: false, error: 'SHA-512 verification failed.' }];
    const html = renderToStaticMarkup(<SettingsPage data={data} toast={() => {}} />);
    const main = html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/, '');
    expect(main).toContain(data.backend.blockReason);
    expect(main).toContain('SHA-512 verification failed.');
    expect(main).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Sign in again<\/button>/);
  });
});


it('shows Standard and CachyOS managed runtime cards with independent versions and no binary path detail',()=>{
  const data = demoSnapshot();
  data.runtime.managedFamilies = [
    { id: 'nexus', checking: false, installing: false, version: 'runtime-10.0', channel: 'stable', updateAvailable: false,
      installed: { id: 'nexus', label: 'Standard', buildId: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), manifestSha256: 'c'.repeat(64), displayWinePath: '/managed/standard/files/bin/wine' } },
    { id: 'nexus-cachyos', checking: false, installing: false, version: 'runtime-cachyos-10.0', channel: 'stable', updateAvailable: true,
      installed: { id: 'nexus-cachyos', label: 'CachyOS', buildId: 'd'.repeat(64), sourceCommit: 'e'.repeat(40), manifestSha256: 'f'.repeat(64), displayWinePath: '/managed/cachyos/files/bin/wine' },
      available: { version: 'runtime-cachyos-11.0', candidateSha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), archiveName: 'nexus-runtime-cachyos-x86_64.tar.xz', requiresBackendVersion: '0.2.3', requiresLauncherVersion: '0.5.0' } },
  ];
  const html = renderToStaticMarkup(<SettingsPage data={data} toast={() => {}} />);
  const cards = [...html.matchAll(/<section class="settings-card managed-runtime-settings"[\s\S]*?<\/section>/g)].map(match => match[0]);
  expect(cards).toHaveLength(2);
  expect(cards[0]).toContain('data-runtime-family="nexus"');
  expect(cards[1]).toContain('data-runtime-family="nexus-cachyos"');
  for (const card of cards) {
    expect(card).toContain('class="settings-heading"');
    expect(card).toContain('class="status-label');
    expect(card).toContain('class="button-row end"');
    expect(card).toContain('Check for updates');
    expect(card).not.toContain('managed-runtime-binary');
  }
  expect(cards[0]).toContain('Standard runtime');
  expect(cards[0]).toContain('Installed: runtime-10.0');
  expect(cards[1]).toContain('CachyOS runtime');
  expect(cards[1]).toContain('Installed: runtime-cachyos-10.0');
  expect(cards[1]).toContain('Update CachyOS runtime');
  expect(html).not.toContain('Default runtime');
  expect(html).not.toContain('/managed/cachyos/files/bin/wine');
  expect(html).not.toContain('/managed/standard/files/bin/wine');
});

it('presents independent Standard and CachyOS install candidates in the same card structure',()=>{
  const data = demoSnapshot();
  data.runtime.managedFamilies = [
    { id: 'nexus', checking: false, installing: false, updateAvailable: true,
      available: { version: 'runtime-11.0', candidateSha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), archiveName: 'nexus-runtime-11.0-x86_64.tar.xz', requiresBackendVersion: '0.2.3', requiresLauncherVersion: '0.5.0' } },
    { id: 'nexus-cachyos', checking: false, installing: false, updateAvailable: true,
      available: { version: 'runtime-cachyos-11.0', candidateSha256: 'c'.repeat(64), sourceCommit: 'd'.repeat(40), archiveName: 'nexus-runtime-cachyos-11.0-x86_64.tar.xz', requiresBackendVersion: '0.2.3', requiresLauncherVersion: '0.5.0' } },
  ];
  const html = renderToStaticMarkup(<SettingsPage data={data} toast={() => {}} />);
  const cards = [...html.matchAll(/<section class="settings-card managed-runtime-settings"[\s\S]*?<\/section>/g)].map(match => match[0]);
  expect(cards[0]).toContain('Available: runtime-11.0');
  expect(cards[0]).toContain('Install Standard runtime');
  expect(cards[1]).toContain('Available: runtime-cachyos-11.0');
  expect(cards[1]).toContain('Install CachyOS runtime');
});

it('keeps ready family cards free of an idle phase panel while keeping real progress and errors',()=>{
  const data = demoSnapshot();
  const installedFamily = (id:'nexus'|'nexus-cachyos', version:string) => ({
    id, checking: false, installing: false, version, channel: 'stable' as const, updateAvailable: false,
    installed: { id, label: id === 'nexus' ? 'Standard' : 'CachyOS', buildId: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), manifestSha256: 'c'.repeat(64) },
  });
  data.runtime.phase = 'Runtime is ready.';
  data.runtime.managedFamilies = [installedFamily('nexus','runtime-10.0'), {...installedFamily('nexus-cachyos','runtime-cachyos-10.0'), phase: 'Runtime is ready.'}];
  const cards = (html: string) => [...html.matchAll(/<section class="settings-card managed-runtime-settings"[\s\S]*?<\/section>/g)].map(match => match[0]);
  const ready = renderToStaticMarkup(<SettingsPage data={data} toast={() => {}} />);
  for (const card of cards(ready)) {
    expect(card).toContain('class="status-label ready"');
    expect(card).not.toContain('runtime-phase');
  }
  expect(ready).not.toContain('Runtime is ready.');

  data.runtime.managedFamilies = [installedFamily('nexus','runtime-10.0'), {...installedFamily('nexus-cachyos','runtime-cachyos-10.0'), checking: true, phase: 'Checking the CachyOS runtime release.'}];
  const busy = renderToStaticMarkup(<SettingsPage data={data} toast={() => {}} />);
  expect(cards(busy)[0]).not.toContain('runtime-phase');
  expect(cards(busy)[1]).toContain('runtime-phase');
  expect(cards(busy)[1]).toContain('Checking the CachyOS runtime release.');

  data.runtime.managedFamilies = [installedFamily('nexus','runtime-10.0'), {...installedFamily('nexus-cachyos','runtime-cachyos-10.0'), error: 'Backend 0.3.0 or newer is required'}];
  const failed = renderToStaticMarkup(<SettingsPage data={data} toast={() => {}} />);
  expect(failed).not.toContain('Runtime is ready.');
  for (const card of cards(failed)) expect(card).not.toContain('runtime-phase');
  expect(failed).toContain('Backend 0.3.0 or newer is required');
});

it('shows close-to-tray as an optional desktop preference',()=>{
 const data=demoSnapshot();data.settings.closeToTray=true;
 const html=renderToStaticMarkup(<SettingsPage data={data} toast={()=>{}}/>);
 expect(html).toContain('Close to system tray');expect(html).toContain('Desktop mode only.');
 expect(html).toMatch(/type="checkbox"[^>]*checked=""/);
});

it('labels a local backend honestly and offers the normal local archive route', () => {
  const data = demoSnapshot();
  data.backend = { ...data.backend, available: true, version: '0.2.15', delivery: 'local' };
  const html = renderToStaticMarkup(<SettingsPage data={data} toast={() => {}} />);
  expect(html).toContain('Local build. Not a published release.');
  expect(html).toContain('Install from archive');
});
it('separates the multiple-account toggle from the sign-in action row', () => {
  const data = demoSnapshot();
  data.backend.capabilities.savedAccounts = true;
  data.auth.savedAccountsEnabled = true;
  data.settings.multiAccountEnabled = true;
  const html = renderToStaticMarkup(<SettingsPage data={data} toast={() => {}} />);
  expect(html).toContain('class="button-row account-management-row"');
  expect(html).toContain('Hide account management');
});
it('keeps the interface language selector without the removed generic language warning', () => {
  const html = renderToStaticMarkup(<SettingsPage data={demoSnapshot()} toast={() => {}} />);
  expect(html).toContain('Interface language');
  expect(html).toContain('Save language');
  expect(html).not.toContain('Launcher language only. Game language and Store region are set separately.');
});
