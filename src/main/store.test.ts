import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectGameDirectory, StateStore } from './store.js';
import type { DownloadTask } from '../shared/types.js';

const created: string[] = [];

it('persists interface language independently and migrates invalid saved values safely', async () => {
  const directory=await mkdtemp(path.join(tmpdir(),'nexus-interface-state-'));created.push(directory);
  const store=new StateStore(directory);await store.load();expect(store.settings.interfaceLanguage).toBe('system');
  const original={...store.settings};await store.setSettings({interfaceLanguage:'pt-BR'});
  const reopened=new StateStore(directory);await reopened.load();expect(reopened.settings).toEqual({...original,interfaceLanguage:'pt-BR'});
  await expect(reopened.setSettings({interfaceLanguage:'../cs'})).rejects.toThrow('Invalid interface language');
  for(const interfaceLanguage of [null,42,'cs_CZ','../cs',undefined]){
    await writeFile(path.join(directory,'launcher-state.json'),JSON.stringify({settings:{...original,interfaceLanguage}}));
    const migrated=new StateStore(directory);await migrated.load();expect(migrated.settings).toEqual({...original,interfaceLanguage:'system'});
  }
});

it('persists a custom shader cache limit and safely migrates missing or invalid values to 4 GiB',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'nexus-cache-state-'));created.push(directory);
  const store=new StateStore(directory);await store.load();expect(store.settings.shaderCacheLimitGiB).toBe(4);
  await store.setSettings({shaderCacheLimitGiB:8.5});const reopened=new StateStore(directory);await reopened.load();expect(reopened.settings.shaderCacheLimitGiB).toBe(8.5);
  await expect(reopened.setSettings({shaderCacheLimitGiB:0})).rejects.toThrow('Shader cache limit');expect(reopened.settings.shaderCacheLimitGiB).toBe(8.5);
  for(const value of [undefined,null,'8',0,-1,0.1,2048]){
    await writeFile(path.join(directory,'launcher-state.json'),JSON.stringify({settings:{shaderCacheLimitGiB:value}}));
    const migrated=new StateStore(directory);await migrated.load();expect(migrated.settings.shaderCacheLimitGiB).toBe(4);
  }
});

describe('download bandwidth settings', () => {
  it('defaults to unlimited and persists fractional MiB/s without changing parallelism', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nexus-bandwidth-state-')); created.push(directory);
    const store = new StateStore(directory); await store.load();
    expect(store.settings.downloadLimitMiB).toBe(0);
    const parallel = store.settings.parallelDownloads;
    await store.setSettings({ downloadLimitMiB: 0.5 });
    const reopened = new StateStore(directory); await reopened.load();
    expect(reopened.settings.downloadLimitMiB).toBe(0.5);
    expect(reopened.settings.parallelDownloads).toBe(parallel);
    await expect(reopened.setSettings({ downloadLimitMiB: -1 })).rejects.toThrow('Download speed limit');
    expect(reopened.settings.downloadLimitMiB).toBe(0.5);
    const final = new StateStore(directory); await final.load();
    expect(final.settings.downloadLimitMiB).toBe(0.5);
  });
  it('migrates old profiles and rejects invalid persisted rate values', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nexus-bandwidth-migrate-')); created.push(directory);
    for (const value of [undefined, -1, null, '2', 2048, 0.000001]) {
      await writeFile(path.join(directory, 'launcher-state.json'), JSON.stringify({ settings: { downloadLimitMiB: value } }));
      const store = new StateStore(directory); await store.load();
      expect(store.settings.downloadLimitMiB).toBe(0);
    }
  });
});

