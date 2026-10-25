#!/usr/bin/env node
// Fresh, unauthenticated test prefix only. Stops only its own wineserver.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
const [runtimeArg, testsArg, workArg] = process.argv.slice(2);
if (!runtimeArg || !testsArg || !workArg || process.argv.length !== 5) throw new Error('Usage: run-contract-probes.mjs RUNTIME TEST_EXECUTABLE_DIRECTORY WORK_PARENT');
const runtime = await fs.realpath(runtimeArg);
const tests = await fs.realpath(testsArg);
const parent = await fs.realpath(workArg);
for (const name of ['wine', 'wine64', 'wineserver', 'wineserver64', 'xodus-cli', 'xodus-service']) {
  try { execFileSync('pgrep', ['-x', name], { stdio: 'ignore' }); throw new Error(`${name} active; wait before starting ABI stress tests`); }
  catch (e) { if (e.status !== 1) throw e; }
}
const root = await fs.mkdtemp(path.join(parent, 'runtime-contract-'));
await fs.chmod(root, 0o700);
const prefix = path.join(root, 'pfx');
const files = path.join(runtime, 'files');
const env = { ...process.env, WINEPREFIX: prefix, WINEARCH: 'win64', WINEDEBUG: '-all,err+all',
  WINEDLLPATH: [path.join(files, 'lib/vkd3d'), path.join(files, 'lib/wine')].join(':'),
  LD_LIBRARY_PATH: ['/usr/lib', path.join(files, 'lib/x86_64-linux-gnu'), path.join(files, 'lib/i386-linux-gnu')].join(':'),
  WINEDLLOVERRIDES: 'winemenubuilder.exe=d;mshtml=;mscoree=;xgameruntime=b;winhttp=b;libnghttp2=n' };
