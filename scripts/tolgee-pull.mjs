import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseCatalog, checkCatalogs } from './localization.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

/** Treat downloaded catalogues as data; never import or execute them. */
export async function validatePull(folder, english) {
  const info = await fs.lstat(folder);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Expected a regular staging directory.');
  const files = await fs.readdir(folder, { withFileTypes: true });
  if (files.length > 200) throw Error('Too many exported language files.');
  const catalogs = Object.create(null);
  for (const file of files) {
    if (!file.isFile() || !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*\.json$/.test(file.name)) throw Error('Unexpected Tolgee export file.');
    const language = file.name.slice(0, -5);
    if (Intl.getCanonicalLocales(language)[0] !== language) throw Error('Non-canonical Tolgee language filename.');
    const target = path.join(folder, file.name);
    if ((await fs.lstat(target)).size > 2 * 1024 * 1024) throw Error('Translation file is too large.');
    catalogs[language] = parseCatalog(await fs.readFile(target, 'utf8'), english);
  }
  return catalogs;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw Error('Usage: npm run i18n:pull (creates a fresh temporary staging directory).');
    const { en } = await checkCatalogs();
    const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-tolgee-reviewed-'));
    // Explicit fresh destination prevents stale reviewed files surviving later pulls.
    const packageInfo = JSON.parse(await fs.readFile(path.join(root, 'node_modules/@tolgee/cli/package.json'), 'utf8'));
    const executable = path.join(root, 'node_modules/@tolgee/cli', packageInfo.bin.tolgee);
    const result = spawnSync(process.execPath, [executable, 'pull', '--config', path.join(root, '.tolgeerc.json'), '--path', staging], {
      cwd: root, stdio: 'inherit', timeout: 120_000,
    });
    if (result.error || result.status !== 0) throw Error(`Tolgee pull failed. No bundled files changed. Staging: ${staging}`);
    const catalogs = await validatePull(staging, en);
    const languages = Object.entries(catalogs).filter(([language, catalog]) => language !== 'en' && Object.keys(catalog).length).map(([language]) => language);
    console.log(`Reviewed target exports: ${languages.join(', ') || 'none'}. Staging: ${staging}`);
    console.log('Review and import target files explicitly. Bundled catalogues were not changed.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