describe('manifest XML comments', () => {
  it('imports only active metadata and never changes the manifest', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nexus-xml-comments-'));
    created.push(directory);
    const xml = `<?xml version="1.0"?>
      <!-- examples -> \x1b[32m <Identity Name="Example" Version="0.0.0.0"/>
        <ShellVisuals DefaultDisplayName="Example" Square480x480Logo="wrong.png"/>
        <Executable Name="Wrong.exe"/><StoreId>000000000000</StoreId>
        <KnownDependency Name="VC14"/> -->
      <Game><Identity Name='Actual.Package' Version='1.2.3.4'/>
        <ShellVisuals DefaultDisplayName="Actual &amp; Game" PublisherDisplayName="Publisher"
          Square480x480Logo="actual.png"/>
        <ExecutableList><Executable Name='Game.exe'/></ExecutableList>
        <StoreId>9AAAAA<!-- annotation -->AAAAAA</StoreId></Game>`;
    await writeFile(path.join(directory, 'MicrosoftGame.config'), xml);
    await writeFile(path.join(directory, 'Game.exe'), 'MZ fixture');
    await writeFile(path.join(directory, '.xodus-streaming.msixvc'), 'fixture');
    await writeFile(path.join(directory, 'actual.png'), 'actual image');
    await mkdir(path.join(directory, 'Engine/Extras/Redist/en-us'), { recursive: true });
    await writeFile(path.join(directory, 'Engine/Extras/Redist/en-us/vc_redist.x64.exe'), 'encrypted fixture');
    expect(await inspectGameDirectory(directory)).toMatchObject({
      title: 'Actual & Game', storeId: '9AAAAAAAAAAA', packageName: 'Actual.Package',
      installedVersion: '1.2.3.4', executable: 'Game.exe', publisher: 'Publisher',
      coverDataUrl: `data:image/png;base64,${Buffer.from('actual image').toString('base64')}`,
      vcRedistEncrypted: false, installState: 'ready',
    });
    expect(await readFile(path.join(directory, 'MicrosoftGame.config'), 'utf8')).toBe(xml);
  });

  it('does not invent missing metadata from comments or CDATA', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nexus-xml-absent-'));
    created.push(directory);
    await writeFile(path.join(directory, 'MicrosoftGame.config'), `<Game>
      <!-- <StoreId>000000000000</StoreId><Executable Name="Wrong.exe"/> -->
      <Description><![CDATA[<StoreId>111111111111</StoreId>]]></Description></Game>`);
    const game = await inspectGameDirectory(directory);
    expect(game.storeId).toBeUndefined();
    expect(game.executable).toBeUndefined();
    expect(game.installState).toBe('imported');
  });

  it('reads appx metadata without commented examples, preserving namespaces and quotes', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nexus-appx-comments-'));
    created.push(directory);
    await writeFile(path.join(directory, 'appxmanifest.xml'), `<Package xmlns:uap="urn:test">
      <!-- <Identity Name="Wrong"/><DisplayName>Wrong</DisplayName>
        <Application Executable="Wrong.exe"/><uap:VisualElements Square150x150Logo="wrong.png"/> -->
      <Identity Name="Actual.Appx" Version="2.0.0.0"/>
      <Properties><DisplayName>Actual &gt; Example</DisplayName><PublisherDisplayName>Actual</PublisherDisplayName></Properties>
      <Applications><Application Executable='Actual.exe'><uap:VisualElements Description="a > b"
        Square150x150Logo='actual.png'/></Application></Applications></Package>`);
    await writeFile(path.join(directory, 'actual.png'), 'actual');
    expect(await inspectGameDirectory(directory)).toMatchObject({
      title: 'Actual > Example', packageName: 'Actual.Appx', executable: 'Actual.exe',
      publisher: 'Actual', installedVersion: '2.0.0.0',
      coverDataUrl: `data:image/png;base64,${Buffer.from('actual').toString('base64')}`,
    });
  });

  it('rejects an unterminated comment rather than importing example tags', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nexus-xml-malformed-'));
    created.push(directory);
    await writeFile(path.join(directory, 'MicrosoftGame.config'), '<Game><!-- <StoreId>000000000000</StoreId></Game>');
    await expect(inspectGameDirectory(directory)).rejects.toThrow();
  });
});

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeEacGame(targetHeader: Buffer, eacDirectory = 'EasyAntiCheat') {
  const directory = await mkdtemp(path.join(tmpdir(), 'xodus-nexus-game-'));
  created.push(directory);
  await mkdir(path.join(directory, eacDirectory), { recursive: true });
  await mkdir(path.join(directory, 'Game', 'Binaries'), { recursive: true });
  await writeFile(path.join(directory, 'MicrosoftGame.config'), '<Game><ExecutableList><Executable Name="start_protected_game.exe" /></ExecutableList><StoreId>TEST123</StoreId></Game>');
  await writeFile(path.join(directory, '.xodus-streaming.msixvc'), 'container');
  await writeFile(path.join(directory, 'start_protected_game.exe'), 'encrypted launcher');
  await writeFile(path.join(directory, eacDirectory, 'Settings.json'), JSON.stringify({ executable: 'Game\\Binaries\\Game.exe' }));
  await writeFile(path.join(directory, 'Game', 'Binaries', 'Game.exe'), targetHeader);
  return directory;
}

