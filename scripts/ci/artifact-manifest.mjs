import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// One candidate may carry several architectures (x86_64 and aarch64) of the
// same component; every binary is bound with its checksum, source and metadata.
const ARCHES = '(?:x86_64|aarch64)';

async function digest(file, algorithm) {
  const hash = createHash(algorithm);
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
function safeName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name) && path.basename(name) === name;
}
function validateContext(kind, context) {
  if (!['launcher', 'runtime', 'backend'].includes(kind) || !/^[a-f0-9]{40}$/.test(context.commit ?? '') ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.repository ?? '') || !/^\d+$/.test(String(context.runId)))
    throw Error('Invalid candidate identity');
}
function isBinary(kind, name) {
  return kind === 'launcher' ? name.endsWith('.AppImage') : new RegExp(`^xodus-nexus-${kind}-[A-Za-z0-9._-]+-${ARCHES}\\.tar\\.xz$`).test(name);
}
function validateArchitectureSet(kind, binaries) {
  if (kind === 'runtime') {
    if (binaries.length !== 1) throw Error('Legacy runtime candidate must contain one complete build');
    return;
  }
  // Keep previously recorded single-image manifests verifiable. New named
  // multi-architecture builds must be one version with no duplicate targets.
  if (kind === 'launcher' && binaries.length === 1 && binaries[0] === 'Xodus-Nexus.AppImage') return;
  const pattern = kind === 'launcher' ? /^(Xodus-Nexus-\d+\.\d+\.\d+)-(x86_64|arm64)\.AppImage$/
    : /^(xodus-nexus-backend-\d+\.\d+\.\d+-linux)-(x86_64|aarch64)\.tar\.xz$/;
  const entries = binaries.map(name => pattern.exec(name));
  if (!entries.length || entries.some(value => !value) || entries.length > 2 ||
      new Set(entries.map(value => value[1])).size !== 1 || new Set(entries.map(value => value[2])).size !== entries.length)
    throw Error('Candidate architectures must identify one version without duplicate or unknown targets');
}
function checksumName(name) {
  return name.endsWith('.tar.xz') ? name.replace(/\.tar\.xz$/, '.sha512sum') : `${name}.sha512sum`;
}
/** The corresponding-source archive for a runtime or backend binary. */
function sourceName(kind, binary) {
  return kind === 'backend' ? binary.replace('.tar.xz', '-source.tar.xz') : binary.replace(new RegExp(`-${ARCHES}\\.tar\\.xz$`), '-source.tar.xz');
}
/** Every file one binary must be accompanied by, in checksum pairs. */
function expectedFiles(kind, binary) {
  const files = [binary, checksumName(binary)];
  if (kind !== 'launcher') { const source = sourceName(kind, binary); files.push(source, checksumName(source)); }
  if (kind === 'backend') files.push(binary.replace('.tar.xz', '.manifest.json'));
  return files;
}
export async function writeManifest(kind, directory, context) {
  validateContext(kind, context);
  const entries = await fs.readdir(directory);
  const binaries = entries.filter(name => isBinary(kind, name)).sort();
  validateArchitectureSet(kind, binaries);
  const sources = entries.filter(name => new RegExp(`^xodus-nexus-${kind}-[A-Za-z0-9._-]+-source\\.tar\\.xz$`).test(name)).sort();
  const expectedSources = kind === 'launcher' ? [] : [...new Set(binaries.map(binary => sourceName(kind, binary)))].sort();
  if (binaries.length === 0 || sources.join('\n') !== expectedSources.join('\n')) throw Error('Expected one complete candidate per architecture');
  const files = [];
  const seen = new Set();
  for (const binary of binaries) {
    for (const name of expectedFiles(kind, binary)) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (name.endsWith('.sha512sum')) continue;
      if (!safeName(name) || !(await fs.lstat(path.join(directory, name)).catch(() => null))?.isFile()) throw Error('Unsafe candidate file');
      if (name.endsWith('.manifest.json')) { files.push({ name, sha256: await digest(path.join(directory, name), 'sha256') }); continue; }
      const sha512 = await digest(path.join(directory, name), 'sha512');
      const checksum = `${sha512}  ${name}\n`;
      try {
        const existing = await fs.readFile(path.join(directory, checksumName(name)), 'utf8');
        if (existing.trim() !== checksum.trim()) throw Error('Existing checksum differs');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await fs.writeFile(path.join(directory, checksumName(name)), checksum, { flag: 'wx' });
      }
      for (const item of [name, checksumName(name)]) files.push({ name: item, sha256: await digest(path.join(directory, item), 'sha256') });
    }
  }
  const manifest = { schema: 1, kind, ...context, files };
  await fs.writeFile(path.join(directory, 'candidate.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}
export async function verifyManifest(directory, expected = {}) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'candidate.json'), 'utf8'));
  validateContext(manifest.kind, manifest);
  if (manifest.schema !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0) throw Error('Invalid candidate manifest');
  for (const [key, value] of Object.entries(expected)) if (manifest[key] !== value) throw Error(`Candidate ${key} mismatch`);
  const names = new Set();
  for (const file of manifest.files) {
    if (!safeName(file.name) || names.has(file.name) || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '') ||
        !(await fs.lstat(path.join(directory, file.name)).catch(() => null))?.isFile()) throw Error('Unsafe candidate file');
    names.add(file.name);
    if (await digest(path.join(directory, file.name), 'sha256') !== file.sha256) throw Error(`Candidate checksum mismatch: ${file.name}`);
  }
  const binaries = [...names].filter(name => isBinary(manifest.kind, name)).sort();
  validateArchitectureSet(manifest.kind, binaries);
  if (binaries.length === 0) throw Error('Candidate binary missing');
  const required = [...new Set(binaries.flatMap(binary => expectedFiles(manifest.kind, binary)))];
  if (required.length !== names.size || required.some(name => !names.has(name))) throw Error('Candidate assets are incomplete');
  for (const name of required) {
    if (name.endsWith('.sha512sum') || name.endsWith('.manifest.json')) continue;
    const data = await fs.readFile(path.join(directory, checksumName(name)), 'utf8');
    if (data.trim() !== `${await digest(path.join(directory, name), 'sha512')}  ${name}`) throw Error('Candidate SHA-512 mismatch');
  }
  return manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, kind, directory] = process.argv.slice(2);
  if (mode !== 'write' || !directory) throw Error('Usage: artifact-manifest.mjs write launcher|runtime|backend DIRECTORY');
  await writeManifest(kind, directory, { commit: process.env.GITHUB_SHA, repository: process.env.GITHUB_REPOSITORY,
    ref: process.env.GITHUB_REF, runId: process.env.GITHUB_RUN_ID });
}