for (const key of Object.keys(env)) if (/^(XODUS_|XUSER_|STEAM_COMPAT_|SteamAppId$|SteamGameId$)/.test(key)) delete env[key];
const wine = path.join(files, 'bin/wine');
const server = path.join(files, 'bin/wineserver');
async function run(executable, args, timeout = 60000, overrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    const collect = bytes => { if (output.length < 512000) output += bytes.toString().slice(0, 512000 - output.length); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      try { execFileSync(server, ['-k'], { env, timeout: 5000, stdio: 'ignore' }); } catch { child.kill('SIGKILL'); }
    }, timeout);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, output, timedOut }); });
  });
}
const results = [];
try {
  const boot = await run(wine, ['wineboot', '--init']);
  await fs.writeFile(path.join(root, 'wineboot.log'), boot.output, { mode: 0o600 });
  if (boot.code || boot.timedOut) throw new Error(`Disposable wineboot failed; see ${root}`);
  // Replace the copied directory entry, never follow a default-prefix link.
  for (const name of ['xgameruntime.dll', 'winhttp.dll', 'mscoree.dll', 'libnghttp2.dll', 'windows.web.dll', 'libvkd3d-shader-1.dll', 'twinapi.appcore.dll']) {
    const dest = path.join(prefix, 'drive_c/windows/system32', name);
    const temporary = `${dest}.contract-${process.pid}`;
    const library = name === 'libvkd3d-shader-1.dll' ? 'vkd3d' : 'wine';
    await fs.copyFile(path.join(files, 'lib', library, 'x86_64-windows', name), temporary, fs.constants.COPYFILE_EXCL);
    await fs.rename(temporary, dest);
  }
  for (const name of ['appstate', 'appstate-source', 'appconstrained', 'appconstrained-source', 'hlsl-state-keywords', 'game-relaunch', 'taskqueue-teardown', 'taskqueue-contract', 'taskqueue-close', 'async-provider-contract', 'async-completion-lifetime', 'async-schedule', 'gamesave-files', 'gamesave-sync', 'gamesave-transfer', 'winrt-json', 'token-dispatch', 'user-privilege', 'store-entitlements', 'package-content', 'package-identity', 'package-legacy', 'package-chunks', 'package-monitors', 'package-progress-bytes', 'system-device-id', 'user-device-association', 'offline-identity', 'user-audio']) {
    const result = await run(wine, [path.join(tests, `${name}-probe.exe`)]);
    await fs.writeFile(path.join(root, `${name}.log`), result.output, { mode: 0o600 });
    const summary = result.output.split(/\r?\n/).filter(line => /^(FAIL |CHECKS |QUEUE |ASYNC |CHUNK METADATA CHECKS )/.test(line));
    console.log(`${name}: exit=${result.code} timeout=${result.timedOut}\n${summary.join('\n')}`);
    results.push({ name, code: result.code, timedOut: result.timedOut, summary });
    if (result.code !== 0 || result.timedOut) throw new Error(`Contract probe failed: ${name}; see ${root}`);
    // The file provider intentionally outlives its caller for final sync. Do not
    // tear its server down or start other probes before the child finishes.
    if (name === 'gamesave-files') {
      const finish = await run(server, ['-w']);
      await fs.appendFile(path.join(root, `${name}.log`), finish.output);
      if (finish.code || finish.timedOut) throw new Error(`File-provider shutdown failed; see ${root}`);
    }
  }
  const pgs = await run(wine, [path.join(tests, 'playfab-folder/playfab-folder-probe.exe')], 60000,
    { WINEDLLOVERRIDES: `${env.WINEDLLOVERRIDES};xgameruntime=n;playfabgamesave=n;nexus_pgs_native=n` });
  await fs.writeFile(path.join(root, 'playfab-folder.log'), pgs.output, { mode: 0o600 });
  const summary = pgs.output.split(/\r?\n/).filter(line => /^(FAIL |CHECKS )/.test(line));
  results.push({ name: 'playfab-folder', code: pgs.code, timedOut: pgs.timedOut, summary });
  console.log(`playfab-folder: exit=${pgs.code} timeout=${pgs.timedOut}\n${summary.join('\n')}`);
  const session=await run(wine,[path.join(tests,'playfab-session/playfab-session-probe.exe')],60000,
    {WINEDLLOVERRIDES:`${env.WINEDLLOVERRIDES};playfabcore=n;playfabgamesave=n;nexus_pgs_native=n`});
  await fs.writeFile(path.join(root,'playfab-session.log'),session.output,{mode:0o600});
  const sessionSummary=session.output.split('\n').filter(line=>/^(CHECKS|FAIL|Nexus cloud saves:)/.test(line));
  results.push({name:'playfab-session',code:session.code,timedOut:session.timedOut,summary:sessionSummary});
  console.log(`playfab-session: exit=${session.code} timeout=${session.timedOut}\n${sessionSummary.join('\n')}`);
  if(session.code!==0||session.timedOut)throw new Error(`PlayFab session contract probe failed; see ${root}`);
  if (pgs.code !== 0 || pgs.timedOut) throw new Error(`PlayFab adapter contract probe failed; see ${root}`);
  for (const kind of ['inline', 'retry', 'default']) {
    const result = await run(wine, [path.join(tests, 'runtime-init/runtime-init-probe.exe'), kind]);
    await fs.writeFile(path.join(root, `runtime-init-${kind}.log`), result.output, { mode: 0o600 });
    const summary = result.output.split(/\r?\n/).filter(line => /^(FAIL |CHECKS )/.test(line));
    results.push({ name: `runtime-init-${kind}`, code: result.code, timedOut: result.timedOut, summary });
    console.log(`runtime-init-${kind}: exit=${result.code} timeout=${result.timedOut}\n${summary.join('\n')}`);
    if (result.code !== 0 || result.timedOut) throw new Error(`Runtime initialization contract failed: ${kind}; see ${root}`);
  }
} finally {
  try { execFileSync(server, ['-k'], { env, timeout: 5000, stdio: 'ignore' }); } catch { /* never stop another prefix */ }
  await fs.writeFile(path.join(root, 'results.json'), JSON.stringify({ root, results }, null, 2) + '\n', { mode: 0o600 });
  console.log(`Private test results: ${root}`);
}
