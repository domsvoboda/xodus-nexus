import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { createDemoSocial } from '../shared/demo-social.js';

/** Called only by registerDemoIpc. Replaces real Social handlers with the
 * session-only fixture, including voice controls that never start a media host. */
export function registerDemoSocialIpc(ipc: Pick<IpcMain, 'handle' | 'removeHandler'>, options: {
  authorize: (event: IpcMainInvokeEvent) => void;
  emit: (channel: string, value: unknown) => void;
  openProfile: (xuid: string) => Promise<void>;
  popOutChat: (xuid: string) => Promise<void>;
}) {
  const { social, voice } = createDemoSocial();
  function handle<T extends unknown[]>(channel: string, run: (...args: T) => unknown) {
    ipc.removeHandler(channel);
    ipc.handle(channel, (event, ...args: unknown[]) => { options.authorize(event); return run(...args as T); });
  }
  handle('xbox-social-friends', social.getXboxFriends);
  handle('xbox-player-profile', social.getXboxPlayerProfile);
  handle('xbox-player-details', social.getXboxPlayerDetails);
  handle('xbox-player-games', social.getXboxPlayerGames);
  handle('xbox-social-people', social.getXboxPeople);
  handle('xbox-social-relationship', social.getXboxRelationship);
  handle('xbox-social-relationship-change', social.changeXboxRelationship);
  handle('xbox-social-inbox', social.getXboxInbox);
  handle('xbox-social-conversation', social.getXboxConversation);
  handle('xbox-social-send', social.sendXboxMessage);
  handle('xbox-game-invite-availability', social.getXboxGameInviteAvailability);
  handle('xbox-game-invite-send', social.sendXboxGameInvite);
  handle('open-xbox-player-profile', options.openProfile);
  handle('pop-out-xbox-chat', options.popOutChat);
  handle('xbox-chat-reads', () => ({ account: 'sample@example.test', binary: '/home/demo/.config/xodus-nexus/xodus-backends/current', keys: [] }));
  handle('xbox-chat-viewed', () => {});
  handle('xbox-party-state', voice.getXboxParty);
  handle('xbox-party-active', voice.getXboxActiveParties);
  handle('xbox-party-leave-existing', voice.leaveExistingXboxParty);
  handle('xbox-party-invite', voice.inviteXboxPartyFriend);
  handle('xbox-invites', voice.getXboxInvites);
  handle('xbox-voice-state', voice.getXboxVoiceState);
  handle('xbox-voice-control', voice.controlXboxVoice);
  voice.onXboxPartyState(state => options.emit('xbox-party-state', state));
  voice.onXboxVoiceState(state => options.emit('xbox-voice-state', state));
  voice.onXboxInvitesChanged(state => options.emit('xbox-invites', state));
}
