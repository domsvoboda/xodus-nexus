// Run with Electron. Exercises only the launcher's session-only demo runtime-settings UI with explicitly synthetic family descriptors.
// XODUS_UI_SMOKE_OUTPUT must be a new private directory. Optional
// XODUS_UI_SMOKE_SOURCE selects a built checkout (defaults to this checkout).
// Spanish is the default language for this long-label fixture.
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
const language=process.env.XODUS_UI_SMOKE_LANG || 'es-ES';
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
  const results=[],requests=[];
  const snapshot=await evaluate(window,()=>window.launcher.getSnapshot());
  if(snapshot.auth.username!=='sample@example.test')throw Error('Expected isolated sample account');
  const family='nexus-cachyos';
  const a={buildId:'a'.repeat(64),manifestSha256:'b'.repeat(64),sourceCommit:'c'.repeat(40)};
  const b={buildId:'d'.repeat(64),manifestSha256:'e'.repeat(64),sourceCommit:'f'.repeat(40)};
  let choices=[];
  // Replace only demo handlers in this isolated process. No real family receipt,
  // account, runtime, prefix or installed-game filesystem operation is invoked.
  ipcMain.removeHandler('runtime-families');ipcMain.handle('runtime-families',()=>choices);
  ipcMain.removeHandler('update-game');ipcMain.handle('update-game',(_event,id,patch)=>{requests.push({id,patch});return {...snapshot.games[0],...patch};});
  const spanish=JSON.parse(await fs.readFile(path.join(source,'assets/locales/es.json'),'utf8'));
  const settingsLabel=spanish['ui.game_settings_fece860'];
  await ready(window,'.sidebar nav button:nth-child(2)');
  await evaluate(window,()=>document.querySelector('.sidebar nav button:nth-child(2)').click());
  await ready(window,'.library-card-menu-button');
  await evaluate(window,async()=>{
    Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>true});
    window.__smokePad={index:0,id:'isolated smoke standard controller',connected:true,mapping:'standard',buttons:Array.from({length:17},()=>({pressed:false,value:0})),axes:[0,0,0,0]};
    Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>[window.__smokePad]});
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  });
  const press=async button=>evaluate(window,async button=>{
    window.__smokePad.buttons[button]={pressed:true,value:1};
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    window.__smokePad.buttons[button]={pressed:false,value:0};
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  },button);
  const open=async()=>{
    await evaluate(window,()=>{document.querySelector('.library-card').focus();document.querySelector('.library-card-menu-button').click();});
    await ready(window,'.game-context-menu [role="menuitem"]');await settle(window);
    await evaluate(window,label=>{const item=[...document.querySelectorAll('.game-context-menu button')].find(button=>button.textContent.trim()===label);if(!item)throw Error('Missing settings menu item');item.focus();item.click();},settingsLabel);
    await ready(window,'.game-dialog form');await settle(window);
  };
  const closed=()=>evaluate(window,async()=>{const end=Date.now()+3000;while(document.querySelector('.game-dialog form')){if(Date.now()>end)throw Error('Dialog did not close');await new Promise(resolve=>setTimeout(resolve,20));}});
  for(const [width,height] of [[1280,800],[800,600]])for(const variant of ['default','unavailable','synthetic-installed-update']) {
    await evaluate(window,async()=>{const end=Date.now()+6500;while(document.querySelector('.toast')){if(Date.now()>end)throw Error('Previous synthetic Save toast did not expire');await new Promise(resolve=>setTimeout(resolve,50));}});
    window.setContentSize(width,height);requests.length=0;
    const fixture=structuredClone(snapshot);fixture.games=[{...fixture.games[0]}];
    choices=variant==='synthetic-installed-update'?[{id:family,label:'Nexus Runtime (CachyOS, experimental)',...b}]:[];
    fixture.runtime.variants=choices;
    if(variant!=='default')Object.assign(fixture.games[0],{runtime:family,runtimeSeparatePrefix:true,runtimeBuild:a});
    window.webContents.send('snapshot',fixture);await settle(window);await open();
    const before=await evaluate(window,()=>{
      const dialog=document.querySelector('.game-dialog'),select=[...dialog.querySelectorAll('select')].find(select=>[...select.options].some(option=>option.value==='default'));
      const checkbox=dialog.querySelector('input[type="checkbox"][required]'),r=dialog.getBoundingClientRect(),active=document.activeElement;
      return {viewport:[innerWidth,innerHeight],documentWidth:document.documentElement.scrollWidth,language:document.documentElement.lang,dialog:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},focusInDialog:dialog.contains(active),focusIsInitial:active.matches('[data-gamepad-initial]'),options:[...select.options].map(option=>({value:option.value,disabled:option.disabled,text:option.text})),selected:select.value,consent:checkbox?checkbox.checked:undefined};
    });
    if(before.documentWidth>width||before.dialog.left<0||before.dialog.right>width||before.dialog.top<0||before.dialog.bottom>height||!before.focusInDialog||!before.focusIsInitial)throw Error('Runtime settings bounds/focus failed: '+JSON.stringify(before));
    if(variant==='default'&&(before.options.length!==1||before.selected!=='default'||before.consent!==undefined))throw Error('Default must not advertise an uninstalled family');
    if(variant==='unavailable'&&(!before.options.some(option=>option.value===family&&option.disabled)||before.selected!==family||before.consent!==false))throw Error('Unavailable persisted family must not fall back or preapprove');
    let consentGeometry;
    if(variant==='synthetic-installed-update') {
      if(before.selected!==family||before.consent!==false)throw Error('Build B must require fresh consent');
      // Native form validation must keep Save from invoking even the demo handler.
      await evaluate(window,()=>document.querySelector('.game-dialog button.primary').click());await settle(window);
      if(requests.length)throw Error('Unchecked consent submitted a settings request');
      await evaluate(window,()=>{const checkbox=document.querySelector('.game-dialog input[type="checkbox"][required]');checkbox.scrollIntoView({block:'center'});checkbox.focus();});
      await press(2);await press(0);await settle(window);
      consentGeometry=await evaluate(window,()=>{const input=document.querySelector('.game-dialog input[type="checkbox"][required]'),label=input.closest('label'),r=input.getBoundingClientRect(),l=label.getBoundingClientRect();return {checked:input.checked,focused:document.activeElement===input,input:[r.width,r.height],labelHeight:l.height,top:r.top,bottom:r.bottom,controllerMode:document.documentElement.hasAttribute('data-gamepad-navigation')};});
      if(!consentGeometry.checked||!consentGeometry.focused||consentGeometry.input[0]!==20||consentGeometry.input[1]!==20||consentGeometry.labelHeight<44||consentGeometry.top<0||consentGeometry.bottom>height||!consentGeometry.controllerMode)throw Error('Controller consent geometry/focus failed: '+JSON.stringify(consentGeometry));
    }
    await fs.writeFile(path.join(output,`runtime-${variant}-${width}x${height}.png`),(await window.webContents.capturePage()).toPNG());
    await press(1);await closed();await settle(window);
    const cancelFocus=await evaluate(window,()=>{const active=document.activeElement;return {restored:active!==document.body&&active?.isConnected&&!active.closest('[role="dialog"]'),cardRelated:Boolean(active?.closest('.library-card-wrap')),tag:active?.tagName,label:active?.getAttribute('aria-label'),className:active?.className,target:active?.getAttribute('data-gamepad-detail-target')};});
    if(!cancelFocus.restored||requests.length)throw Error('B cancellation failed focus restoration or submitted settings: '+JSON.stringify({width,height,variant,cancelFocus,requests}));
    if(variant==='synthetic-installed-update') {
      await open();
      await evaluate(window,()=>{const input=document.querySelector('.game-dialog input[type="checkbox"][required]');if(input.checked)throw Error('Reopened B consent was prefilled');input.focus();});
      await press(0);
      await evaluate(window,()=>{const save=document.querySelector('.game-dialog button.primary');save.scrollIntoView({block:'center'});save.focus();});
      await press(0);await closed();
      const sent=requests[0]?.patch;
      if(requests.length!==1||sent.runtime!==family||sent.runtimeApproveBuild!==true||JSON.stringify(sent.runtimeExpectedBuild)!==JSON.stringify(b))throw Error('Explicit B approval payload mismatch: '+JSON.stringify(requests));
    }
    results.push({...before,width,height,variant,consentGeometry,cancelRestoredFocus:cancelFocus,requests:structuredClone(requests)});
  }
  await fs.writeFile(path.join(output,'runtime-settings-results.json'),JSON.stringify({source,language,scope:'Actual compiled demo UI; variant descriptors, saved A selection and update-game capture are explicitly synthetic in-memory test data. No managed receipt verification or runtime/prefix execution is claimed.',results},null,2)+'\n');
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
