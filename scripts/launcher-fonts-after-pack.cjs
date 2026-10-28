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
  // Native helpers CI compiled into build/tools/<arch>/ (nexus-close-window), only
  // this package's CPU. A local pack without them still works: Stop falls back to signals.
  const arch = { 1: 'x86_64', 3: 'aarch64' }[context.arch];
  const tools = path.join(__dirname, '..', 'build', 'tools', arch ?? 'none');
  if (await fs.stat(tools).then(stat => stat.isDirectory(), () => false)) {
    await fs.cp(tools, path.join(root, 'resources', 'tools', arch), { recursive: true });
  }
};
