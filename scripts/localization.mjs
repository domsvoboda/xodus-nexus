import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'assets/locales');
// Share exactly the runtime schema without requiring a separate tooling build.
// Only this checked-in TypeScript module is compiled, never imported JSON text.
const rules = ts.transpileModule(await fs.readFile(path.join(root, 'src/shared/interface-language.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { canonicalLanguage, validateTranslationCatalog, translationPlaceholders } = await import(`data:text/javascript;base64,${Buffer.from(rules).toString('base64')}`);

export function parseCatalog(source, english) {
  if (Buffer.byteLength(source) > 2 * 1024 * 1024) throw Error('Translation file is too large.');
  const value = JSON.parse(source);
  const syntax = ts.parseJsonText('translation.json', source);
  const properties = syntax.statements[0]?.expression?.properties ?? [];
  const names = properties.map(property => property.name?.text);
  if (new Set(names).size !== names.length) throw Error('Duplicate translation keys.');
  return validateTranslationCatalog(value, english);
}

async function readCatalog(file, english) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw Error('Expected a regular translation JSON file.');
  return parseCatalog(await fs.readFile(file, 'utf8'), english);
}

export async function checkCatalogs(folder = directory) {
  const english = await readCatalog(path.join(folder, 'en.json'));
  const catalogs = { en: english };
  for (const name of await fs.readdir(folder)) {
    if (!name.endsWith('.json') || name === 'en.json') continue;
    const language = name.slice(0, -5);
    if (canonicalLanguage(language) !== language) throw Error(`Invalid language filename: ${name}`);
    catalogs[language] = await readCatalog(path.join(folder, name), english);
  }
  const categories = ['zero', 'one', 'two', 'few', 'many', 'other'];
  const families = new Set(Object.keys(english).filter(key => /_(?:one|other)$/.test(key)).map(key => key.replace(/_(?:one|other)$/, '')));
  for (const family of families) {
    const missing = categories.filter(category => !english[`${family}_${category}`]);
    if (missing.length) throw Error(`Missing source plural forms for ${family}: ${missing.join(', ')}`);
    const parameters = JSON.stringify(translationPlaceholders(english[`${family}_other`]));
    for (const category of categories) if (JSON.stringify(translationPlaceholders(english[`${family}_${category}`])) !== parameters)
      throw Error(`Source plural placeholders differ: ${family}_${category}`);
  }
  return catalogs;
}

export async function importCatalog(language, file, folder = directory) {
  if (canonicalLanguage(language) !== language || language === 'en') throw Error('Choose a canonical target language, not en.');
  const english = await readCatalog(path.join(folder, 'en.json'));
  const catalog = await readCatalog(file, english);
  if (!Object.keys(catalog).length) throw Error('No reviewed translations to import.');
  const target = path.join(folder, `${language}.json`);
  try { if ((await fs.lstat(target)).isSymbolicLink()) throw Error('Refusing to replace a symlink.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(Object.fromEntries(Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b))), null, 2) + '\n', { flag: 'wx' });
  try { await fs.rename(temporary, target); } finally { await fs.rm(temporary, { force: true }); }
  return Object.keys(catalog).length;
}

export async function exportCatalogs(destination, folder = directory) {
  if (!destination || !path.isAbsolute(destination)) throw Error('Choose an absolute path for a new export directory.');
  const catalogs = await checkCatalogs(folder);
  // No recursive creation and no overwriting an existing user directory.
  await fs.mkdir(destination);
  for (const [language, catalog] of Object.entries(catalogs)) {
    await fs.writeFile(path.join(destination, `${language}.json`), JSON.stringify(catalog, null, 2) + '\n', { flag: 'wx' });
  }
  return Object.keys(catalogs);
}

export async function checkUiKeys(catalog, sourceRoot = path.join(root, 'src')) {
  const errors = [];
  const unchanged = new Set(['X', 'B', 'G', 'R1', 'L1', 'A', 'Microsoft Store', 'XODUS NEXUS', 'Git', 'Cargo', 'Rust 1.99', 'protoc', 'MiB']);
  const visible = new Set(['label', 'title', 'placeholder', 'aria-label', 'alt', 'action']);
  const needsTranslation = text => /[a-zA-Z]{2}/.test(text.trim()) && !unchanged.has(text.trim()) && text.trim() !== '· Microsoft Store' && !text.includes('%command%');
  async function walk(folder) {
    for (const item of await fs.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, item.name);
      if (item.isDirectory()) { await walk(file); continue; }
      if (!/\.tsx?$/.test(item.name) || /\.test\.|\.d\.ts$/.test(item.name)) continue;
      const syntax = ts.createSourceFile(file, await fs.readFile(file, 'utf8'), ts.ScriptTarget.Latest, true, item.name.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      function visit(node) {
        if (ts.isJsxText(node) && needsTranslation(node.text)) errors.push(`${file}: untranslated JSX text ${node.text.trim()}`);
        if (ts.isJsxAttribute(node) && visible.has(node.name.getText(syntax)) && node.initializer && ts.isStringLiteral(node.initializer) && needsTranslation(node.initializer.text)) errors.push(`${file}: untranslated attribute ${node.name.getText(syntax)}`);
        if (ts.isCallExpression(node) && node.expression.getText(syntax) === 'ui') {
          const key = node.arguments[0];
          if (!key || !ts.isStringLiteral(key)) errors.push(`${file}: interface keys must be static`);
          else if (!catalog[key.text] && !catalog[key.text + '_other']) errors.push(`${file}: unknown interface key ${key.text}`);
          else {
            const expected=translationPlaceholders(catalog[key.text] ?? catalog[key.text+'_other']);
            const values=node.arguments[1];
            const provided=values && ts.isObjectLiteralExpression(values) ? values.properties.map(property=>property.name?.getText(syntax)) : [];
            if (expected.some(name=>!provided.includes(name))) errors.push(`${file}: missing interface parameters for ${key.text}: ${expected.filter(name=>!provided.includes(name)).join(', ')}`);
            const parent=node.parent;
            if (ts.isComputedPropertyName(parent) || ts.isElementAccessExpression(parent) || ts.isBindingElement(parent) || ts.isBinaryExpression(parent) && ['===','!==','==','!='].includes(parent.operatorToken.getText(syntax))) errors.push(`${file}: translated text must not be used as a protocol or settings key`);
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(syntax);
    }
  }
  await walk(sourceRoot);
  if (errors.length) throw Error(errors.join('\n'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command = 'check', first, second, ...extra] = process.argv.slice(2);
    if (extra.length) throw Error('Too many localization arguments.');
    if (command === 'check' && first === undefined) {
      const catalogs = await checkCatalogs();
      await checkUiKeys(catalogs.en);
      const words = Object.values(catalogs.en).reduce((sum, text) => sum + [...new Intl.Segmenter('en', { granularity: 'word' }).segment(text.replace(/\{\{[^}]+\}\}/g, ' '))].filter(part => part.isWordLike).length, 0);
      console.log(`${Object.keys(catalogs.en).length} English keys, ${words} source words; bundled languages: ${Object.keys(catalogs).join(', ')}`);
    } else if (command === 'export' && first && !second) console.log(`Exported ${ (await exportCatalogs(first)).join(', ') } to ${first}`);
    else if (command === 'import' && first && second) console.log(`Imported ${await importCatalog(first, second)} reviewed ${first} translations. Review the diff before committing.`);
    else throw Error('Usage: localization.mjs check | export <new-absolute-directory> | import <language> <file.json>');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
