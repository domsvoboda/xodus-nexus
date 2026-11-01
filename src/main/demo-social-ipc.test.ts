import { expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { registerDemoSocialIpc } from './demo-social-ipc';

it('replaces demo Social IPC with local fixtures, enforces sender checks, and publishes party state', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const ipc = { removeHandler: vi.fn((name: string) => { handlers.delete(name); }), handle: vi.fn((name: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => { handlers.set(name, handler); }) };
  const authorize = vi.fn(), emit = vi.fn(), openProfile = vi.fn(async () => {}), popOutChat = vi.fn(async () => {});
  registerDemoSocialIpc(ipc, { authorize, emit, openProfile, popOutChat });
  const invoke = (name: string, ...args: unknown[]) => handlers.get(name)!({} as IpcMainInvokeEvent, ...args);
  expect(await invoke('xbox-social-friends')).toHaveLength(3);
  await invoke('open-xbox-player-profile', 'me'); expect(openProfile).toHaveBeenCalledWith('me');
  await invoke('pop-out-xbox-chat', '1001'); expect(popOutChat).toHaveBeenCalledWith('1001');
  await invoke('xbox-voice-control', { type: 'start' });
  expect(emit).toHaveBeenCalledWith('xbox-party-state', expect.objectContaining({ phase: 'connected' }));
  expect(emit).toHaveBeenCalledWith('xbox-voice-state', expect.objectContaining({ connected: true, muted: true }));
  expect(ipc.removeHandler).toHaveBeenCalledWith('xbox-voice-control');
  for (const channel of ['xbox-party-start', 'xbox-party-accept', 'xbox-party-microphone']) {
    expect(() => invoke(channel, 'offer', 'invite')).toThrow('unavailable in demo mode');
    expect(ipc.removeHandler).toHaveBeenCalledWith(channel);
  }
  authorize.mockImplementationOnce(() => { throw Error('Not Nexus'); });
  expect(() => invoke('xbox-social-friends')).toThrow('Not Nexus');
});
