// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {XboxProfileGame,XboxProfileGames as ProfileGames,XboxSocialApi} from '../shared/types';
import {XboxProfileGames} from './XboxProfileGames';

let root:Root,node:HTMLDivElement;
const game=(patch:Partial<XboxProfileGame>={}):XboxProfileGame=>({titleId:'123',name:'Synthetic Game',...patch});
const api=(value:ProfileGames|Error)=>({getXboxPlayerGames:vi.fn(async()=>{if(value instanceof Error)throw value;return value;})} as unknown as XboxSocialApi);
const mount=async(element:React.ReactElement)=>{
  await act(async()=>{root.render(element);});
  await act(async()=>{await Promise.resolve();});
};
beforeEach(()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
  node=document.createElement('div');document.body.append(node);root=createRoot(node);
});
afterEach(async()=>{
  await act(async()=>root.unmount());
  node.remove();vi.restoreAllMocks();document.body.innerHTML='';
});

it('shows an accessible placeholder when the service supplies no artwork',async()=>{
  await mount(<XboxProfileGames api={api({items:[game()],continuation:null,truncated:false})} xuid="2"/>);
  expect(node.querySelector('img')).toBeNull();
  const placeholder=node.querySelector('[role="img"]')!;
  expect(placeholder.getAttribute('aria-label')).toBe('Artwork unavailable');
  expect(node.textContent).toContain('Synthetic Game');
});

it('renders artwork without a referrer and falls back to the placeholder after a load error',async()=>{
  await mount(<XboxProfileGames api={api({items:[game({imageUrl:'https://store-images.s-microsoft.com/image/boxart'})],continuation:null,truncated:false})} xuid="2"/>);
  const image=node.querySelector('img')!;
  expect(image.getAttribute('src')).toBe('https://store-images.s-microsoft.com/image/boxart');
  expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
  expect(image.getAttribute('alt')).toBe('');
  await act(async()=>{image.dispatchEvent(new Event('error',{bubbles:true}));});
  expect(node.querySelector('img')).toBeNull();
  expect(node.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Artwork unavailable');
});

it('keeps the history failure isolated from the profile shell',async()=>{
  await mount(<XboxProfileGames api={api(Error('private'))} xuid="2"/>);
  expect(node.textContent).toContain('It may be private');
  expect(node.querySelector('button')?.textContent).toContain('Try again');
});
