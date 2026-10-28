import {describe,it,expect,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {XboxRuntimeInvites} from './XboxRuntimeInvites';
describe('runtime invitation presentation',()=>{
 const api={chooseGameInviteRecipient:vi.fn(),cancelGameInvite:vi.fn(),acceptGameInvite:vi.fn()};
 it('keeps game-owned invites visible in native Social with a recipient choice',()=>{
  const html=renderToStaticMarkup(<XboxRuntimeInvites api={api} friends={[{xuid:'2',gamertag:'Synthetic friend',online:true,presence:'Online',favorite:false,inParty:false}]} state={{active:[],incoming:[{id:'game:incoming',game:'Synthetic game',sender:'Synthetic sender',expires:Date.now()+10000}],outgoing:[{id:'game:outgoing',game:'Synthetic game',phase:'choosing'}]}}/>);
  expect(html).toContain('Synthetic sender');expect(html).toContain('Accept');
  expect(html).toContain('<option value="2">Synthetic friend</option>');expect(html).toContain('Cancel');
  expect(api.acceptGameInvite).not.toHaveBeenCalled();expect(api.chooseGameInviteRecipient).not.toHaveBeenCalled();
 });
 it('does not claim delivery while the game is still sending',()=>{
  const html=renderToStaticMarkup(<XboxRuntimeInvites api={api} friends={[]} state={{active:[],incoming:[],outgoing:[{id:'game:outgoing',game:'Synthetic game',phase:'sending'}]}}/>);
  expect(html).toContain('Waiting for the game');expect(html).not.toContain('Invitation sent');
 });
});
