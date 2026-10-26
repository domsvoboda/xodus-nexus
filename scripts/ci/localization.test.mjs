import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCatalog, checkCatalogs, checkUiKeys, importCatalog, exportCatalogs } from '../localization.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-locales-'));
after(() => fs.rm(root, { recursive: true, force: true }));
const en = { save:'Save', 'hello.user':'Hello {{name}}', count_one:'{{count}} friend', count_other:'{{count}} friends' };
const folder = path.join(root, 'locales');
await fs.mkdir(folder);
await fs.writeFile(path.join(folder, 'en.json'), JSON.stringify(en));

test('checks shipped catalogues and every static UI key without network access', async () => {
  const catalogs = await checkCatalogs();
  assert.ok(Object.keys(catalogs.en).length > 500);
  await checkUiKeys(catalogs.en);
});
test('rejects duplicates, non-flat data, invalid JSON and changed placeholders', () => {
  for (const source of ['{"save":"One","save":"Two"}', '{"save":{"nested":"Bad"}}', '{"save":""}', '{"save":"Bad",}', '{"hello.user":"Lost parameter"}', '{"extra":"Bad"}']) {
    assert.throws(() => parseCatalog(source, en));
  }
});
test('exports only public strings to a fresh directory and never overwrites it', async () => {
  const target = path.join(root, 'export');
  assert.deepEqual(await exportCatalogs(target, folder), ['en']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(target, 'en.json'), 'utf8')), en);
  await assert.rejects(exportCatalogs(target, folder), /EEXIST/);
  await assert.rejects(exportCatalogs('relative', folder), /absolute/);
});
test('imports partial reviewed translations and additional plural forms without modifying English', async () => {
  const target = path.join(root, 'cs-reviewed.json');
  await fs.writeFile(target, JSON.stringify({save:'Uložit',count_few:'{{count}} přátelé'}));
  assert.equal(await importCatalog('cs', target, folder), 2);
  assert.deepEqual({ ...(await checkCatalogs(folder)).cs }, {save:'Uložit',count_few:'{{count}} přátelé'});
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(folder, 'en.json'), 'utf8')), en);
  for (const language of ['en', '../de', 'pt-br', '__proto__', 'en-US/evil']) await assert.rejects(importCatalog(language, target, folder));
});
test('refuses translation symlinks and preserves existing files on validation failure', async () => {
  const invalid = path.join(root, 'invalid.json'); await fs.writeFile(invalid, '{"save":""}');
  const before = await fs.readFile(path.join(folder, 'cs.json'), 'utf8');
  await assert.rejects(importCatalog('cs', invalid, folder));
  assert.equal(await fs.readFile(path.join(folder, 'cs.json'), 'utf8'), before);
  const link = path.join(folder, 'de.json'); await fs.symlink(path.join(folder, 'en.json'), link);
  await assert.rejects(importCatalog('de', path.join(root, 'cs-reviewed.json'), folder), /symlink/);
  await fs.unlink(link);
});
test('rejects missing or dynamically assembled UI keys', async () => {
  const source = path.join(root, 'source'); await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'screen.tsx'), "ui('unknown'); ui(variable);");
  await assert.rejects(checkUiKeys(en, source), /unknown interface key[\s\S]*static/);
});
test('rejects missing interpolation parameters and translated settings keys', async () => {
  const source=path.join(root,'bad-parameters');await fs.mkdir(source);
  await fs.writeFile(path.join(source,'screen.tsx'), "ui('hello.user', { wrong: 'Example' }); const value = { [ui('save')]: true };");
  await assert.rejects(checkUiKeys(en,source), /missing interface parameters[\s\S]*protocol or settings key/);
});
