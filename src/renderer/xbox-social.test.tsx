import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect,it } from 'vitest';
import { SocialFriends,XboxSocial } from './XboxSocial';
import {xboxGamerpicSource} from './XboxAvatar';

it('requests dimensions required by legacy Xbox gamerpics and preserves the encoded source',()=>{
  const source='https://images-eds-ssl.xboxlive.com/image?url=https%3A%2F%2Favatar-ssl.xboxlive.com%2Favatar%2Fpicture.png&format=png';
  const resized=new URL(xboxGamerpicSource(source,64)!);
  expect(resized.searchParams.get('url')).toBe('https://avatar-ssl.xboxlive.com/avatar/picture.png');
  expect(resized.searchParams.get('format')).toBe('png');
  expect(resized.searchParams.get('w')).toBe('64');expect(resized.searchParams.get('h')).toBe('64');
  expect(xboxGamerpicSource(source+'&w=64&h=64',128)).toContain('w=128&h=128');
  expect(xboxGamerpicSource('data:image/png;base64,AAAA',64)).toBe('data:image/png;base64,AAAA');
});

it('renders real presence fields with online friends first and escapes remote text',()=>{
  const html=renderToStaticMarkup(<SocialFriends friends={[
    {xuid:'1',gamertag:'Offline player',online:false,presence:'Offline',favorite:false,inParty:false},
    {xuid:'2',gamertag:'<script>player</script>',online:true,presence:'Playing E-Day',favorite:true,inParty:true},
  ] } chooseChat={()=>{}}/>);
  expect(html.indexOf('Playing E-Day')).toBeLessThan(html.indexOf('Offline player'));
  expect(html).toContain('&lt;script&gt;player&lt;/script&gt;');expect(html).not.toContain('<script>');
  expect(html).toContain('In a party');
});
it('uses the Nexus account and exposes no embedded website or pretend party controls',()=>{
  const api={popOutXboxChat:async()=>{},openXboxPlayerProfile:async()=>{},getXboxPlayerDetails:async()=>({xuid:'1',gamertag:'Player',gamerscore:null}),getXboxPlayerGames:async()=>({items:[]}),getXboxPeople:async()=>({items:[]}),getXboxRelationship:async()=>({xuid:'1',isFriend:false,isFollowing:false,isFollower:false,favorite:false,blocked:false,requestState:'none' as const}),changeXboxRelationship:async()=>{},getXboxGameInviteAvailability:async()=>({canInvite:false}),sendXboxGameInvite:async()=>{},getXboxPlayerProfile:async()=>({xuid:'1',gamertag:'Player',gamerscore:null}),getXboxProfileRequest:async()=>undefined,onXboxProfileRequest:()=>()=>{},completeXboxProfileRequest:async()=>{},getXboxFriends:async()=>[],getXboxInbox:async()=>[],getXboxConversation:async()=>[],sendXboxMessage:async()=>({id:'sent-id'})};
  const html=renderToStaticMarkup(<XboxSocial auth={{running:false,stored:true,username:'account',gamertag:'Example',note:''}} api={api} overlay close={()=>{}}/>);
  expect(html).toContain('Social');expect(html).toContain('Example');expect(html).toContain('Chats');
  expect(html).not.toMatch(/iframe|webview|xbox\.com|Start a party/);
});
