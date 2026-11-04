// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {installGamepadNavigation} from './gamepad-navigation';
import {gamepadHarness} from './gamepad-test-harness';
let stop:()=>void,h:ReturnType<typeof gamepadHarness>,keyboard:ReturnType<typeof vi.fn>,search:ReturnType<typeof vi.fn>;
const get=(id:string)=>document.getElementById(id)!;
beforeEach(()=>{
 document.body.innerHTML='<aside class="sidebar"><button class="nav-item active">Settings</button></aside><section class="content-shell"><header class="topbar"><div class="search-box"><input id="search" type="search" data-test-rect="300,10,300,40"></div></header><div class="page-scroll" data-gamepad-page="settings"><main class="settings-page"><input id="first" data-test-rect="300,120,300,40"><input id="middle" type="number" data-test-rect="300,200,300,40"><select id="last" data-test-rect="300,280,300,40"><option>One</option></select></main></div></section>';
 h=gamepadHarness();keyboard=vi.fn(async()=>false);search=vi.fn(()=>get('search').focus());
 stop=installGamepadNavigation(window,{mode:vi.fn(),back:vi.fn(),page:vi.fn(),keyboard,search});h.step();get('first').focus();h.press(2);
});
afterEach(()=>{stop();vi.restoreAllMocks();document.body.innerHTML='';});
it('reaches top search from the page edge and Down returns to the remembered Settings field',()=>{
 h.press(12);expect(document.activeElement).toBe(get('search'));expect(keyboard).not.toHaveBeenCalled();
 h.press(0);expect(keyboard).toHaveBeenCalledOnce();h.press(13);expect(document.activeElement).toBe(get('first'));
});
it('keeps Up within the current page while another field is available',()=>{
 get('middle').focus();h.press(12);expect(document.activeElement).toBe(get('first'));expect(search).not.toHaveBeenCalled();
});
it('never escapes a modal scope into the top search',()=>{
 document.body.insertAdjacentHTML('beforeend','<section role="dialog" aria-modal="true"><input id="modal" data-gamepad-initial data-test-rect="300,120,300,40"></section>');
 h.step();get('modal').focus();h.press(12);expect(document.activeElement).toBe(get('modal'));expect(search).not.toHaveBeenCalled();
});
it('retains the explicit Y search shortcut',()=>{
 get('middle').focus();h.press(3);expect(search).toHaveBeenCalledOnce();expect(document.activeElement).toBe(get('search'));
});
it('retains access to number and select fields without opening the keyboard during navigation',()=>{
 h.press(13);expect(document.activeElement).toBe(get('middle'));expect(keyboard).not.toHaveBeenCalled();
 h.press(0);expect(keyboard).toHaveBeenCalledWith(expect.objectContaining({mode:3}));h.press(13);expect(document.activeElement).toBe(get('last'));
});
it('leaves a nested grid for a higher page action before reaching global search',()=>{
 const page=document.querySelector('.page-scroll')!;page.setAttribute('data-gamepad-page','home');
 page.innerHTML='<main class="home-page"><button id="spotlight" data-test-rect="700,100,180,44">Spotlight action</button><div data-gamepad-grid><button id="nested" data-test-rect="300,220,180,100">First grid row</button></div></main>';
 get('nested').focus();h.press(12);expect(document.activeElement).toBe(get('spotlight'));
 h.press(12);expect(document.activeElement).toBe(get('search'));
});
