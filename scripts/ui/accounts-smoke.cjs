// Run with Electron. Exercises only session-only demo account UI using synthetic identities.
// XODUS_UI_SMOKE_OUTPUT must be a new private directory. Optional
// XODUS_UI_SMOKE_SOURCE selects a built checkout (defaults to this checkout).
// English-only synthetic account screenshots.
const {app,session,ipcMain} = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const source = path.resolve(process.env.XODUS_UI_SMOKE_SOURCE || path.join(__dirname,'../..'));
const output = process.env.XODUS_UI_SMOKE_OUTPUT;
if (!output || !path.isAbsolute(output)) throw Error('Set XODUS_UI_SMOKE_OUTPUT to a new absolute private directory');
if (process.argv.some(value=>value==='--launch-game'||value==='--nexus-profile')) throw Error('Demo fixture does not accept game or profile arguments');
process.env.XODUS_DEMO = '1';
app.disableHardwareAcceleration();
const language='en-US';
app.commandLine.appendSwitch('lang',language);
// Never inherit another capture action or a developer server from the caller.
for (const name of ['VITE_DEV_SERVER_URL','XODUS_DEMO_CAPTURE_DIR','XODUS_DEMO_TOUR','XODUS_NEXUS_SMOKE_SCREENSHOT','XODUS_NEXUS_SMOKE_STORE','XODUS_NEXUS_SMOKE_STORE_QUERY','XODUS_NEXUS_FONTCONFIG','XODUS_NEXUS_FONTCONFIG_ORIGINAL','XODUS_NEXUS_FONTCONFIG_ORIGINAL_SET']) delete process.env[name];
// Block both main-process Store requests and renderer artwork. This fixture
// needs no network and cannot accidentally fall through to live account APIs.
globalThis.fetch = async () => { throw Error('Network disabled by demo UI fixture'); };
let completed = false;
const timer = setTimeout(()=>{console.error('Demo runtime-settings smoke timed out');app.exit(1);},30000);
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
  await ready(window,'.sidebar nav button');
  await evaluate(window,()=>[...document.querySelectorAll('.sidebar-bottom button')].find(button=>button.textContent.trim()==='Settings').click());
  await ready(window,'.account-card');
  for(const [width,height] of [[1280,800],[800,600]])for(const state of ['single','enabled','collapsed-player']) {
    window.setContentSize(width,height);
    const fixture=structuredClone(snapshot);
    Object.assign(fixture.backend.capabilities,{playerAccount:true,savedAccounts:true,licenseProfile:true});
    fixture.settings.multiAccountEnabled=state==='enabled';
    fixture.auth=state==='single'?{running:false,stored:true,username:'single.account@example.test',gamertag:'SinglePlayer',saved:[],savedAccountsEnabled:false,note:'Sign-in saved on this device.'}:{running:false,stored:true,username:'shared.store@example.test',player:'personal.player@example.test',gamertag:'PersonalPlayer',saved:['shared.store@example.test','purchased.games@example.test'],savedAccountsEnabled:true,note:'Synthetic Store licensing account with a separate Xbox player.'};
    window.webContents.send('snapshot',fixture);await settle(window);
    await evaluate(window,()=>document.querySelector('.account-card').scrollIntoView({block:'start'}));await settle(window);
    const bounds=await evaluate(window,()=>({viewport:[innerWidth,innerHeight],documentWidth:document.documentElement.scrollWidth,language:document.documentElement.lang,cards:[...document.querySelectorAll('.account-card')].map(card=>({text:card.textContent,box:(()=>{const r=card.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};})()}))}));
    if(bounds.documentWidth>width||bounds.language!=='en'||bounds.cards.length!==(state==='enabled'?2:1)||bounds.cards.some(card=>card.box.left<0||card.box.right>width))throw Error('Account UI bounds/language failed: '+JSON.stringify(bounds));
    if(state==='enabled'&&(!bounds.cards[1].text.includes('personal.player@example.test')||!bounds.cards[0].text.includes('purchased.games@example.test')))throw Error('Independent synthetic identities missing');
    if(state!=='enabled'&&bounds.cards[0].text.includes('purchased.games@example.test'))throw Error('Saved Store list visible before opt-in');
    if(state==='single'&&!bounds.cards[0].text.includes('Manage multiple accounts'))throw Error('Missing minimal opt-in action');
    if(state==='collapsed-player'&&!bounds.cards[0].text.includes('Xbox player: personal.player@example.test'))throw Error('Collapsed player identity missing');
    await fs.writeFile(path.join(output,`accounts-${state}-${width}x${height}.png`),(await window.webContents.capturePage()).toPNG());
    if(state==='enabled'&&bounds.cards[1].box.bottom>height) {
      await evaluate(window,()=>document.querySelectorAll('.account-card')[1].scrollIntoView({block:'center'}));await settle(window);
      await fs.writeFile(path.join(output,`accounts-${state}-player-${width}x${height}.png`),(await window.webContents.capturePage()).toPNG());
    }
    results.push({state,width,height,...bounds});
  }
  await fs.writeFile(path.join(output,'account-results.json'),JSON.stringify({source,scope:'Compiled English session-only demo with distinct synthetic Store/player identities. Main fetch and renderer network disabled. No real credentials, backend, games or saves.',results},null,2)+'\n');
  completed=true;clearTimeout(timer);app.exit(0);
}
(async()=>{
  // Refuse an existing directory, so no saved profile or prior result is reused.
  await fs.mkdir(output,{mode:0o700});
  const profile=path.join(output,'profile');await fs.mkdir(profile,{mode:0o700});
  app.setPath('userData',profile);
  app.on('browser-window-created',(_event,window)=>{
    window.show=()=>{};window.hide();window.webContents.setBackgroundThrottling(false);
    window.webContents.once('did-finish-load',()=>void capture(window).catch(error=>{console.error(error);app.exit(1);}));
  });
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(_details,callback)=>callback({cancel:true}));
  // Use the built-in offscreen smoke surface, while this fixture owns exit.
  process.env.XODUS_NEXUS_SMOKE_SCREENSHOT=path.join(output,'built-in-smoke.png');
  app.quit=()=>{};
  await import(pathToFileURL(path.join(source,'dist-electron/main/index.js')).href);
})().catch(error=>{console.error(error);clearTimeout(timer);app.exit(1);});
app.on('will-quit',()=>{if(!completed)clearTimeout(timer);});
