import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { validatePull } from '../tolgee-pull.mjs';

const yaml = createRequire(import.meta.url)('js-yaml');
const config = JSON.parse(await fs.readFile('.tolgeerc.json', 'utf8'));
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-tolgee-test-'));
after(() => fs.rm(staging, { recursive: true, force: true }));

test('Tolgee config pins the project and uploads only English without removing remote keys', () => {
  assert.equal(config.projectId, 36162);
  assert.equal(config.apiUrl, 'https://app.tolgee.io');
  assert.equal(config.format, 'JSON_I18NEXT');
  assert.deepEqual(config.push.files, [{ path: 'assets/locales/en.json', language: 'en' }]);
  assert.deepEqual(config.push.languages, ['en']);
  assert.equal(config.push.removeOtherKeys, false);
  assert.equal(config.push.overrideKeyDescriptions, false);
  assert.equal(config.push.convertPlaceholdersToIcu, true);
  assert.equal(config.push.forceMode, 'OVERRIDE');
  assert.equal(config.apiKey, undefined);
  assert.equal(config.headers, undefined);
  assert.equal(config.sync, undefined);
});

test('reviewed export retains flat i18next parameters and never targets bundled files', () => {
  assert.deepEqual(config.pull.states, ['REVIEWED']);
  assert.equal(config.pull.delimiter, '');
  assert.equal(config.pull.fileStructureTemplate, '{languageTag}.{extension}');
  assert.equal(config.pull.emptyDir, false);
  assert.equal(config.pull.supportArrays, false);
  assert.equal(config.pull.path, 'work/tolgee-reviewed');
  assert.equal(config.pull.languages, undefined);
  assert.equal(pkg.devDependencies['@tolgee/cli'], '2.21.0');
  assert.equal(pkg.dependencies['@tolgee/cli'], undefined);
  assert.doesNotMatch(pkg.scripts.build, /tolgee|i18n:pull|i18n:push/);
});

