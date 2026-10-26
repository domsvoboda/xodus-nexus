// Build one pinned backend candidate. Never starts auth, a service or a game.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { backendSourceArchiveArgs } from './backend-source-archive.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const work = path.resolve(option('--work', 'backend-build'));
const output = path.resolve(option('--output', 'backend-release'));
const target = path.resolve(option('--target-dir', path.join(work, 'target')));
const lockBytes = await fs.readFile(path.join(root, 'assets/backend-source.lock.json'));
const lock = JSON.parse(lockBytes);
const authUi = 'electron';
const features = ['--no-default-features'];
if (process.platform !== 'linux' || process.arch !== 'x64') throw Error('Build the backend on Linux x86_64');
const sha = (data, algorithm = 'sha256') => createHash(algorithm).update(data).digest('hex');
if (lock.schema !== 1 || !/^\d+\.\d+\.\d+$/.test(lock.version) || !/^[a-f0-9]{40}$/.test(lock.commit)) throw Error('Invalid backend source lock');
for (const patch of lock.patches) {
  if (!/^xodus-[a-z-]+\.patch$/.test(patch.file) || sha(await fs.readFile(path.join(root, 'assets', patch.file))) !== patch.sha256) throw Error('Backend patch checksum mismatch');
}
// Refuse reuse of a dirty/previous build directory. Local diagnostic clone
// override is read-only; the commit/Cargo.lock/patch checks still apply.
await fs.mkdir(work);
await fs.mkdir(output);
const source = path.join(work, 'source');
const command = (tool, argv, capture = false) => execFileSync(tool, argv, {
  cwd: source, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  env: { ...process.env, CARGO_TARGET_DIR: target, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '4' },
});
execFileSync('git', ['clone', '--no-checkout', '--no-hardlinks', option('--repository', lock.repository), source], { stdio: 'inherit' });
command('git', ['checkout', '--detach', lock.commit]);
if (command('git', ['rev-parse', 'HEAD'], true).trim() !== lock.commit || sha(await fs.readFile(path.join(source, 'Cargo.lock'))) !== lock.cargoLockSha256) throw Error('Backend source mismatch');
for (const patch of lock.patches) {
  const file = path.join(root, 'assets', patch.file);
  command('git', ['apply', '--check', file]);
  command('git', ['apply', file]);
}
const offline = args.includes('--offline') ? ['--offline'] : [];
const rustc = command('rustc', ['--version'], true).trim();
if (!rustc.startsWith(`rustc ${lock.rust} `)) throw Error(`Use the locked Rust toolchain ${lock.rust}`);
command('cargo', ['test', '--locked', ...offline, ...features, '-p', 'xodus-cli']);
command('cargo', ['test', '--locked', ...offline, ...features, '-p', 'xodus', 'credential_']);
command('cargo', ['test', '--locked', ...offline, ...features, '-p', 'xodus', 'keyring_unlock_', '--', '--test-threads=1']);
command('cargo', ['test', '--locked', ...offline, ...features, '-p', 'xodus', 'keyring_create_', '--', '--test-threads=1']);
command('cargo', ['test', '--locked', ...offline, ...features, '-p', 'xodus', 'keyring_session_', '--', '--test-threads=1']);
command('cargo', ['test', '--locked', ...offline, ...features, '-p', 'xodus', 'keyring_persistence_', '--', '--test-threads=1']);
command('cargo', ['test', '--locked', ...offline, ...features, '-p', 'xodus', 'content_license_']);
command('cargo', ['test', '--locked', ...offline, ...features, '-p', 'xodus', 'content_ticket_']);
command('cargo', ['test', '--locked', ...offline, ...features, '-p', 'xodus', 'ticket_diagnostic_']);
command('cargo', ['test', '--locked', ...offline, '-p', 'xodus-service', 'store_']);
command('cargo', ['test', '--locked', ...offline, '-p', 'xodus-service', 'account_metadata_']);
command('cargo', ['test', '--locked', ...offline, ...features, '-p', 'msixvc', 'streaming_']);
command('cargo', ['test', '--locked', ...offline, ...features, '-p', 'msixvc', 'streaming::tests']);
// Aggregate HTTP probes mutate the process-wide limiter, so run them serially.
command('cargo', ['test', '--locked', ...offline, ...features, '-p', 'msixvc', 'streaming_bandwidth_', '--', '--ignored', '--test-threads=1']);
command('cargo', ['test', '--locked', ...offline, ...features, '-p', 'msixvc', 'package_metadata']);
command('cargo', ['build', '--release', '--locked', ...offline, ...features, '-p', 'xodus-cli', '-p', 'xodus-service']);
const cli = path.join(target, 'release/xodus-cli');
const help = command(cli, ['--help'], true);
if (authUi === 'electron' && !help.includes('--external-webview-stdio')) throw Error('External sign-in capability missing');
if (authUi === 'electron' && /lib(?:gtk|webkit|soup|javascriptcore)/i.test(command('readelf', ['-d', cli], true))) throw Error('Headless CLI links a native webview library');
for (const name of ['account', 'login', 'logout', 'download', 'streaming', 'run', 'resolve-package', 'game-activity', 'achievements', 'social', 'keyring-unlock', 'keyring-create', 'keyring-session-stop']) {
  if (!new RegExp(`^\\s{2}${name}\\s{2,}`, 'm').test(help)) throw Error(`Backend lacks ${name}`);
}
if (!command(cli, ['run', '--help'], true).includes('--materialize-chain')) throw Error('Launch-chain support missing');
if (!command(cli, ['resolve-package', '--help'], true).includes('--include-dlc')) throw Error('Managed DLC selection capability missing');
const streamingHelp = command(cli, ['streaming', '--help'], true);
for (const flag of ['--progress-json', '--control-stdin', '--selected-content-id', '--download-limit-kib']) {
  if (!streamingHelp.includes(flag)) throw Error(`Structured download capability missing: ${flag}`);
}
// xodus-service has no --help parser; running it would access keychain/network.
const name = `xodus-nexus-backend-${lock.version}-linux-x86_64`;
const bundle = path.join(work, name);
await fs.mkdir(bundle);
const files = {};
for (const file of ['xodus-cli', 'xodus-service', 'LICENSE']) {
  const origin = file === 'LICENSE' ? path.join(source, file) : path.join(target, 'release', file);
  await fs.copyFile(origin, path.join(bundle, file));
  if (file !== 'LICENSE') await fs.chmod(path.join(bundle, file), 0o755);
  files[file] = sha(await fs.readFile(origin));
}
command('tar', ['-cJf', path.join(output, `${name}.tar.xz`), '-C', work, name]);
// Include vendored registry/Git dependency sources and offline Cargo config,
// alongside patched upstream source, GPL license, recipe and build tooling.
const config = command('cargo', ['vendor', '--locked', ...offline, 'vendor'], true);
await fs.mkdir(path.join(source, '.cargo'), { recursive: true });
await fs.writeFile(path.join(source, '.cargo/config.toml'), config);
const recipe = path.join(work, 'recipe');
await fs.mkdir(path.join(recipe, 'assets'), { recursive: true });
await fs.copyFile(path.join(root, 'assets/backend-source.lock.json'), path.join(recipe, 'assets/backend-source.lock.json'));
for (const patch of lock.patches) await fs.copyFile(path.join(root, 'assets', patch.file), path.join(recipe, 'assets', patch.file));
await fs.mkdir(path.join(recipe, 'scripts'));
await fs.copyFile(fileURLToPath(import.meta.url), path.join(recipe, 'scripts/build-backend.mjs'));
await fs.copyFile(path.join(root, 'scripts/backend-source-archive.mjs'), path.join(recipe, 'scripts/backend-source-archive.mjs'));
await fs.copyFile(path.join(root, 'scripts/BACKEND.md'), path.join(recipe, 'scripts/BACKEND.md'));
await fs.writeFile(path.join(recipe, 'BUILD.txt'), `Patched upstream source + vendored dependencies.\nRust ${lock.rust}; cargo build --locked --offline --release ${features.join(' ')} -p xodus-cli -p xodus-service from source/.\nAuthentication UI: ${authUi}.\nNative build dependencies and release policy: scripts/BACKEND.md in the Nexus repository.\nBackend is GPL-3.0; dependency licenses are retained in vendor/.\n`);
command('tar', backendSourceArchiveArgs(path.join(output, `${name}-source.tar.xz`), work));
for (const archive of [`${name}.tar.xz`, `${name}-source.tar.xz`]) {
  await fs.writeFile(path.join(output, archive.replace('.tar.xz', '.sha512sum')), `${sha(await fs.readFile(path.join(output, archive)), 'sha512')}  ${archive}\n`);
}
const manifest = {
  schema: 1, version: lock.version, commit: lock.commit, recipeSha256: sha(lockBytes), compatibility: lock.compatibility, authUi,
  platform: 'linux', arch: 'x64', archive: `${name}.tar.xz`,
  archiveSha512: sha(await fs.readFile(path.join(output, `${name}.tar.xz`)), 'sha512'), files,
  rustc, glibc: command('getconf', ['GNU_LIBC_VERSION'], true).trim(),
};
await fs.writeFile(path.join(output, `${name}.manifest.json`), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Built ${name}; source, patches, binaries and SHA-512 provenance recorded. No account/service/game started.`);
