import { expect,it,vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FriendAvatar, Friends, preloadFriends } from './Friends';
import { TopStatus } from './App';
import { demoSnapshot } from '../shared/demo-data';
it('warms reads only after explicit intent with a supported signed-in account',async()=>{
  const data=demoSnapshot(),load=vi.fn(async()=>{});
  data.auth.stored=false;preloadFriends(data,load);data.auth.stored=true;data.auth.running=true;preloadFriends(data,load);
  data.auth.running=false;data.backend.available=false;preloadFriends(data,load);data.backend.available=true;data.backend.capabilities.commands=[];preloadFriends(data,load);
  expect(load).not.toHaveBeenCalled();data.backend.capabilities.commands.push('social');preloadFriends(data,load);expect(load).toHaveBeenCalledOnce();
  load.mockRejectedValue(Error('synthetic offline'));preloadFriends(data,load);await Promise.resolve();
});
it('shows honest capability and account prerequisites instead of fake friends or invites',()=>{
  const data=demoSnapshot();data.auth.stored=false;
  let html=renderToStaticMarkup(<Friends data={data} close={()=>{}} />);
  expect(html).toContain('Sign in to your Microsoft account');expect(html).not.toContain('<textarea');
  data.auth.stored=true;data.backend.capabilities.commands=[];
  html=renderToStaticMarkup(<Friends data={data} close={()=>{}} />);
  expect(html).toContain('does not support Xbox friends and chat');expect(html).not.toContain('<textarea');
  expect(html).toContain('aria-modal="true"');expect(html).toContain('data-gamepad-cancel');
});
it('keeps the dock without an overlay, manual refresh button or permanent explanatory footer',()=>{
  const data=demoSnapshot();data.auth.stored=true;data.auth.running=false;data.backend.available=true;data.backend.capabilities.commands.push('social');
  const html=renderToStaticMarkup(<Friends data={data} close={()=>{}} />);
  expect(html).toContain('>Friends</h2>');expect(html).not.toContain('Nothing is sent automatically');
  expect(html).toContain('friends-empty');expect(html).toContain('Your conversations');
  expect(html).not.toMatch(/desktop overlay|Ctrl\+Shift\+F10|Refresh friends|Refresh conversation|friends-limitation|Chat does not change/);
  expect(html).not.toMatch(/Invitation sent\.|<iframe|<webview/);
});
it('keeps friends out of the top bar and preserves existing navigation',()=>{
  const html=renderToStaticMarkup(<TopStatus data={demoSnapshot()} go={()=>{}} openFriends={()=>{}} />);
  expect(html).not.toContain('Xbox friends and chat');expect(html).toContain('Settings');
});
it('preserves the bottom-right dock and uses a photo or an honest fallback icon',()=>{
  const data=demoSnapshot();
  expect(renderToStaticMarkup(<Friends data={data} docked close={()=>{}} />)).toContain('friends-docked');
  const friend={xuid:'42',gamertag:'Example',presence:'unknown' as const,avatarUrl:'https://images-eds-ssl.xboxlive.com/image?format=png'};
  const html=renderToStaticMarkup(<FriendAvatar friend={friend} />);
  expect(html).toContain('<img');expect(html).toContain('referrerPolicy="no-referrer"');expect(html).toContain('loading="lazy"');
  expect(renderToStaticMarkup(<FriendAvatar friend={{...friend,avatarUrl:'https://evil.test/photo'}} />)).not.toContain('<img');
});
