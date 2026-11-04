// Run with Electron. Exercises top-left hit targets and actual controller focus.
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
const timer = setTimeout(()=>{console.error('Demo Store eligibility smoke timed out');app.exit(1);},90000);
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
  await evaluate(window,()=>{
    window.__smokePad={index:0,id:'isolated standard fixture',connected:true,mapping:'standard',buttons:Array.from({length:17},()=>({pressed:false,value:0})),axes:[0,0,0,0]};
    Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>[window.__smokePad]});
    document.hasFocus=()=>true;
  });
  const press=button=>evaluate(window,async button=>{
    const frames=async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);};
    window.__smokePad.buttons[button]={pressed:true,value:1};await frames();
    window.__smokePad.buttons[button]={pressed:false,value:0};await frames();
  },button);
  await evaluate(window,async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);});
  const keyboardRequests=[];ipcMain.removeHandler('show-touch-keyboard');ipcMain.handle('show-touch-keyboard',(_event,field)=>{keyboardRequests.push(field);return false;});
  const requireFixed=process.env.XODUS_UI_SMOKE_REQUIRE_FIXED!=='0';
  for(const [width,height] of [[1280,800],[800,600]])for(const mode of ['single','expanded']){
    window.setContentSize(width,height);window.webContents.send('launcher-page','settings');await ready(window,'.settings-page');await settle(window);
    const fixture=structuredClone(initial);fixture.settings.interfaceLanguage='en';fixture.settings.firstRunCompleted=true;fixture.auth.gamertag='SyntheticPlayer';fixture.settings.multiAccountEnabled=mode==='expanded';fixture.auth.savedAccountsEnabled=mode==='expanded';fixture.auth.saved=['sample@example.test','second@example.test'];if(mode==='expanded'){fixture.backend.capabilities.savedAccounts=true;fixture.backend.capabilities.playerAccount=true;fixture.auth.player='synthetic.player@example.test';}window.webContents.send('snapshot',fixture);await settle(window);
    await evaluate(window,()=>{
      document.querySelectorAll('.settings-page details').forEach(el=>el.open=true);
      const elements=[...document.querySelectorAll('.settings-page button,.settings-page input,.settings-page select,.settings-page textarea,.settings-page summary,.search-box input')].filter(el=>!el.matches(':disabled,[aria-disabled="true"]')&&el.tabIndex>=0&&el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden');
      elements.forEach((el,i)=>el.dataset.smokeFocusKey='field-'+i);
      window.__smokeFields=elements.map(el=>({key:el.dataset.smokeFocusKey,tag:el.tagName,type:el.type,label:el.getAttribute('aria-label')||el.closest('label')?.textContent?.slice(0,100)||el.textContent?.slice(0,100),search:el.matches('.search-box input')}));
    });
    await press(2);
    const fields=await evaluate(window,()=>window.__smokeFields),edges={};
    for(const field of fields.filter(field=>!field.search)){
      edges[field.key]={};
      for(const [direction,button] of [['up',12],['down',13],['left',14],['right',15]]){
        await evaluate(window,key=>document.querySelector(`[data-smoke-focus-key="${key}"]`).focus({preventScroll:true}),field.key);await press(button);
        edges[field.key][direction]=await evaluate(window,()=>document.activeElement?.dataset.smokeFocusKey||document.activeElement?.className||document.activeElement?.tagName);
      }
    }
    const geometry=await evaluate(window,()=>{
      document.querySelector('.page-scroll').scrollTop=0;
      const box=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
      const hit=selector=>{const el=document.querySelector(selector),r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));};
      return {language:document.documentElement.lang,documentWidth:document.documentElement.scrollWidth,account:box('.account-summary'),bell:box('.notification-bell'),avatar:box('.account-avatar'),accountHit:hit('.account-summary'),bellHit:hit('.notification-bell')};
    });
    const top=await evaluate(window,()=>[...document.querySelectorAll('.settings-page [data-smoke-focus-key]')].filter(el=>el.getClientRects().length&&!el.matches(':disabled,[aria-disabled="true"]')).sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top)[0].dataset.smokeFocusKey);
    await evaluate(window,key=>document.querySelector(`[data-smoke-focus-key="${key}"]`).focus({preventScroll:true}),top);await press(12);
    const topUp=await evaluate(window,()=>({key:document.activeElement?.dataset.smokeFocusKey,search:document.activeElement?.matches('.search-box input')}));
    const keys=new Set(fields.map(field=>field.key)),reached=new Set([top]),queue=[top];
    while(queue.length)for(const target of Object.values(edges[queue.pop()]??{}))if(keys.has(target)&&!reached.has(target)){reached.add(target);queue.push(target);}
    const unreachable=fields.filter(field=>!reached.has(field.key));
    const a=geometry.account,b=geometry.bell,v=geometry.avatar;
    const overlap=(a,b)=>Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
    const hits=geometry.accountHit&&geometry.bellHit&&a.width>=44&&a.height>=44&&b.width>=44&&b.height>=44&&!overlap(a,b)&&!overlap(v,b)&&v.left>=a.left&&v.right<=a.right;
    const beforeKeyboard=keyboardRequests.length;await press(0);await settle(window);
    const acceptKeyboard=keyboardRequests.length===beforeKeyboard+1&&keyboardRequests.at(-1)?.mode===0;
    await fs.writeFile(path.join(output,`search-${mode}-${width}x${height}.png`),(await window.webContents.capturePage()).toPNG());
    await press(13);const downReturn=await evaluate(window,key=>document.activeElement?.dataset.smokeFocusKey===key,top);
    await settle(window);await fs.writeFile(path.join(output,`settings-${mode}-${width}x${height}.png`),(await window.webContents.capturePage()).toPNG());
    const beforeY=keyboardRequests.length;await press(3);await settle(window);
    const ySearch=await evaluate(window,()=>document.activeElement?.matches('.search-box input'));
    const yKeyboard=ySearch&&keyboardRequests.length===beforeY+1;
    if(mode==='expanded'){
      await evaluate(window,()=>document.querySelector('.saved-accounts')?.scrollIntoView({block:'center'}));await settle(window);
      await fs.writeFile(path.join(output,`accounts-${mode}-${width}x${height}.png`),(await window.webContents.capturePage()).toPNG());
    }
    await evaluate(window,()=>document.querySelector('.account-summary').focus({preventScroll:true}));
    window.webContents.sendInputEvent({type:'keyDown',keyCode:'TAB'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'TAB'});await settle(window);
    const tabBell=await evaluate(window,()=>document.activeElement?.matches('.notification-bell'));
    await evaluate(window,()=>document.querySelector('.account-summary').focus({preventScroll:true}));await press(2);await press(width<=1100?13:15);
    const padBell=await evaluate(window,()=>document.activeElement?.matches('.notification-bell'));
    if(requireFixed&&(!tabBell||!padBell))throw Error('Profile/bell keyboard or controller route failed');
    let bellModal=false,bellReturn=false;
    if(padBell){
      await press(0);await ready(window,'.notification-panel');await press(12);
      bellModal=await evaluate(window,()=>Boolean(document.activeElement?.closest('.notification-panel')));
      await fs.writeFile(path.join(output,`notifications-${mode}-${width}x${height}.png`),(await window.webContents.capturePage()).toPNG());
      await press(1);bellReturn=await evaluate(window,()=>!document.querySelector('.notification-panel')&&document.activeElement?.matches('.notification-bell'));
    }
    if(requireFixed&&(!bellModal||!bellReturn))throw Error('Notification modal controller containment/return failed');
    if(requireFixed&&(!topUp.search||!downReturn||!acceptKeyboard||!yKeyboard||!hits||unreachable.length||geometry.language!=='en'||geometry.documentWidth>width))throw Error('Issue455 check failed: '+JSON.stringify({width,height,mode,topUp,downReturn,acceptKeyboard,yKeyboard,hits,unreachable,geometry}));
    results.push({width,height,mode,fields,edges,geometry,top,topUp,downReturn,acceptKeyboard,yKeyboard,hits,unreachable,tabBell,padBell,bellModal,bellReturn});
  }
  await fs.writeFile(path.join(output,'issue455-results.json'),JSON.stringify({source,scope:'Actual English demo with synthetic standard controller; network blocked. Directional focus and intercepted synthetic keyboard IPC only, no settings saved/accounts/games/backend/Steam actions.',results},null,2)+'\n');
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
