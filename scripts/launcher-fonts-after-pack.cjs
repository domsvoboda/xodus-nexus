const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;
  const root = context.appOutDir;
  const executable = path.join(root, 'xodus-nexus');
  const bootstrap = path.join(root, 'resources', 'font-bootstrap');
  await fs.rename(executable, executable + '.bin');
  await fs.mkdir(bootstrap, { recursive: true });
  await fs.copyFile(path.join(__dirname, 'launcher-font-wrapper.sh'), executable);
  await fs.chmod(executable, 0o755);
  await fs.copyFile(path.join(__dirname, 'launcher-font-bootstrap.mjs'), path.join(bootstrap, 'bootstrap.mjs'));
  await fs.copyFile(path.join(__dirname, '..', 'dist-electron', 'main', 'launcher-fonts.js'), path.join(bootstrap, 'launcher-fonts.mjs'));
  // The background daemon and the thin Steam client are Node entry points run
  // through the wrapper (ELECTRON_RUN_AS_NODE). They need a module-type package
  // root outside app.asar, so ship the compiled tree beside the font bootstrap.
  const nodeRoot = path.join(root, 'resources', 'nexus-node');
  await fs.rm(nodeRoot, { recursive: true, force: true });
  for (const part of ['main', 'shared', 'daemon', 'client']) {
    await fs.cp(path.join(__dirname, '..', 'dist-electron', part), path.join(nodeRoot, 'dist-electron', part), { recursive: true, filter: source => !/\.(map|cts)$/.test(source) });
  }
  await fs.writeFile(path.join(nodeRoot, 'package.json'), JSON.stringify({ type: 'module', private: true }) + '\n');
  // Native helpers CI compiled into build/tools/<arch>/ (nexus-close-window). A
  // local pack without them still works: the daemon falls back to signals.
  const tools = path.join(__dirname, '..', 'build', 'tools');
  if (await fs.stat(tools).then(stat => stat.isDirectory(), () => false)) {
    await fs.cp(tools, path.join(root, 'resources', 'tools'), { recursive: true });
  }
};
