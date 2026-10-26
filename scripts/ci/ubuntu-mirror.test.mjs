import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { configureUbuntuMirrors, officialUbuntuMirrors } from './ubuntu-mirror.mjs';
const yaml = createRequire(import.meta.url)('js-yaml');

test('the separate runtime fork owns automatic SDK builds; legacy build is manual only', async () => {
  const runtime = yaml.load(await fs.readFile('.github/workflows/runtime.yml', 'utf8'));
  assert.deepEqual(Object.keys(runtime.on), ['workflow_dispatch']);
  assert.equal(runtime.jobs.changes.if, "github.ref == 'refs/heads/main'");
  assert.ok(runtime.jobs.build.steps.some(step => step.run?.includes('build-shared-runtime.mjs')));
});

test('Ubuntu mirror replacement preserves suites, signing keys and other repositories', () => {
  const source = 'Types: deb\nURIs: http://azure.archive.ubuntu.com/ubuntu/\nSuites: noble noble-updates\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n\n' +
    'deb http://security.ubuntu.com/ubuntu noble-security main\n' +
    'deb https://packages.microsoft.com/repos/code stable main\n' +
    'deb http://azure.archive.ubuntu.com.example/ubuntu noble main\n';
  const updated = officialUbuntuMirrors(source);
  assert.equal(updated, source.replace('http://azure.archive.ubuntu.com/ubuntu/', 'https://archive.ubuntu.com/ubuntu/')
    .replace('http://security.ubuntu.com/ubuntu', 'https://security.ubuntu.com/ubuntu'));
  assert.equal(officialUbuntuMirrors(updated), updated);
});

test('both legacy sources and GitHub mirror+file lists are changed without touching unrelated files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-apt-test-'));
  try {
    await fs.mkdir(path.join(root, 'sources.list.d'));
    const files = {
      'sources.list': 'deb https://azure.archive.ubuntu.com/ubuntu jammy main\n',
      'apt-mirrors.txt': 'http://azure.archive.ubuntu.com/ubuntu\nhttp://archive.ubuntu.com/ubuntu\n',
      'apt-mirrors-security.txt': 'http://security.ubuntu.com/ubuntu\n',
      'sources.list.d/ubuntu.sources': 'URIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n',
      'sources.list.d/vendor.list': 'deb https://example.org/packages stable main\n',
      'sources.list.d/ignored.save': 'http://azure.archive.ubuntu.com/ubuntu\n',
    };
    for (const [name, data] of Object.entries(files)) await fs.writeFile(path.join(root, name), data, { mode: 0o640 });
    assert.equal(await configureUbuntuMirrors(root), 3);
    for (const [name, data] of Object.entries(files)) {
      const expected = name.endsWith('.save') ? data : officialUbuntuMirrors(data);
      assert.equal(await fs.readFile(path.join(root, name), 'utf8'), expected);
      assert.equal((await fs.stat(path.join(root, name))).mode & 0o777, 0o640);
    }
    assert.equal(await configureUbuntuMirrors(root), 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('unrecognized configurations and symlink sources fail before modifying files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-apt-test-'));
  try {
    await fs.mkdir(path.join(root, 'sources.list.d'));
    const vendor = 'deb https://example.org/packages stable main\n';
    await fs.writeFile(path.join(root, 'sources.list'), vendor);
    await assert.rejects(configureUbuntuMirrors(root), /No supported Ubuntu/);
    assert.equal(await fs.readFile(path.join(root, 'sources.list'), 'utf8'), vendor);
    const source = 'deb http://azure.archive.ubuntu.com/ubuntu noble main\n';
    await fs.writeFile(path.join(root, 'sources.list'), source);
    await fs.symlink(path.join(root, 'sources.list'), path.join(root, 'sources.list.d/link.sources'));
    await assert.rejects(configureUbuntuMirrors(root), /regular file/);
    assert.equal(await fs.readFile(path.join(root, 'sources.list'), 'utf8'), source);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('source and both runtime CI jobs select official mirrors with bounded dependency installation', async () => {
  const ci = yaml.load(await fs.readFile('.github/workflows/ci.yml', 'utf8'));
  const runtime = yaml.load(await fs.readFile('.github/workflows/runtime.yml', 'utf8'));
  for (const [steps, label] of [[ci.jobs.checks.steps, 'fixture'], [runtime.jobs.media.steps, 'media'], [runtime.jobs.build.steps, 'runtime']]) {
    const step = steps.find(item => item.run?.includes('ubuntu-mirror.mjs'));
    assert.ok(step, label);
    assert.equal(step['timeout-minutes'], 15, label);
    assert.ok(step.run.includes('sudo "$(command -v node)" scripts/ci/ubuntu-mirror.mjs'), label);
    assert.ok(step.run.indexOf('ubuntu-mirror.mjs') < step.run.indexOf('apt-get '), label);
    assert.match(step.run, /apt-get [^\n]* update(?:\n|$)/, label);
    assert.match(step.run, /apt-get [^\n]* install -y/, label);
    assert.equal((step.run.match(/Acquire::Retries=2/g) ?? []).length, 2, label);
    assert.equal((step.run.match(/Acquire::http::Timeout=30/g) ?? []).length, 2, label);
    assert.equal((step.run.match(/Acquire::https::Timeout=30/g) ?? []).length, 2, label);
    assert.doesNotMatch(step.run, /allow-unauthenticated|trusted=yes|Verify-Peer=false|apt-key/);
    const parsed = spawnSync('bash', ['-n'], { input: step.run, encoding: 'utf8' });
    assert.equal(parsed.status, 0, parsed.stderr);
  }
});
