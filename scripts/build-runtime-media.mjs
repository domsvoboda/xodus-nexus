#!/usr/bin/env node
// Build LGPL FFmpeg shared decoder libraries for the pinned Proton GStreamer.
// Creates an isolated work directory; never touches a game or active runtime.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hostArch } from './runtime-layout.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
// The libraries are built for the host that runs this script (x86_64 or
// aarch64); the assembly places them in the matching files/lib/<triplet>.
const arch = hostArch();
const triplet = `${arch}-linux-gnu`;
const elfMachine = arch === 'aarch64' ? 'AArch64' : 'Advanced Micro Devices X86-64';
const lock = JSON.parse(await fs.readFile(path.join(root, 'runtime-media.lock.json'), 'utf8'));
const args = process.argv.slice(2);
let work, archive, jobs = '4';
for (let i = 0; i < args.length; i += 2) {
  if (!args[i + 1]) throw new Error('Usage: build-runtime-media.mjs --work NEW_DIR [--archive PINNED_TARBALL] [--jobs N]');
  if (args[i] === '--work') work = path.resolve(args[i + 1]);
  else if (args[i] === '--archive') archive = path.resolve(args[i + 1]);
  else if (args[i] === '--jobs') jobs = args[i + 1];
  else throw new Error(`Unknown option: ${args[i]}`);
}
if (!work || !/^[1-9][0-9]*$/.test(jobs) || Number(jobs) > 32)
  throw new Error('A new work directory and 1–32 build jobs are required.');
if (!/^ffmpeg-[0-9.]+\.tar\.xz$/.test(lock.archive) || !/^[a-f0-9]{64}$/.test(lock.sha256) ||
    lock.url !== `https://ffmpeg.org/releases/${lock.archive}`)
  throw new Error('Invalid pinned FFmpeg source.');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (command, argv, cwd = work) => execFileSync(command, argv, { cwd, stdio: 'inherit', env: { ...process.env, LC_ALL: 'C' } });
await fs.mkdir(work, { recursive: false });
const sourceArchive = path.join(work, lock.archive);
if (archive) await fs.copyFile(archive, sourceArchive);
else run('curl', ['--proto', '=https', '--tlsv1.2', '--fail', '--location', '--silent', '--show-error', '--output', sourceArchive, lock.url]);
if (sha256(await fs.readFile(sourceArchive)) !== lock.sha256) throw new Error('Pinned FFmpeg archive checksum mismatch.');
const sourceDirectory = `ffmpeg-${lock.version}`;
const listing = execFileSync('tar', ['-tJf', sourceArchive], { encoding: 'utf8', maxBuffer: 16_000_000 });
for (const entry of listing.trimEnd().split('\n')) {
  if (!entry.startsWith(`${sourceDirectory}/`) || entry.split('/').includes('..')) throw new Error(`Unsafe FFmpeg archive entry: ${entry}`);
}
run('tar', ['-xJf', sourceArchive, '-C', work]);
const source = path.join(work, sourceDirectory);
const configure = [
  '--prefix=/usr', `--libdir=/usr/lib/${triplet}`,
  '--disable-static', '--enable-shared', '--disable-autodetect',
  '--disable-programs', '--disable-doc', '--disable-debug', '--disable-x86asm',
  '--disable-gpl', '--disable-nonfree', '--disable-encoders', '--disable-muxers', '--disable-devices',
];
run('./configure', configure, source);
run('make', [`-j${jobs}`], source);
const stage = path.join(work, 'stage');
run('make', [`DESTDIR=${stage}`, 'install'], source);
const libdir = path.join(stage, 'usr/lib', triplet);
const libraries = {};
let maxGlibc = [0, 0];
for (const [soname, filename] of Object.entries(lock.libraries)) {
  const target = await fs.realpath(path.join(libdir, soname));
  if (path.basename(target) !== filename) throw new Error(`Unexpected FFmpeg SONAME target: ${soname}`);
  const header = execFileSync('readelf', ['-h', target], { encoding: 'utf8' });
  const dynamic = execFileSync('readelf', ['-d', target], { encoding: 'utf8' });
  if (!header.includes(elfMachine) || !dynamic.includes(`Library soname: [${soname}]`))
    throw new Error(`Invalid FFmpeg ELF or SONAME: ${soname}`);
  const versions = execFileSync('readelf', ['--version-info', target], { encoding: 'utf8' });
  for (const match of versions.matchAll(/GLIBC_(\d+)\.(\d+)/g)) {
    const version = [Number(match[1]), Number(match[2])];
    if (version[0] > maxGlibc[0] || (version[0] === maxGlibc[0] && version[1] > maxGlibc[1])) maxGlibc = version;
  }
  libraries[soname] = { filename, sha256: sha256(await fs.readFile(target)) };
}
await fs.writeFile(path.join(work, 'media-manifest.json'), JSON.stringify({
  source: lock.url, sourceSha256: lock.sha256, version: lock.version, arch, triplet,
  license: 'LGPL-2.1-or-later', configure, maxGlibc: maxGlibc.join('.'), libraries,
}, null, 2) + '\n');
const bundleEntries = [lock.archive, 'media-manifest.json', `${sourceDirectory}/COPYING.LGPLv2.1`,
  ...Object.entries(lock.libraries).flatMap(([soname, filename]) => [
    `stage/usr/lib/${triplet}/${soname}`,
    `stage/usr/lib/${triplet}/${filename}`,
  ])];
run('tar', ['-cJf', path.join(work, 'media-bundle.tar.xz'), '-C', work, ...bundleEntries]);
console.log(`Built pinned LGPL media libraries: ${libdir}`);
