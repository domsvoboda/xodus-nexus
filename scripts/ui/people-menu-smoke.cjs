// Run with Electron. Exercises only the launcher's session-only demo Social APIs.
// XODUS_UI_SMOKE_OUTPUT must be a new private directory. Optional
// XODUS_UI_SMOKE_SOURCE selects a built checkout (defaults to this checkout).
const {app,session} = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const source = path.resolve(process.env.XODUS_UI_SMOKE_SOURCE || path.join(__dirname,'../..'));
const output = process.env.XODUS_UI_SMOKE_OUTPUT;
if (!output || !path.isAbsolute(output)) throw Error('Set XODUS_UI_SMOKE_OUTPUT to a new absolute private directory');
if (process.argv.some(value=>value==='--launch-game'||value==='--nexus-profile')) throw Error('Demo fixture does not accept game or profile arguments');
process.env.XODUS_DEMO = '1';
// Never inherit another capture action or a developer server from the caller.
for (const name of ['VITE_DEV_SERVER_URL','XODUS_DEMO_CAPTURE_DIR','XODUS_DEMO_TOUR','XODUS_NEXUS_SMOKE_SCREENSHOT','XODUS_NEXUS_SMOKE_STORE','XODUS_NEXUS_SMOKE_STORE_QUERY','XODUS_NEXUS_FONTCONFIG','XODUS_NEXUS_FONTCONFIG_ORIGINAL','XODUS_NEXUS_FONTCONFIG_ORIGINAL_SET']) delete process.env[name];
// Block both main-process Store requests and renderer artwork. This fixture
// needs no network and cannot accidentally fall through to live account APIs.
globalThis.fetch = async () => { throw Error('Network disabled by demo UI fixture'); };
let completed = false;
const timer = setTimeout(()=>{console.error('Demo People smoke timed out');app.exit(1);},30000);
const evaluate = (window, fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
const ready = async (window, selector) => evaluate(window, async selector => {
  const deadline=Date.now()+6000;
  while(!document.querySelector(selector)) {
    if(Date.now()>deadline)throw Error('Missing demo element: '+selector);
    await new Promise(resolve=>setTimeout(resolve,30));
  }
},selector);
const settle = window => evaluate(window,async()=>{
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  await Promise.race([Promise.all(document.getAnimations().filter(animation=>Number.isFinite(animation.effect?.getTiming().iterations)).map(animation=>animation.finished.catch(()=>{}))),new Promise(resolve=>setTimeout(resolve,500))]);
});
async function capture(window) {
  const results=[];
  const snapshot=await evaluate(window,()=>window.launcher.getSnapshot());
  if(snapshot.auth.username!=='sample@example.test')throw Error('Expected isolated sample account');
  for(const [width,height] of [[1280,800],[800,600]]) {
    window.setContentSize(width,height);await settle(window);
    await ready(window,'[data-gamepad-social-toggle]');
    if(!await evaluate(window,()=>document.querySelector('[data-gamepad-social-toggle]').getAttribute('aria-expanded')==='true')) {
      await evaluate(window,()=>document.querySelector('[data-gamepad-social-toggle]').click());
    }
    await ready(window,'.social-person-more');
    await settle(window);
    await evaluate(window,()=>document.querySelector('.social-person-more').click());
    await ready(window,'.social-person-menu [role="menuitem"]');
    await settle(window);
    const layout=await evaluate(window,()=>{
      const menu=document.querySelector('.social-person-menu'),rect=menu.getBoundingClientRect();
      return {viewport:[innerWidth,innerHeight],rootScroll:[document.documentElement.scrollLeft,document.body.scrollLeft],menu:{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom},
        focusInMenu:menu.contains(document.activeElement),shelfOpen:document.querySelector('[data-gamepad-social-toggle]').getAttribute('aria-expanded')==='true',
        scrollable:menu.scrollHeight>menu.clientHeight,items:menu.querySelectorAll('[role="menuitem"]').length};
    });
    if(layout.viewport[0]!==width||layout.viewport[1]!==height||layout.menu.left<0||layout.menu.right>width||layout.menu.top<0||layout.menu.bottom>height||!layout.focusInMenu||!layout.shelfOpen||!layout.items)throw Error('People menu outside viewport or missing focus: '+JSON.stringify(layout));
    await fs.writeFile(path.join(output,`people-menu-${width}x${height}.png`),(await window.webContents.capturePage()).toPNG());
    await evaluate(window,()=>document.querySelector('.social-person-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
    await settle(window);
    const restored=await evaluate(window,()=>!document.querySelector('.social-person-menu')&&document.activeElement?.matches('.social-person-more')&&document.querySelector('[data-gamepad-social-toggle]').getAttribute('aria-expanded')==='true');
    if(!restored)throw Error('Escape did not restore the menu trigger while keeping Social open');
    results.push({...layout,width,height,escapeRestored:true});
  }
  await fs.writeFile(path.join(output,'people-menu-results.json'),JSON.stringify({source,results},null,2)+'\n');
  completed=true;clearTimeout(timer);app.exit(0);
}
(async()=>{
  // Refuse an existing directory, so no saved profile or prior result is reused.
  await fs.mkdir(output,{mode:0o700});
  const profile=path.join(output,'profile');await fs.mkdir(profile,{mode:0o700});
  app.setPath('userData',profile);
  app.on('browser-window-created',(_event,window)=>{
    window.show=()=>{};
    window.webContents.once('did-finish-load',()=>void capture(window).catch(error=>{console.error(error);app.exit(1);}));
  });
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(_details,callback)=>callback({cancel:true}));
  await import(pathToFileURL(path.join(source,'dist-electron/main/index.js')).href);
})().catch(error=>{console.error(error);clearTimeout(timer);app.exit(1);});
app.on('will-quit',()=>{if(!completed)clearTimeout(timer);});
