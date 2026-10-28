import type {XboxPartyControlApi} from '../shared/types';
import {guideRpc,onGuideEvent} from './xbox-guide-api';
export const guidePartyApi:XboxPartyControlApi={
  getXboxParty:()=>guideRpc('getXboxParty'),onXboxPartyState:callback=>onGuideEvent('party',callback),
  getXboxActiveParties:()=>guideRpc('getXboxActiveParties'),leaveExistingXboxParty:id=>guideRpc('leaveExistingXboxParty',id),
  inviteXboxPartyFriend:xuid=>guideRpc('inviteXboxPartyFriend',xuid),getXboxInvites:()=>guideRpc('getXboxInvites'),
  onXboxInvitesChanged:callback=>onGuideEvent('invites',callback),
  getXboxVoiceState:()=>guideRpc('getXboxVoiceState'),onXboxVoiceState:callback=>onGuideEvent('voice',callback),
  controlXboxVoice:command=>guideRpc('controlXboxVoice',command),
};