describe('inspectGameDirectory anti-cheat support', () => {
  it('keeps per-game launch tools after saving, reopening and refreshing installed metadata', async () => {
    const root=await mkdtemp(path.join(tmpdir(),'nexus-game-tool-state-')); created.push(root);
    const store=new StateStore(root);
    const game={id:'test-tools',title:'Synthetic game',path:'/sample/game',installState:'ready' as const,addedAt:'2026-10-16T00:00:00Z'};
    const launchTools={dualSenseCompatibility:true,dualShock4Compatibility:true,mangoHud:true,gamescope:false,gamescopeArgs:'',launchOptions:'DXVK_HUD=fps %command% --launcher-skip'};
    await store.upsertGame(game); await store.patchGame(game.id,{launchTools});
    const reopened=new StateStore(root); await reopened.load();
    expect(reopened.games[0].launchTools).toEqual(launchTools);
    await reopened.upsertGame({...game,publisher:'Updated metadata'});
    expect(reopened.games[0].launchTools).toEqual(launchTools);
  });
  it('detects an encrypted EAC chain without declaring online play unsupported', async () => {
    const game = await inspectGameDirectory(await makeEacGame(Buffer.from([0x01, 0x02, 0x03])));
    expect(game.installState).toBe('ready');
    expect(game.executable).toBe('start_protected_game.exe');
    expect(game.antiCheat).toEqual({
      provider: 'Easy Anti-Cheat',
      executable: 'Game\\Binaries\\Game.exe',
      encryptedTarget: true,
    });
    expect(game).not.toHaveProperty('launchSupport');
  });

  it('keeps the manifest launcher even when the EAC target is an ordinary PE file', async () => {
    const game = await inspectGameDirectory(await makeEacGame(Buffer.from('MZ executable')));
    expect(game.executable).toBe('start_protected_game.exe');
    expect(game.antiCheat?.encryptedTarget).toBe(false);
  });

  it('detects the EasyAntiCheat_EOS metadata layout', async () => {
    const game = await inspectGameDirectory(await makeEacGame(Buffer.from('MZ executable'), 'EasyAntiCheat_EOS'));
    expect(game.antiCheat?.provider).toBe('Easy Anti-Cheat');
    expect(game.executable).toBe('start_protected_game.exe');
  });

  it('does not show an EAC warning without EAC metadata', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'xodus-nexus-no-eac-'));
    created.push(directory);
    await writeFile(path.join(directory, 'MicrosoftGame.config'), '<Game><ExecutableList><Executable Name="Game.exe" /></ExecutableList></Game>');
    await writeFile(path.join(directory, '.xodus-streaming.msixvc'), 'container');
    await writeFile(path.join(directory, 'Game.exe'), 'MZ executable');
    const game = await inspectGameDirectory(directory);
    expect(game.antiCheat).toBeUndefined();
    expect(game).not.toHaveProperty('launchBlockReason');
  });
});

describe('inspectGameDirectory prerequisites', () => {
  it('detects a declared VC14 dependency with an encrypted redistributable', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'xodus-nexus-vc-game-'));
    created.push(directory);
    await mkdir(path.join(directory, 'Engine', 'Extras', 'Redist', 'en-us'), { recursive: true });
    await writeFile(path.join(directory, 'MicrosoftGame.config'), '<Game><ExecutableList><Executable Name="Game.exe" /></ExecutableList><KnownDependency Name="VC14" /></Game>');
    await writeFile(path.join(directory, 'Game.exe'), 'encrypted executable');
    await writeFile(path.join(directory, '.xodus-streaming.msixvc'), 'container');
    await writeFile(path.join(directory, 'Engine', 'Extras', 'Redist', 'en-us', 'vc_redist.x64.exe'), Buffer.from([0, 1, 2]));
    expect((await inspectGameDirectory(directory)).vcRedistEncrypted).toBe(true);
  });
});

