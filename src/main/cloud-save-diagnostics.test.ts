import { expect, it, vi } from 'vitest';
import { CloudSaveDiagnostics, cloudSaveMessages, warnShortcutCloudFailure } from './cloud-save-diagnostics.js';

it('recognizes the reported Tunic failure and retains its specific conflict reason', () => {
  const status = new CloudSaveDiagnostics();
  expect(status.observe('[2026-10-24T05:03:27.903Z] 0294:err:gdkc:initialize_provider cloud sync failed, hr 0x8083000a.')).toBe(true);
  status.observe('0294:err:gdkc:cloud_disable cloud saves disabled for this session, continuing with local saves only.');
  status.observe('xodus-savesync: cloud 0 downloaded 0 uploaded 0');
  expect(status.problem).toBe('conflict');
  expect(cloudSaveMessages[status.problem!]).toContain('Keep your local saves');
});

it.each([
  ['00bc:err:gdkc:initialize_provider cloud sync failed, hr 0x80004005.', 'unavailable'],
  ['00bc:err:gdkc:cloud_disable cloud saves disabled for this session, continuing with local saves only.', 'unavailable'],
  ['xodus-savesync: cloud 0 downloaded 0 uploaded 0', 'unavailable'],
  ['00bc:warn:gdkc:flush_dirty_upload final cloud upload failed, hr 0x80004005; dirty save retained.', 'upload'],
  ['00bc:warn:gdkc:cloud_unlock cloud save session release failed, hr 0x80004005, status 503; upload notification retained for retry.', 'upload'],
  ['Nexus cloud saves: session setup hr=80004005', 'unavailable'],
  ['Nexus cloud saves: final upload hr=80004005', 'upload'],
  ['Nexus cloud saves: session closed hr=80004005', 'upload'],
  ['Nexus cloud saves: runtime drain complete hr=80004005', 'upload'],
  ['nexus-files: final-sync hr=0x80004005 uploaded=0', 'upload'],
  ['001c:err:gdkc:files_provider_process file save provider failed hr=0x80004005; local data is retained', 'upload'],
] as const)('detects the specific cloud failure: %s', (line, problem) => {
  const status = new CloudSaveDiagnostics();
  expect(status.observe(line)).toBe(true);
  expect(status.problem).toBe(problem);
  expect(status.observe(line)).toBe(false);
});

it.each([
  'xodus-savesync: cloud 1 downloaded 1 uploaded 0',
  'xodus-savesync: cloud 1 downloaded 0 uploaded 0',
  'Nexus cloud saves: session setup hr=00000000',
  'Nexus cloud saves: final upload hr=00000001',
  'Nexus cloud saves: session closed hr=00000000',
  'Nexus cloud saves: final upload hr=not-a-code',
  '0294:err:gdkc:xsts_authorize_privilege xsts authorization failed, status 400.',
  'The Xodus process exited with code 0.',
  'An unrelated game error 0x8083000a',
  'nexus-files: final-sync hr=0 uploaded=1',
  'Nexus cloud saves: runtime drain complete hr=00000000',
  // Background errors may recover in close_provider, so these are not final failures.
  '0294:warn:gdkc:upload_worker background upload failed, hr 0x80004005; dirty save retained for retry.',
])('does not mistake activity, another API or a recoverable attempt for a final cloud failure: %s', line => {
  const status = new CloudSaveDiagnostics();
  expect(status.observe(line)).toBe(false);
  expect(status.problem).toBeUndefined();
});

it('does not clear a failure on another provider success or ordinary log noise', () => {
  const status = new CloudSaveDiagnostics();
  status.observe('Nexus cloud saves: final upload hr=80004005');
  status.observe('xodus-savesync: cloud 0 downloaded 0 uploaded 0');
  status.observe('Nexus cloud saves: session closed hr=00000000');
  for (let i = 0; i < 300; i++) status.observe(`Game line ${i}`);
  expect(status.problem).toBe('upload');
});

it('shows Steam shortcut cloud failures after opening the launcher and awaits acknowledgement', async () => {
  const order: string[] = [];
  let done!: () => void;
  const pending = new Promise<void>(resolve => { done = resolve; });
  const ui = { showLauncher: vi.fn(async () => { order.push('window'); }),
    warn: vi.fn(async (message: string) => { order.push(message); await pending; }) };
  let finished = false;
  const result = warnShortcutCloudFailure(true, 'Cloud warning', ui).then(() => { finished = true; });
  await vi.waitFor(() => expect(ui.warn).toHaveBeenCalledOnce());
  expect(order).toEqual(['window', 'Cloud warning']);
  expect(finished).toBe(false);
  done(); await result;
  expect(finished).toBe(true);
});
it.each([[false, 'Cloud warning'], [true, undefined]] as const)('does not show an extra dialog for desktop/healthy sessions', async (only, message) => {
  const ui = { showLauncher: vi.fn(async () => {}), warn: vi.fn(async () => {}) };
  await warnShortcutCloudFailure(only, message, ui);
  expect(ui.showLauncher).not.toHaveBeenCalled(); expect(ui.warn).not.toHaveBeenCalled();
});

it('offers the next-start choice only when the runtime reports its conflict resolver', () => {
  const status = new CloudSaveDiagnostics();
  status.observe('gdkc:initialize_provider cloud sync failed, hr 0x8083000a.');
  expect(status.message).toContain('did not offer');
  expect(status.observe('nexus-saves: conflict-resolution hr=0x8083000a backups=retained')).toBe(true);
  expect(status.message).toContain('start it again and choose a save');
  expect(status.observe('nexus-saves: conflict-resolution hr=0x8083000a backups=retained')).toBe(false);
  status.observe('xodus-savesync: cloud 0 downloaded 0 uploaded 0');
  expect(status.message).toContain('conflict dialog');
});

it('does not warn after a successful conflict choice', () => {
  const status = new CloudSaveDiagnostics();
  expect(status.observe('nexus-saves: conflict-resolution hr=0 backups=retained')).toBe(false);
  expect(status.message).toBeUndefined();
});
