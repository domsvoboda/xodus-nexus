import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsPage } from './App';
import { OfflinePermissionsView, offlinePermissionConfirmation } from './OfflinePermissions';
import { demoSnapshot } from '../shared/demo-data';

const status = (enabled: boolean, remainingToggles: number, nextChangeAt?: string) =>
  ({ enabled, requestSuccess: true, remainingToggles, maxToggles: 3, periodDays: 365, nextChangeAt, checkedAt: '2026-10-24T22:00:00Z' });

it('shows the setting only when the backend supports it and the account is signed in', () => {
  const data = demoSnapshot();
  data.auth = { running: false, stored: true, username: 'one@example.test', note: '' };
  data.backend.capabilities = { ...data.backend.capabilities, offlinePc: false };
  expect(renderToStaticMarkup(<SettingsPage data={data} toast={() => {}} />)).not.toContain('OFFLINE PERMISSIONS');
  data.backend.capabilities = { ...data.backend.capabilities, offlinePc: true };
  expect(renderToStaticMarkup(<SettingsPage data={data} toast={() => {}} />)).toContain('OFFLINE PERMISSIONS');
  data.auth = { running: false, stored: false, note: '' };
  expect(renderToStaticMarkup(<SettingsPage data={data} toast={() => {}} />)).not.toContain('OFFLINE PERMISSIONS');
});

it('mirrors the Xbox app states: on, off, no changes left, loading and errors', () => {
  const render = (props: Parameters<typeof OfflinePermissionsView>[0]) => renderToStaticMarkup(<OfflinePermissionsView {...props} />);
  const on = render({ status: status(true, 1), busy: false, onToggle: () => {}, onRetry: () => {} });
  expect(on).toContain('checked=""'); expect(on).toContain('This is your offline device'); expect(on).toContain('Changes left this year: 1 of 3.'); expect(on).toContain('>ON<');
  const off = render({ status: status(false, 2), busy: false, onToggle: () => {}, onRetry: () => {} });
  expect(off).not.toContain('checked=""'); expect(off).toContain('Offline play is off'); expect(off).toContain('Changes left this year: 2 of 3.'); expect(off).toContain('>OFF<');
  const exhaustedOff = render({ status: status(false, 0, '2027-03-01T10:00:00Z'), busy: false, onToggle: () => {}, onRetry: () => {} });
  expect(exhaustedOff).toContain('used every change'); expect(exhaustedOff).toContain('change this again on'); expect(exhaustedOff).toMatch(/<input type="checkbox"[^>]*disabled=""/);
  // A designated device may still turn the setting off when no changes remain, like the Xbox app.
  const exhaustedOn = render({ status: status(true, 0), busy: false, onToggle: () => {}, onRetry: () => {} });
  expect(exhaustedOn).not.toMatch(/<input type="checkbox"[^>]*disabled=""/);
  expect(render({ busy: true, onToggle: () => {}, onRetry: () => {} })).toContain('Checking offline permissions');
  expect(render({ busy: false, error: 'Microsoft could not be reached.', onToggle: () => {}, onRetry: () => {} })).toContain('Microsoft could not be reached.');
});

it('warns about the one-PC rule and the remaining yearly changes before any change', () => {
  const enable = offlinePermissionConfirmation(status(false, 2), true);
  expect(enable.title).toBe('Use this device for offline play?');
  expect(enable.message).toContain('Only one PC per account');
  expect(enable.message).toContain('removes offline play from any other PC');
  expect(enable.message).toContain('3 changes of this setting per year');
  expect(enable.message).toContain('you will have 1 left');
  expect(enable.confirmLabel).toBe('Turn on');
  const last = offlinePermissionConfirmation(status(false, 1), true);
  expect(last.message).toContain('last change for this period');
  const disable = offlinePermissionConfirmation(status(true, 1), false);
  expect(disable.title).toBe('Turn off offline play on this device?');
  expect(disable.message).toContain('need a connection to start');
  expect(disable.message).toContain('removed now');
  expect(disable.confirmLabel).toBe('Turn off');
  expect(offlinePermissionConfirmation({ ...status(false, 0), remainingToggles: undefined, maxToggles: undefined }, true).message).toContain('limits how often');
});

it('does not spend a designation change on unsupported components but always allows turning it off', () => {
  for(const enabled of [false,true]) {
    const html=renderToStaticMarkup(<OfflinePermissionsView status={{...status(enabled,2),launchSupported:false}} busy={false} onToggle={()=>{}} onRetry={()=>{}}/>);
    expect(html).toContain('compatible Nexus backend and runtime');
    expect(/<input type="checkbox"[^>]*disabled=""/.test(html)).toBe(!enabled);
  }
});