describe('new profile defaults', () => {
  it('discards legacy EAC-free route fields without losing the installation', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'xodus-nexus-legacy-'));
    created.push(directory);
    await writeFile(path.join(directory, 'launcher-state.json'), JSON.stringify({ games: [{
      id: 'game', title: 'Any title', path: '/package', executable: 'Launcher.exe',
      launchSupport: 'offline-only-eac', launchBlockReason: 'Old warning', installState: 'ready',
    }] }));
    const store = new StateStore(directory);
    await store.load();
    expect(store.games[0].executable).toBe('Launcher.exe');
    expect(store.games[0]).not.toHaveProperty('launchSupport');
    expect(store.games[0]).not.toHaveProperty('launchBlockReason');
  });
  it('does not assume a particular disk or Xodus checkout', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'xodus-nexus-settings-'));
    created.push(directory);
    const store = new StateStore(directory);
    await store.load();
    expect(store.settings.installRoot).toContain(path.join('Games', 'Xodus Nexus'));
    expect(store.settings.installRoot).not.toContain('/mnt/data2');
    expect(store.settings.externalXodusRoot).toBe('');
    expect(store.settings.verboseLogs).toBe(false);
  });
});

describe('install queue history', () => {
  it('keeps all pending rows beyond the history limit and serializes concurrent saves', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'xodus-queue-persist-')); created.push(directory);
    const store = new StateStore(directory);
    const base: DownloadTask = { id: '', title: 'Sample', productId: '9AAAAAAAAAAA', destination: '/sample', status: 'queued', progress: null, phase: 'Waiting', log: [], startedAt: new Date().toISOString() };
    await Promise.all(Array.from({ length: 40 }, (_, index) => store.addDownload({ ...base, id: `pending-${index}` })));
    await Promise.all(Array.from({ length: 35 }, (_, index) => store.addDownload({ ...base, id: `done-${index}`, status: 'complete' })));
    expect(store.downloads.filter(task => task.status === 'queued')).toHaveLength(40);
    expect(store.downloads.filter(task => task.status === 'complete')).toHaveLength(30);
    const loaded = new StateStore(directory); await loaded.load();
    expect(loaded.downloads).toHaveLength(70);
    expect(loaded.downloads.filter(task => task.status === 'paused')).toHaveLength(40);
    expect(loaded.downloads.find(task => task.id === 'pending-0')?.canPause).toBe(true);
  });
  it('removes only finished entries and never deletes install files', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'xodus-nexus-queue-'));
    created.push(directory);
    const store = new StateStore(directory);
    await store.load();
    const destination = path.join(directory, 'game');
    await mkdir(destination);
    await writeFile(path.join(destination, 'keep.txt'), 'game data');
    const base = { title: 'Game', productId: 'TEST', destination, progress: null, phase: '', log: [], startedAt: new Date().toISOString() };
    await store.addDownload({ ...base, id: 'running', status: 'running' });
    await store.addDownload({ ...base, id: 'paused', status: 'paused' });
    await store.addDownload({ ...base, id: 'failed', status: 'failed' });
    await expect(store.removeDownload('running')).rejects.toThrow('Stop the installation');
    await expect(store.removeDownload('paused')).rejects.toThrow('Stop the installation');
    await store.removeDownload('failed');
    expect(store.downloads.map((task) => task.id)).toEqual(['paused', 'running']);
    await store.clearFinishedDownloads();
    expect(store.downloads.map((task) => task.id)).toEqual(['paused', 'running']);
    const restored = new StateStore(directory);
    await restored.load();
    expect(restored.downloads.every(task => task.status === 'paused' && task.canPause && !task.controlPending)).toBe(true);
    expect(await readFile(path.join(destination, 'keep.txt'), 'utf8')).toBe('game data');
  });
});

