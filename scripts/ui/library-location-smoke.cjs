// Run with Electron. Exercises only the launcher's session-only demo Library APIs.
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
const language=process.env.XODUS_UI_SMOKE_LANG || 'en-US';
const fixtureFolder=process.env.XODUS_UI_SMOKE_LONG_PATH==='1' ? '/run/media/deck/External Games and Archives/Shared Xbox Installations/Very long directory name for removable storage' : undefined;
app.commandLine.appendSwitch('lang',language);
// Never inherit another capture action or a developer server from the caller.
for (const name of ['VITE_DEV_SERVER_URL','XODUS_DEMO_CAPTURE_DIR','XODUS_DEMO_TOUR','XODUS_NEXUS_SMOKE_SCREENSHOT','XODUS_NEXUS_SMOKE_STORE','XODUS_NEXUS_SMOKE_STORE_QUERY','XODUS_NEXUS_FONTCONFIG','XODUS_NEXUS_FONTCONFIG_ORIGINAL','XODUS_NEXUS_FONTCONFIG_ORIGINAL_SET']) delete process.env[name];
// Block both main-process Store requests and renderer artwork. This fixture
// needs no network and cannot accidentally fall through to live account APIs.
globalThis.fetch = async () => { throw Error('Network disabled by demo UI fixture'); };
let completed = false;
const timer = setTimeout(()=>{console.error('Demo Library smoke timed out');app.exit(1);},30000);
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
  await ready(window,'.sidebar nav button:nth-child(2)');
  await evaluate(window,()=>document.querySelector('.sidebar nav button:nth-child(2)').click());
  await ready(window,'.library-filter-location select');
  if(fixtureFolder)snapshot.games[0].path=fixtureFolder+'/SyntheticDemoGame';
  for(const [width,height] of [[1280,800],[800,600]]) {
    window.setContentSize(width,height);
    if(fixtureFolder)window.webContents.send('snapshot',snapshot);
    await settle(window);
    await evaluate(window,fixtureFolder=>{
      const select=document.querySelector('.library-filter-location select');
      const folder=[...select.options].find(option=>fixtureFolder ? option.value===fixtureFolder : option.value);
      if(!folder)throw Error('No demo installation folder');
      select.value=folder.value;select.dispatchEvent(new Event('change',{bubbles:true}));select.focus();
    },fixtureFolder);
    await settle(window);
    const layout=await evaluate(window,()=>{
      const selector=document.querySelector('.library-filter-location select');
      const controls=[...document.querySelectorAll('.library-filters select,.library-filters input,.library-refresh')].map(control=>{
        const r=control.getBoundingClientRect();return {label:control.getAttribute('aria-label'),left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,width:r.width,search:control.matches('.library-filter-search input'),location:control.matches('.library-filter-location select')};
      });
      return {viewport:[innerWidth,innerHeight],documentWidth:document.documentElement.scrollWidth,lang:document.documentElement.lang,languages:navigator.languages,controls,
        focusIsLocation:document.activeElement===selector,selected:selector.value,installedState:document.querySelector('.library-filters label:nth-child(2) select').value,
        localCards:document.querySelectorAll('.library-card').length,accountCards:document.querySelectorAll('.catalog-card-install').length,
        allLocations:selector.options[0].text};
    });
    if(layout.viewport[0]!==width||layout.viewport[1]!==height||layout.documentWidth>width||!layout.focusIsLocation||layout.installedState!=='installed'||!layout.localCards||layout.accountCards||layout.controls.some(control=>control.left<0||control.right>width||control.top<0||control.bottom>height||control.height<44||(control.search&&control.width<150)||(control.location&&control.width>300)))throw Error('Demo library bounds/focus failed: '+JSON.stringify(layout));
    await fs.writeFile(path.join(output,`library-${width}x${height}.png`),(await window.webContents.capturePage()).toPNG());
    window.webContents.sendInputEvent({type:'keyDown',keyCode:'TAB'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'TAB'});
    await settle(window);
    const tabReachedSearch=await evaluate(window,()=>document.activeElement?.matches('.library-filter-search input'));
    if(!tabReachedSearch)throw Error('Tab did not reach Search from location selector');
    window.webContents.sendInputEvent({type:'keyDown',keyCode:'TAB',modifiers:['shift']});window.webContents.sendInputEvent({type:'keyUp',keyCode:'TAB',modifiers:['shift']});
    await settle(window);
    const shiftTabRestored=await evaluate(window,()=>document.activeElement?.matches('.library-filter-location select'));
    if(!shiftTabRestored)throw Error('Shift+Tab did not restore location focus');
    results.push({...layout,width,height,tabReachedSearch,shiftTabRestored});
  }
  await fs.writeFile(path.join(output,'library-location-results.json'),JSON.stringify({source,language,fixtureFolder,results,scope:fixtureFolder ? 'Actual demo renderer with explicitly synthetic in-memory long-path snapshot, network blocked, isolated profile' : 'Actual demo launcher, network blocked, isolated profile, recorded demo folder only'},null,2)+'\n');
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
