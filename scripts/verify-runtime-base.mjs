#!/usr/bin/env node
// Verify the exact distribution used by CI before overlaying shared DLLs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export async function verifyRuntimeBase(base, lock) {
  if (lock.schema !== 1 || !lock.files || !Object.keys(lock.files).length) throw new Error('Invalid base lock');
  if ((await fs.readFile(path.join(base, 'version'), 'utf8')).trim() !== lock.version) throw new Error('Proton base version does not match the tested lock');
  for (const [relative, expected] of Object.entries(lock.files)) {
    if (!/^files\/[A-Za-z0-9._/-]+$/.test(relative) || relative.split('/').includes('..') || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Invalid base component lock');
    const bytes = await fs.readFile(path.join(base, relative));
    if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`Proton base checksum mismatch: ${relative}`);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // The optional second argument selects another base lock, e.g. runtime-base-arm64.lock.json.
  if (process.argv.length < 3 || process.argv.length > 4) throw new Error('Usage: verify-runtime-base.mjs BASE_DIRECTORY [LOCK_FILE]');
  const lockFile = process.argv[3] ? path.resolve(process.argv[3]) : fileURLToPath(new URL('./runtime-base.lock.json', import.meta.url));
  const lock = JSON.parse(await fs.readFile(lockFile, 'utf8'));
  await verifyRuntimeBase(path.resolve(process.argv[2]), lock);
  console.log(`Verified locked Proton base: ${lock.version}`);
}
