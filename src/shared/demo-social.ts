import type { XboxSocialApi, XboxPartyControlApi, XboxPerson, XboxRelationship, XboxMessage, XboxPartyState, XboxVoiceState, XboxInvite } from './types.js';

const account = 'sample@example.test';
const self = '1000';
const samplePeople: XboxPerson[] = [
  { xuid: '1001', gamertag: 'DemoRanger', online: true, presence: 'Playing Forza Horizon 6', favorite: true, inParty: true },
  { xuid: '1002', gamertag: 'DemoExplorer', online: true, presence: 'Online', favorite: false, inParty: false },
  { xuid: '1003', gamertag: 'DemoBuilder', online: false, presence: 'Offline', favorite: false, inParty: false },
  { xuid: '1004', gamertag: 'DemoNewFriend', online: true, presence: 'Online', favorite: false, inParty: false, reason: 'Sent you a friend request' },
  { xuid: '1005', gamertag: 'DemoWanderer', online: false, presence: 'Offline', favorite: false, inParty: false },
  { xuid: '1006', gamertag: 'DemoBlockedPlayer', online: false, presence: 'Offline', favorite: false, inParty: false },
  { xuid: '1007', gamertag: 'DemoTeammate', online: true, presence: 'Playing Sea of Thieves', favorite: false, inParty: false, reason: 'Recently played together' },
];
const copy = <T>(value: T): T => structuredClone(value);

/** Isolated, session-only examples. No network, tokens, audio capture or real
 * relationship/message writes. The real UI uses its normal API contract. */
