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
    expect(html).toContain('Check GitHub for launcher updates.');
  });
  it('keeps technical details in a closed disclosure, without a CLI command list', () => {
    const html = renderToStaticMarkup(<SettingsPage data={demoSnapshot()} toast={() => {}} />);
    const details = html.match(/<details\b[^>]*class="settings-card settings-diagnostics"[^>]*>[\s\S]*?<\/details>/)?.[0];
    expect(details).toBeDefined();
    expect(details?.split('>')[0]).not.toMatch(/\bopen\b/);
    expect(details).toContain('Build dependencies');
    expect(details).toContain('COMMIT');
    expect(details).toContain('Verbose game logs');
    expect(details).toContain('Save diagnostics');
    expect(details).toContain('Build backend from source');
    expect(details).not.toContain('Install upstream snapshot');
    expect(details).not.toContain('Check upstream snapshot');
    const main = html.replace(details!, '');
    expect(main).not.toContain('Build dependencies');
    expect(main).not.toContain('Verbose game logs');
    expect(main).not.toContain('PROTON HEAD');
    expect(main).not.toContain('Install upstream snapshot');
    expect(main).not.toContain('Official GitHub Actions snapshot');
    expect(main).not.toContain('Build backend from source');
    expect(main).not.toContain('Rebuild backend');
    expect(main).not.toContain('Install / update backend');
    expect(main).toContain('Nexus runtime');
    expect(main).toContain('Open backend diagnostic log');
    expect(main).toContain('No passwords, tokens or account contents');
    expect(main).not.toContain('Install Nexus runtime');
    expect(html).not.toContain('Advertised commands');
  });
  it('shows an installed upstream runtime separately from an unpublished Nexus release', () => {
    const data = demoSnapshot();
    data.runtime.name = 'xodus-proton-7c0b4354';
    data.runtime.nexusAvailable = false;
    data.runtime.nexusError = 'No Nexus runtime release has been published yet.';
    data.backend.releaseAvailable = false;
    data.backend.blockReason = 'No compatible Nexus backend release has been published yet.';
    const html = renderToStaticMarkup(<SettingsPage data={data} toast={() => {}} />);
    expect(html).toContain('Active: Xodus Proton runtime');
    expect(html).toContain('OTHER RUNTIME');
    expect(html).toContain(data.runtime.nexusError);
    expect(html).toContain(data.backend.blockReason);
    expect(html).not.toContain('Install / update backend');
    expect(html).not.toContain('Install upstream snapshot');
  });
  it('keeps actionable errors visible and unsupported sign-in disabled', () => {
    const data = demoSnapshot();
    data.backend.capabilities.login = false;
    data.backend.blockReason = 'Cargo is missing. Install it before building.';
    data.runtime.error = 'SHA-512 verification failed.';
    const html = renderToStaticMarkup(<SettingsPage data={data} toast={() => {}} />);
    const main = html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/, '');
    expect(main).toContain(data.backend.blockReason);
    expect(main).toContain(data.runtime.error);
    expect(main).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Sign in again<\/button>/);
  });
});


it('shows close-to-tray as an optional desktop preference',()=>{
 const data=demoSnapshot();data.settings.closeToTray=true;
 const html=renderToStaticMarkup(<SettingsPage data={data} toast={()=>{}}/>);
 expect(html).toContain('Close Nexus to the system tray');expect(html).toContain('Desktop sessions only.');
 expect(html).toMatch(/type="checkbox"[^>]*checked=""/);
});
