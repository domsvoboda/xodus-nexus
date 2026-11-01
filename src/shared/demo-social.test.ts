import { describe, expect, it } from 'vitest';
import { createDemoSocial } from './demo-social';

describe('isolated Social demo', () => {
  it('supplies examples for every people list, conversations and complete profiles without artwork', async () => {
    const { social } = createDemoSocial();
    expect(await social.getXboxFriends()).toHaveLength(3);
    for (const list of ['recent', 'suggested', 'blocked', 'received-requests', 'sent-requests', 'search'] as const) {
      const page = await social.getXboxPeople(list, list === 'search' ? 'Demo' : undefined);
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.every(person => !person.avatarUrl)).toBe(true);
    }
    expect(await social.getXboxPlayerDetails('me')).toMatchObject({ isSelf: true, gamertag: 'NexusPlayer' });
    expect((await social.getXboxPlayerGames('me')).items.length).toBeGreaterThan(0);
    for (const row of await social.getXboxInbox()) expect((await social.getXboxConversation(row.participants[0])).length).toBeGreaterThan(0);
  });
  it('keeps message and relationship changes in this instance only', async () => {
    const first = createDemoSocial(), second = createDemoSocial();
    const receipt = await first.social.sendXboxMessage('sample@example.test', '1001', 'Sample reply');
    expect((await first.social.getXboxConversation('1001')).at(-1)).toMatchObject({ id: receipt.id, text: 'Sample reply', mine: true });
    expect(await second.social.getXboxConversation('1001')).toHaveLength(2);
    await first.social.changeXboxRelationship('sample@example.test', '1004', 'accept-request');
    expect(await first.social.getXboxFriends()).toHaveLength(4);
    expect(await second.social.getXboxFriends()).toHaveLength(3);
    await expect(first.social.sendXboxMessage('real-account', '1001', 'text')).rejects.toThrow('Demo account changed');
    await expect(first.social.getXboxPlayerDetails('999999')).rejects.toThrow('Unknown demo player');
  });
  it('simulates joining, muting, inviting, leaving and starting parties without a media host', async () => {
    const { voice } = createDemoSocial();
    const states: string[] = [];
    const unsubscribe = voice.onXboxPartyState(state => states.push(state.phase));
    expect(await voice.getXboxActiveParties()).toEqual(['demo-existing-party']);
    await voice.leaveExistingXboxParty('demo-existing-party');
    expect(await voice.getXboxActiveParties()).toEqual([]);
    const [invite] = await voice.getXboxInvites();
    await voice.controlXboxVoice({ type: 'accept', inviteId: invite.id });
    expect(await voice.getXboxParty()).toMatchObject({ phase: 'connected', members: [{ xuid: '1000' }, { xuid: '1001' }, { xuid: '1002' }] });
    await voice.controlXboxVoice({ type: 'setMuted', muted: false });
    await voice.controlXboxVoice({ type: 'mute', xuid: '1001', muted: true });
    expect(await voice.getXboxVoiceState()).toMatchObject({ connected: true, muted: false, mutedMembers: ['1001'] });
    await voice.inviteXboxPartyFriend('1003');
    await voice.controlXboxVoice({ type: 'leave' });
    expect(await voice.getXboxParty()).toMatchObject({ phase: 'idle', members: [] });
    await voice.controlXboxVoice({ type: 'start' });
    expect(states).toContain('connected'); expect(states).toContain('idle');
    unsubscribe();
  });
});