export function createDemoSocial() {
  let sequence = 0;
  const relationships = new Map<string, XboxRelationship>(samplePeople.map((person, index) => [person.xuid, {
    xuid: person.xuid, isFriend: index < 3, isFollowing: index < 3, isFollower: index < 4,
    favorite: person.favorite, blocked: person.xuid === '1006',
    requestState: person.xuid === '1004' ? 'incoming' : person.xuid === '1005' ? 'outgoing' : 'none',
  }]));
  const messages = new Map<string, XboxMessage[]>(samplePeople.map(person => [person.xuid, [
    { id: `demo-${person.xuid}-1`, sender: self, timestamp: '2026-01-01T18:00:00Z', text: 'Ready for a game later?', hidden: false, mine: true },
    { id: `demo-${person.xuid}-2`, sender: person.xuid, timestamp: '2026-01-01T18:01:00Z', text: person.xuid === '1001' ? 'Absolutely! Join my sample party when you are ready.' : 'Sounds good! These are sample messages.', hidden: false, mine: false },
  ]]));
  const person = (id: string) => {
    const value = samplePeople.find(item => item.xuid === id);
    if (!value) throw Error('Unknown demo player.');
    return value;
  };
  const relationship = (id: string) => { person(id); return copy(relationships.get(id)!); };
  const isSelf = (id: string) => id === 'me' || id === self;
  const checkAccount = (value: string) => { if (value !== account) throw Error('Demo account changed.'); };
  const partyListeners = new Set<(state: XboxPartyState) => void>();
  const voiceListeners = new Set<(state: XboxVoiceState) => void>();
  const inviteListeners = new Set<(invites: XboxInvite[]) => void>();
  const idleParty = (): XboxPartyState => ({ phase: 'idle', members: [] });
  const idleAudio = (): XboxVoiceState => ({ connected: false, muted: true, audioBlocked: false, mutedMembers: [] });
  let party = idleParty();
  let audio = idleAudio();
  // Joining an invite and creating a party produce the same simulated connected state.
  const connect = (id: string) => {
    party = { phase: 'connected', id, selfXuid: self, members: [{ xuid: self, role: 'owner' }, { xuid: '1001', role: 'member' }, { xuid: '1002', role: 'member' }] };
    audio = { ...idleAudio(), connected: true };
  };
  let existing = ['demo-existing-party'];
  let invites: XboxInvite[] = [{ id: 'demo-party-invite', kind: 'party', gamertag: 'DemoRanger', sender: '1001', sentAt: Date.now(), expiresAt: Date.now() + 86_400_000, titleId: null, titleName: null }];
  const publish = () => {
    partyListeners.forEach(listener => listener(copy(party)));
    voiceListeners.forEach(listener => listener(copy(audio)));
    inviteListeners.forEach(listener => listener(copy(invites)));
  };
  const subscribe = <T>(listeners: Set<(value: T) => void>, listener: (value: T) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const social: XboxSocialApi = {
    openXboxPlayerProfile: async () => {}, // The desktop IPC adapter supplies window navigation.
    getXboxGameInviteAvailability: async () => ({ canInvite: true, gameId: 'demo-1', title: 'Forza Horizon 6' }),
    sendXboxGameInvite: async id => { person(id); },
    getXboxPlayerProfile: async id => isSelf(id) ? { xuid: self, gamertag: 'NexusPlayer', gamerscore: '12500' } : { xuid: id, gamertag: person(id).gamertag, gamerscore: '8420' },
    getXboxPlayerDetails: async id => ({ ...await social.getXboxPlayerProfile(id), isSelf: isSelf(id),
      bio: 'Sample profile for trying the Social menu and controller navigation.', location: 'Demo world', tenure: '5',
      counts: { friends: 12, followers: 24, following: 18 }, relationship: isSelf(id) ? undefined : relationship(id) }),
    getXboxPlayerGames: async () => ({ items: [
      { titleId: 'demo-forza', name: 'Forza Horizon 6', lastPlayed: '2026-01-01T18:00:00Z', currentGamerscore: 450, totalGamerscore: 1000, achievementsUnlocked: 18, achievementsTotal: 50 },
      { titleId: 'demo-sea', name: 'Sea of Thieves', lastPlayed: '2026-01-01T12:00:00Z', currentGamerscore: 220, totalGamerscore: 1000, achievementsUnlocked: 11, achievementsTotal: 50 },
    ] }),
    getXboxPeople: async (list, query) => ({ items: copy(samplePeople.filter(item => {
      const state = relationships.get(item.xuid)!;
      if (list === 'blocked') return state.blocked;
      if (list === 'received-requests') return state.requestState === 'incoming';
      if (list === 'sent-requests') return state.requestState === 'outgoing';
      if (list === 'search') return !state.blocked && item.gamertag.toLowerCase().includes((query ?? '').toLowerCase());
      return !state.blocked && (list === 'recent' ? ['1001', '1007'].includes(item.xuid) : !state.isFriend);
    })) }),
    getXboxRelationship: async id => relationship(id),
    changeXboxRelationship: async (value, id, action) => {
      checkAccount(value); const state = relationship(id);
      switch (action) {
        case 'favorite': state.favorite = true; break;
        case 'unfavorite': state.favorite = false; break;
        case 'send-request': state.requestState = 'outgoing'; break;
        case 'accept-request': state.requestState = 'none'; state.isFriend = state.isFollowing = state.isFollower = true; break;
        case 'cancel-request': case 'decline-request': state.requestState = 'none'; break;
        case 'remove-friend': state.isFriend = state.isFollowing = state.favorite = false; break;
        case 'block': state.blocked = true; state.isFriend = state.isFollowing = state.favorite = false; break;
        case 'unblock': state.blocked = false; break;
        default: throw Error('Unknown demo relationship action.');
      }
      relationships.set(id, state);
    },
    getXboxFriends: async () => copy(samplePeople.filter(item => relationships.get(item.xuid)!.isFriend).map(item => ({ ...item, favorite: relationships.get(item.xuid)!.favorite }))),
    getXboxInbox: async () => ['1001', '1002'].map(id => ({ id: `demo-chat-${id}`, type: 'OneToOne', participants: [id], gamertag: person(id).gamertag, unread: id === '1001', lastMessage: copy(messages.get(id)!.at(-1)!) })),
    getXboxConversation: async id => { person(id); return copy(messages.get(id)!); },
    sendXboxMessage: async (value, id, text) => {
      checkAccount(value); person(id);
      if (!text.trim() || text.length > 2000) throw Error('Enter a sample message of up to 2000 characters.');
      const receipt = { id: `demo-sent-${++sequence}` };
      messages.get(id)!.push({ ...receipt, sender: self, timestamp: new Date().toISOString(), text: text.trim(), hidden: false, mine: true });
      return receipt;
    },
  };
  const voice: XboxPartyControlApi = {
    getXboxParty: async () => copy(party), getXboxVoiceState: async () => copy(audio),
    onXboxPartyState: listener => subscribe(partyListeners, listener), onXboxVoiceState: listener => subscribe(voiceListeners, listener),
    getXboxInvites: async () => copy(invites), onXboxInvitesChanged: listener => subscribe(inviteListeners, listener),
    getXboxActiveParties: async () => [...existing],
    leaveExistingXboxParty: async id => { existing = existing.filter(value => value !== id); },
    inviteXboxPartyFriend: async id => { person(id); },
    controlXboxVoice: async command => {
      switch (command.type) {
        case 'accept':
          if (!invites.some(invite => invite.id === command.inviteId)) throw Error('Unknown demo invitation.');
          invites = invites.filter(invite => invite.id !== command.inviteId);
          connect('demo-party'); break;
        case 'start': connect(command.partyId ?? 'demo-party'); existing = []; break;
        case 'leave': party = idleParty(); audio = idleAudio(); break;
        case 'setMuted': audio.muted = command.muted; break;
        case 'mute': audio.mutedMembers = command.muted ? [...new Set([...audio.mutedMembers, command.xuid])] : audio.mutedMembers.filter(id => id !== command.xuid); break;
        case 'resume': audio.audioBlocked = false; break;
        default: throw Error('Unknown demo voice command.');
      }
      publish();
    },
  };
  return { social, voice };
}