describe('inspectGameDirectory artwork', () => {
  it('reads a case-variant MicrosoftGame.Config and its cover', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'xodus-nexus-art-case-'));
    created.push(directory);
    await writeFile(path.join(directory, 'MicrosoftGame.Config'), '<Game><ShellVisuals DefaultDisplayName="Forza Horizon 6" Square150x150Logo="Logo.png" /><ExecutableList><Executable Name="Game.exe" /></ExecutableList></Game>');
    await writeFile(path.join(directory, '.xodus-streaming.msixvc'), 'container');
    await writeFile(path.join(directory, 'Game.exe'), 'MZ executable');
    await writeFile(path.join(directory, 'Logo.png'), 'PNGDATA');
    const game = await inspectGameDirectory(directory);
    expect(game.title).toBe('Forza Horizon 6');
    expect(game.coverDataUrl).toBe('data:image/png;base64,UE5HREFUQQ==');
  });

  it('falls back to the appxmanifest visual elements for the cover', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'xodus-nexus-art-appx-'));
    created.push(directory);
    await writeFile(path.join(directory, 'MicrosoftGame.config'), '<Game><ExecutableList><Executable Name="Game.exe" /></ExecutableList></Game>');
    await writeFile(path.join(directory, 'appxmanifest.xml'), '<Package><Applications><Application Id="App" Executable="Game.exe"><uap:VisualElements DisplayName="Forza Horizon 6" Square44x44Logo="Small.png" Square150x150Logo="Logo.png" /></Application></Applications></Package>');
    await writeFile(path.join(directory, '.xodus-streaming.msixvc'), 'container');
    await writeFile(path.join(directory, 'Game.exe'), 'MZ executable');
    await writeFile(path.join(directory, 'Logo.png'), 'PNGDATA');
    const game = await inspectGameDirectory(directory);
    expect(game.coverDataUrl).toBe('data:image/png;base64,UE5HREFUQQ==');
  });
});

describe('inspectGameDirectory titles containing quotes', () => {
  it('keeps the full title when the display name contains an apostrophe', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'xodus-nexus-title-'));
    created.push(directory);
    await writeFile(path.join(directory, 'MicrosoftGame.config'),
      '<Game><ExecutableList><Executable Name="Game.exe" /></ExecutableList><ShellVisuals DefaultDisplayName="No Man\'s Sky" PublisherDisplayName="Hello Games" /><StoreId>TEST123</StoreId></Game>');
    await writeFile(path.join(directory, '.xodus-streaming.msixvc'), 'container');
    await writeFile(path.join(directory, 'Game.exe'), 'MZ executable');
    const game = await inspectGameDirectory(directory);
    expect(game.title).toBe("No Man's Sky");
    expect(game.publisher).toBe('Hello Games');
  });

  it('keeps single-quoted attribute values containing a double quote', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'xodus-nexus-title-dq-'));
    created.push(directory);
    await writeFile(path.join(directory, 'MicrosoftGame.config'),
      "<Game><ExecutableList><Executable Name='Game.exe' /></ExecutableList><ShellVisuals DefaultDisplayName='A \"quoted\" Game' /></Game>");
    await writeFile(path.join(directory, '.xodus-streaming.msixvc'), 'container');
    await writeFile(path.join(directory, 'Game.exe'), 'MZ executable');
    const game = await inspectGameDirectory(directory);
    expect(game.title).toBe('A "quoted" Game');
  });
});


it.each(['IsDevOnly="false"', 'isdevonly="false"', ''])('selects a retail executable after development-only tools: %s',async(retail)=>{
  const directory=await mkdtemp(path.join(tmpdir(),'nexus-retail-executable-'));created.push(directory);
  await writeFile(path.join(directory,'MicrosoftGame.config'),`<Game><ExecutableList>
    <Executable Name="Development.exe" IsDevOnly="true"/>
    <Executable IsDevOnly="false"/>
    <Executable Name="Game.exe" ${retail}/>
    <Executable Name="Other.exe"/>
  </ExecutableList></Game>`);
  await writeFile(path.join(directory,'Game.exe'),'MZ retail');
  expect((await inspectGameDirectory(directory)).executable).toBe('Game.exe');
});

it('defaults close-to-tray off, persists an explicit choice and rejects invalid preferences',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'nexus-tray-state-'));created.push(root);
 const store=new StateStore(root);await store.load();expect(store.settings.closeToTray).toBe(false);
 await store.setSettings({closeToTray:true});const reopened=new StateStore(root);await reopened.load();expect(reopened.settings.closeToTray).toBe(true);
 await expect(store.setSettings({closeToTray:'yes'} as any)).rejects.toThrow('close-to-tray');
 await writeFile(path.join(root,'launcher-state.json'),JSON.stringify({settings:{closeToTray:'true'}}));
 const legacy=new StateStore(root);await legacy.load();expect(legacy.settings.closeToTray).toBe(false);
});