test('only main can upload, no PR secrets, write permissions, package build or release', async () => {
  const workflow = yaml.load(await fs.readFile('.github/workflows/translations.yml', 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['push', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.ok(workflow.on.push.paths.includes('assets/locales/en.json'));
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.equal(workflow.jobs.source.if, "github.ref == 'refs/heads/main'");
  const steps = workflow.jobs.source.steps;
  assert.deepEqual(steps[0].with, { ref: 'main', 'persist-credentials': false });
  assert.equal(steps.find(step => step.run?.includes('npm ci')).run, 'npm ci --ignore-scripts');
  const secretSteps = steps.filter(step => JSON.stringify(step).includes('secrets.'));
  assert.equal(secretSteps.length, 1);
  assert.equal(secretSteps[0].env.TOLGEE_API_KEY, '${{ secrets.TOLGEE_SOURCE_API_KEY }}');
  assert.match(secretSteps[0].run, /npm run i18n:push/);
  assert.doesNotMatch(JSON.stringify(workflow), /pull_request|npm run build|electron-builder|gh release|contents: write/);
});

test('staging accepts partial reviewed languages without altering English or shipped files', async () => {
  const folder = await fs.mkdtemp(path.join(staging, 'valid-'));
  const english = { welcome: 'Hello {{name}}' };
  await fs.writeFile(path.join(folder, 'cs.json'), '{"welcome":"Ahoj {{name}}"}');
  const result = await validatePull(folder, english);
  assert.deepEqual({ ...result.cs }, { welcome: 'Ahoj {{name}}' });
  assert.deepEqual(english, { welcome: 'Hello {{name}}' });
});

test('staging rejects symlinks, nested exports, noncanonical tags and unsafe translations', async () => {
  for (const [filename, value] of [
    ['cs.json', '{"save":"One","save":"Two"}'],
    ['cs.json', '{"unknown":"Bad"}'],
    ['cs.json', '{"save":"<b>Bad</b>"}'],
    ['pt-br.json', '{"save":"Save"}'],
    ['readme.txt', 'Bad'],
  ]) {
    const folder = await fs.mkdtemp(path.join(staging, 'bad-'));
    await fs.writeFile(path.join(folder, filename), value);
    await assert.rejects(validatePull(folder, { save: 'Save' }));
  }
  const nested = await fs.mkdtemp(path.join(staging, 'nested-'));
  await fs.mkdir(path.join(nested, 'namespace'));
  await assert.rejects(validatePull(nested, {}));
  const linked = await fs.mkdtemp(path.join(staging, 'linked-'));
  await fs.symlink(path.resolve('assets/locales/en.json'), path.join(linked, 'cs.json'));
  await assert.rejects(validatePull(linked, {}));
});

test('actual pinned CLI uploads exactly one English file with the configured import guards', async () => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({ url: request.url, method: request.method, body });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"unresolvedConflicts":[]}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const localConfig = path.join(staging, 'fixture.tolgeerc.json');
    await fs.writeFile(localConfig, JSON.stringify({
      ...config, apiUrl: `http://127.0.0.1:${server.address().port}`,
      push: { ...config.push, files: [{ path: path.resolve('assets/locales/en.json'), language: 'en' }] },
    }));
    const child = spawn(process.execPath, [path.resolve('node_modules/@tolgee/cli/dist/cli.js'), 'push', '--config', localConfig,
      '--error-on-unresolved-conflict', 'yes', '--override-mode', 'ALL'], {
      env: { ...process.env, TOLGEE_API_KEY: 'synthetic-local-fixture-only', TOLGEE_BRANCH: '' },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
    });
    let output = '';
    child.stdout.on('data', value => { output += value; });
    child.stderr.on('data', value => { output += value; });
    assert.equal(await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }), 0, output);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/v2/projects/36162/single-step-import');
    assert.equal(requests[0].method, 'POST');
    const request = new Request('http://localhost', {
      method: 'POST', body: requests[0].body,
      headers: { 'content-type': `multipart/form-data; boundary=${requests[0].body.split('\r\n')[0].slice(2)}` },
    });
    const form = await request.formData();
    const params = JSON.parse(form.get('params'));
    assert.equal(params.removeOtherKeys, false);
    assert.equal(params.overrideKeyDescriptions, false);
    assert.equal(params.convertPlaceholdersToIcu, true);
    assert.equal(params.errorOnUnresolvedConflict, true);
    assert.equal(params.forceMode, 'OVERRIDE');
    assert.equal(params.overrideMode, 'ALL');
    assert.equal(params.fileMappings.length, 1);
    assert.equal(params.fileMappings[0].languageTag, 'en');
    assert.equal(params.fileMappings[0].format, 'JSON_I18NEXT');
    const files = form.getAll('files');
    assert.equal(files.length, 1);
    assert.equal(await files[0].text(), await fs.readFile('assets/locales/en.json', 'utf8'));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('actual pinned CLI requests reviewed flat i18next exports and preserves placeholders', async () => {
  const archiver = createRequire(import.meta.url)('archiver');
  const archive = archiver('zip');
  const zipChunks = [];
  archive.on('data', chunk => zipChunks.push(chunk));
  archive.append('{"hello":"Ahoj {{name}}"}', { name: 'cs.json' });
  await archive.finalize();
  const zip = Buffer.concat(zipChunks);
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ url: request.url, method: request.method, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.writeHead(200, { 'content-type': 'application/zip' });
    response.end(zip);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const localConfig = path.join(staging, 'export.tolgeerc.json');
    const target = await fs.mkdtemp(path.join(staging, 'export-'));
    await fs.writeFile(localConfig, JSON.stringify({ ...config, apiUrl: `http://127.0.0.1:${server.address().port}` }));
    const child = spawn(process.execPath, [path.resolve('node_modules/@tolgee/cli/dist/cli.js'), 'pull', '--config', localConfig, '--path', target], {
      env: { ...process.env, TOLGEE_API_KEY: 'synthetic-local-fixture-only', TOLGEE_BRANCH: '' },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
    });
    let output = '';
    child.stdout.on('data', value => { output += value; });
    child.stderr.on('data', value => { output += value; });
    assert.equal(await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }), 0, output);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/v2/projects/36162/export');
    assert.equal(requests[0].method, 'POST');
    assert.deepEqual(requests[0].body.filterState, ['REVIEWED']);
    assert.equal(requests[0].body.format, 'JSON_I18NEXT');
    assert.equal(requests[0].body.messageFormat, 'I18NEXT');
    assert.equal(requests[0].body.structureDelimiter, '');
    assert.equal(requests[0].body.escapeHtml, false);
    assert.equal(requests[0].body.fileStructureTemplate, '{languageTag}.{extension}');
    const result = await validatePull(target, { hello: 'Hello {{name}}' });
    assert.deepEqual({ ...result.cs }, { hello: 'Ahoj {{name}}' });
  } finally { await new Promise(resolve => server.close(resolve)); }
});
