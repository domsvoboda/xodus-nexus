// Run with Electron. Exercises Store actions using explicitly synthetic account access.
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
const timer = setTimeout(()=>{console.error('Demo Store eligibility smoke timed out');app.exit(1);},30000);
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
  const initial=await evaluate(window,()=>window.launcher.getSnapshot());
  if(initial.auth.username!=='sample@example.test')throw Error('Expected isolated sample account');
  const ids=['9AAAAAAAAAAA','9BBBBBBBBBBB','9CCCCCCCCCCC','9DDDDDDDDDDD'];
  const products=ids.map((productId,index)=>({productId,title:['Retail PC Adventure','Retail PC Racing','Retail PC Strategy','Retail PC Puzzle'][index],publisher:'Sample Studio',description:'Explore this retail PC game.',categories:['Action'],installability:'supported',supportNote:'Windows.Desktop MSIXVC',purchasePrice:'$29.99',includedWith:'Game Pass',storeUrl:`https://www.xbox.com/games/store/p/${productId}`}));
  let fixture,licensed=false;
  const replace=(name,handler)=>{ipcMain.removeHandler(name);ipcMain.handle(name,handler);};
  replace('catalog-featured',()=>({query:'',products,hasMore:false}));
  replace('store-access',()=>({account:fixture.auth.username,backend:fixture.backend.binaryPath,market:'US',configuredMarket:fixture.settings.market,checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),accessByProductId:licensed?Object.fromEntries(ids.map(id=>[id,'owned'])):{}}));
  replace('game-details',()=>({...products[0],description:'Explore this retail PC game. Store availability is shown independently of this account license.',screenshots:[],features:[],genres:['Action']}));
  replace('game-activity',()=>({status:'unavailable'}));replace('game-achievements',()=>({status:'unavailable'}));
  for(const [width,height] of [[1280,800],[800,600]])for(const state of ['unlicensed','licensed']){
    licensed=state==='licensed';window.setContentSize(width,height);
    window.webContents.send('launcher-page','home');await settle(window);
    fixture=structuredClone(initial);fixture.games=[];fixture.downloads=[];fixture.settings.market='US';fixture.settings.interfaceLanguage='en';fixture.settings.firstRunCompleted=true;
    fixture.auth={running:false,stored:true,username:'store.license@example.test',player:'personal.player@example.test',gamertag:'PersonalPlayer',note:'Synthetic account fixture'};
    window.webContents.send('snapshot',fixture);window.webContents.send('launcher-page','store');
    await ready(window,'.catalog-card');await settle(window);
    const grid=await evaluate(window,()=>({language:document.documentElement.lang,width:document.documentElement.scrollWidth,actions:[...document.querySelectorAll('.catalog-card-install')].map(button=>button.textContent),manualForm:Boolean(document.querySelector('.manual-install'))}));
    if(grid.width>width||grid.language!=='en'||grid.manualForm||grid.actions.some(label=>label!==(licensed?'Install':'Store page')))throw Error('Store grid eligibility failed: '+JSON.stringify(grid));
    await fs.writeFile(path.join(output,`store-${state}-grid-${width}x${height}.png`),(await window.webContents.capturePage()).toPNG());
    await evaluate(window,()=>document.querySelector('.featured-tile').click());await ready(window,'.game-details-page');await settle(window);
    const detail=await evaluate(window,()=>({language:document.documentElement.lang,width:document.documentElement.scrollWidth,install:[...document.querySelectorAll('.gd-play-controls button')].some(button=>button.textContent==='Install'),storePage:[...document.querySelectorAll('.gd-play-controls button')].some(button=>button.textContent==='Store page'),location:Boolean(document.querySelector('.gd-install-options input'))}));
    if(detail.width>width||detail.language!=='en'||detail.install!==licensed||detail.location!==licensed||!detail.storePage)throw Error('Store detail eligibility failed: '+JSON.stringify(detail));
    await evaluate(window,()=>document.querySelector('.gd-play-controls').scrollIntoView({block:'center'}));await settle(window);
    await fs.writeFile(path.join(output,`store-${state}-detail-${width}x${height}.png`),(await window.webContents.capturePage()).toPNG());
    results.push({state,width,height,grid,detail});
  }
  await fs.writeFile(path.join(output,'store-access-results.json'),JSON.stringify({source,scope:'Actual compiled English demo, synthetic Store license evidence only. Network blocked in main and renderer. No real accounts, installations, games or saves.',results},null,2)+'\n');
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
