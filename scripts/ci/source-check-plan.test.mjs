import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  FULL_MODE, MODES, NATIVE_COMPILATION_FIXTURES, SOURCE_ONLY_MARKER, SOURCE_ONLY_MODE,
  buildPlan, hasSourceOnlyMarker, listCompilingFixtures, modeOutputLine, omissionReport,
  parseRuntimeToolFiles, readEventPayload, resolveMode, sourceOnlyMarkerLocation,
  writeGithubOutput,
} from './source-check-plan.mjs';

const yaml = createRequire(import.meta.url)('js-yaml');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const helper = path.join(root, 'scripts/ci/source-check-plan.mjs');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const packageJson = () => JSON.parse(read('package.json'));
const runtimeToolsScript = () => packageJson().scripts['test:runtime-tools'];

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of ['NEXUS_SOURCE_CHECK_MODE', 'NEXUS_EVENT_NAME', 'NEXUS_EVENT_PATH',
    'GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY']) delete env[key];
  return { ...env, ...extra };
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [helper, ...args], { encoding: 'utf8', env: cleanEnv(env) });
}

function tempFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-source-plan-'));
  return { directory, join: name => path.join(directory, name) };
}

test('full mode keeps the exact existing runtime tool command and files', () => {
  const script = runtimeToolsScript();
  const files = parseRuntimeToolFiles(script);
  const plan = buildPlan({ mode: FULL_MODE, runtimeToolsScript: script, exists: () => true });
  assert.equal(plan.mode, FULL_MODE);
  assert.equal(plan.installNativeToolchain, true);
  assert.deepEqual(plan.runtimeTools.command, ['npm', 'run', 'test:runtime-tools']);
  assert.deepEqual(plan.runtimeTools.files, files);
  assert.deepEqual(plan.runtimeTools.omitted, []);
  assert.deepEqual(omissionReport(plan), []);
  assert.ok(files.includes('scripts/runtime-compat/staging.test.mjs'));
});

test('source-only mode keeps every noncompiling runtime tool fixture in order', () => {
  const script = runtimeToolsScript();
  const files = parseRuntimeToolFiles(script);
  const plan = buildPlan({ mode: SOURCE_ONLY_MODE, runtimeToolsScript: script, exists: () => true });
  assert.equal(plan.mode, SOURCE_ONLY_MODE);
  assert.equal(plan.installNativeToolchain, false);
  assert.deepEqual(plan.runtimeTools.omitted.map(item => item.file),
    ['scripts/runtime-compat/staging.test.mjs']);
  assert.ok(plan.runtimeTools.omitted.every(item => typeof item.reason === 'string' && item.reason.length > 0));
  assert.deepEqual(plan.runtimeTools.files,
    files.filter(file => file !== 'scripts/runtime-compat/staging.test.mjs'));
  assert.deepEqual(plan.runtimeTools.command, ['node', '--test', ...plan.runtimeTools.files]);
  assert.ok(plan.runtimeTools.files.includes('scripts/eac-trace-summary.test.mjs'));
  assert.ok(plan.runtimeTools.files.some(file => file.startsWith('scripts/runtime-tests/')));
  assert.ok(plan.runtimeTools.files.every(file => !file.includes('runtime-compat/staging')));
});

test('source-only mode reports the native omission without claiming native coverage', () => {
  const plan = buildPlan({ mode: SOURCE_ONLY_MODE, runtimeToolsScript: runtimeToolsScript(), exists: () => true });
  const report = omissionReport(plan).join('\n');
  assert.match(report, /gcc-mingw-w64-x86-64/);
  assert.match(report, /scripts\/runtime-compat\/staging\.test\.mjs/);
  assert.match(report, /not a substitute for the full native checks/);
  assert.doesNotMatch(report, /passed/i);
});

test('the declared omission is justified by actual compiler invocations', () => {
  const files = parseRuntimeToolFiles(runtimeToolsScript());
  assert.deepEqual(listCompilingFixtures(files, read), NATIVE_COMPILATION_FIXTURES.map(item => item.file));
  const plan = buildPlan({ mode: SOURCE_ONLY_MODE, runtimeToolsScript: runtimeToolsScript(), exists: () => true });
  assert.deepEqual(listCompilingFixtures(plan.runtimeTools.files, read), []);
  assert.match(read('scripts/runtime-compat/staging.test.mjs'), /execFileSync\('x86_64-w64-mingw32-gcc'/);
  assert.match(read('scripts/runtime-compat/build.mjs'), /run\('gcc'/);
  assert.match(read('scripts/runtime-compat/build.mjs'), /run\('x86_64-w64-mingw32-gcc'/);
});

test('source-only fails closed on a future compiling fixture not in the manifest', () => {
  const sources = {
    'spawns-compiler.test.mjs': "import { execFileSync } from 'node:child_process';\nexecFileSync('cargo', ['test']);",
    'requires-compiler.test.mjs': "const { spawnSync } = require('node:child_process');\nconst command = 'clang';\n",
    'spawns-node.test.mjs': "import { execFileSync } from 'node:child_process';\nexecFileSync(process.execPath, ['-e', '']);",
    'mentions-compiler.test.mjs': "const command = 'winegcc';\n",
  };
  assert.deepEqual(listCompilingFixtures(Object.keys(sources), file => sources[file]),
    ['spawns-compiler.test.mjs', 'requires-compiler.test.mjs']);
});

test('push and pull request markers select source-only mode from their own field', () => {
  assert.equal(resolveMode('push', { head_commit: { message: '[source-only] Sync sources' } }), SOURCE_ONLY_MODE);
  assert.equal(resolveMode('push', { head_commit: { message: 'Ordinary integration' } }), FULL_MODE);
  assert.equal(resolveMode('pull_request', { pull_request: { title: '[source-only] Sync sources' } }), SOURCE_ONLY_MODE);
  assert.equal(resolveMode('pull_request', { pull_request: { title: 'Ordinary integration' } }), FULL_MODE);
  assert.equal(sourceOnlyMarkerLocation('push', { head_commit: { message: '[source-only] x' } }), 'push head commit message');
  assert.equal(sourceOnlyMarkerLocation('pull_request', { pull_request: { title: '[source-only] x' } }), 'pull request title');
  assert.equal(sourceOnlyMarkerLocation('pull_request', { pull_request: { title: 'x' } }), null);
});

test('marker fields do not leak across events and default stays full', () => {
  assert.equal(resolveMode('push', { pull_request: { title: '[source-only] x' } }), FULL_MODE);
  assert.equal(resolveMode('pull_request', {
    head_commit: { message: '[source-only] x' },
    pull_request: { title: 'Ordinary integration' },
  }), FULL_MODE);
  assert.equal(resolveMode('pull_request', {
    pull_request: { title: 'Ordinary integration', body: '[source-only] x' },
  }), FULL_MODE);
  assert.equal(resolveMode('workflow_dispatch', {}), FULL_MODE);
  assert.equal(resolveMode('', {}), FULL_MODE);
  assert.equal(resolveMode('push', {}), FULL_MODE);
  assert.equal(resolveMode('pull_request', {}), FULL_MODE);
  assert.equal(resolveMode('push', { head_commit: { message: null } }), FULL_MODE);
  assert.equal(resolveMode('pull_request', { pull_request: { title: 123 } }), FULL_MODE);
  assert.equal(hasSourceOnlyMarker('[Source-Only] x'), false);
});

test('hostile event text cannot change the selected mode or reach the output file', () => {
  const hostile = [
    '$(touch pwned)',
    '`touch pwned`',
    "'; touch pwned; '",
    'x\nmode=full',
    '[source-only]\n$(touch pwned)',
    '\u202e[source-only]',
  ];
  for (const title of hostile) {
    const mode = resolveMode('pull_request', { pull_request: { title } });
    assert.ok(MODES.includes(mode));
    assert.equal(mode, title.includes(SOURCE_ONLY_MARKER) ? SOURCE_ONLY_MODE : FULL_MODE);
  }
  assert.equal(modeOutputLine(SOURCE_ONLY_MODE), 'mode=source-only\n');
  assert.equal(modeOutputLine(FULL_MODE), 'mode=full\n');
  for (const mode of ['source_only', 'full\nINJECTED=1', 'source-only\r\nmode=full'])
    assert.throws(() => modeOutputLine(mode), /Refusing to publish unknown source check mode/);
});

test('the output writer appends only a validated literal mode', () => {
  const fixture = tempFixture();
  try {
    const output = fixture.join('output');
    fs.writeFileSync(output, '');
    writeGithubOutput(output, SOURCE_ONLY_MODE);
    writeGithubOutput(output, FULL_MODE);
    assert.equal(fs.readFileSync(output, 'utf8'), 'mode=source-only\nmode=full\n');
    assert.throws(() => writeGithubOutput(output, 'source-only\nINJECTED=1'), /Refusing/);
    assert.equal(fs.readFileSync(output, 'utf8'), 'mode=source-only\nmode=full\n');
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('source-only fails closed when the exclusion manifest is stale or incomplete', () => {
  assert.throws(() => buildPlan({
    mode: SOURCE_ONLY_MODE, runtimeToolsScript: runtimeToolsScript(), exists: () => false,
  }), /missing from the checkout/);
  assert.throws(() => buildPlan({
    mode: SOURCE_ONLY_MODE, runtimeToolsScript: 'node --test scripts/other.test.mjs', exists: () => true,
  }), /not selected by test:runtime-tools/);
});

test('unknown modes fail instead of falling back to a silent plan', () => {
  for (const mode of ['', 'source_only', 'FULL', 'full\nINJECTED=1', undefined, null])
    assert.throws(() => buildPlan({ mode, runtimeToolsScript: runtimeToolsScript(), exists: () => true }),
      /Unknown source check mode/);
});

test('runtime tool script parsing rejects shell syntax and escaping paths', () => {
  assert.deepEqual(parseRuntimeToolFiles('node --test a.test.mjs scripts/b.test.mjs'),
    ['a.test.mjs', 'scripts/b.test.mjs']);
  for (const script of ['', 'node --test', 'npm --test a.test.mjs', 'node --test $(touch x).test.mjs',
    'node --test ../a.test.mjs', 'node --test /a.test.mjs', 'node --test a.test.mjs && touch x'])
    assert.throws(() => parseRuntimeToolFiles(script));
});

test('malformed event JSON fails closed instead of selecting a silent mode', () => {
  const fixture = tempFixture();
  try {
    const invalid = fixture.join('invalid.json');
    fs.writeFileSync(invalid, '[');
    assert.throws(() => readEventPayload(invalid), /not valid JSON/);
    const array = fixture.join('array.json');
    fs.writeFileSync(array, '[]');
    assert.throws(() => readEventPayload(array), /must be a JSON object/);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('resolve-mode publishes only a literal mode from the event payload', () => {
  const fixture = tempFixture();
  try {
    const event = fixture.join('event.json');
    const output = fixture.join('output');
    fs.writeFileSync(output, '');
    const resolve = (name, payload) => {
      fs.writeFileSync(event, JSON.stringify(payload));
      fs.writeFileSync(output, '');
      const result = runCli(['resolve-mode'], {
        NEXUS_EVENT_NAME: name, NEXUS_EVENT_PATH: event, GITHUB_OUTPUT: output,
      });
      assert.equal(result.status, 0, result.stderr);
      return { result, written: fs.readFileSync(output, 'utf8') };
    };
    let resolved = resolve('pull_request', { pull_request: { title: '[source-only] Sync sources' } });
    assert.equal(resolved.written, 'mode=source-only\n');
    assert.match(resolved.result.stdout, /marker in pull request title/);
    resolved = resolve('push', {
      head_commit: { message: '[source-only] Sync sources' },
      pull_request: { title: 'Ordinary integration' },
    });
    assert.equal(resolved.written, 'mode=source-only\n');
    assert.match(resolved.result.stdout, /marker in push head commit message/);
    resolved = resolve('push', { head_commit: { message: 'Ordinary integration' } });
    assert.equal(resolved.written, 'mode=full\n');
    assert.match(resolved.result.stdout, /default full checks/);
    resolved = resolve('pull_request', { pull_request: { title: "[source-only]\n$(touch pwned)" } });
    assert.equal(resolved.written, 'mode=source-only\n');
    resolved = resolve('pull_request', { pull_request: { title: "'; touch pwned; '" } });
    assert.equal(resolved.written, 'mode=full\n');
    resolved = resolve('workflow_dispatch', { head_commit: { message: '[source-only] ignored' } });
    assert.equal(resolved.written, 'mode=full\n');
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('report command prints and summarizes the omitted native fixture', () => {
  const fixture = tempFixture();
  try {
    const summary = fixture.join('summary.md');
    fs.writeFileSync(summary, '');
    const result = runCli(['report'], {
      NEXUS_SOURCE_CHECK_MODE: SOURCE_ONLY_MODE, GITHUB_STEP_SUMMARY: summary,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /scripts\/runtime-compat\/staging\.test\.mjs/);
    assert.match(result.stdout, /not a substitute for the full native checks/);
    assert.match(fs.readFileSync(summary, 'utf8'), /scripts\/runtime-compat\/staging\.test\.mjs/);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('mode consumers reject unknown modes before running anything', () => {
  for (const command of ['validate-mode', 'report', 'run-runtime-tools']) {
    const result = runCli([command], { NEXUS_SOURCE_CHECK_MODE: 'native' });
    assert.notEqual(result.status, 0, command);
    assert.match(result.stderr, /Unknown source check mode/, command);
  }
  for (const mode of [FULL_MODE, SOURCE_ONLY_MODE]) {
    const result = runCli(['validate-mode'], { NEXUS_SOURCE_CHECK_MODE: mode });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Source check mode: ${mode}`));
  }
});

test('workflow wiring resolves the mode once and keeps full and candidate behavior', () => {
  const workflow = yaml.load(read('.github/workflows/ci.yml'));
  const steps = workflow.jobs.checks.steps;
  const mode = steps.find(step => step.name === 'Resolve source check mode');
  assert.equal(mode.id, 'source_mode');
  assert.equal(mode.run, 'node scripts/ci/source-check-plan.mjs resolve-mode');
  assert.deepEqual(mode.env, {
    NEXUS_EVENT_NAME: '${{ github.event_name }}',
    NEXUS_EVENT_PATH: '${{ github.event_path }}',
  });
  const validate = steps.find(step => step.name === 'Validate source check mode');
  assert.equal(validate.run, 'node scripts/ci/source-check-plan.mjs validate-mode');
  assert.deepEqual(validate.env, { NEXUS_SOURCE_CHECK_MODE: '${{ steps.source_mode.outputs.mode }}' });
  assert.equal(validate.if, undefined);
  const toolchain = steps.find(step => step.run?.includes('ubuntu-mirror.mjs'));
  assert.equal(toolchain.if, "steps.source_mode.outputs.mode == 'full'");
  assert.equal(toolchain['timeout-minutes'], 15);
  assert.ok(steps.indexOf(validate) > steps.indexOf(mode));
  assert.ok(steps.indexOf(validate) < steps.indexOf(toolchain));
  const checks = steps.find(step => step.name === 'Check source without compiling a distribution candidate');
  assert.equal(checks.if, "github.ref != 'refs/heads/main' || contains(github.event.head_commit.message, '[source-only]')");
  assert.equal(checks.run, 'npm run i18n:check && npm run typecheck && npm run test');
  const report = steps.find(step => step.run === 'node scripts/ci/source-check-plan.mjs report');
  assert.ok(steps.indexOf(report) < steps.indexOf(toolchain));
  assert.ok(steps.indexOf(report) < steps.indexOf(checks));
  assert.ok(steps.some(step => step.run === 'npm run test:ci-tools'));
  const fullTools = steps.find(step => step.run === 'npm run test:runtime-tools');
  assert.equal(fullTools.if, "steps.source_mode.outputs.mode == 'full'");
  for (const command of ['report', 'run-runtime-tools']) {
    const step = steps.find(item => item.run === `node scripts/ci/source-check-plan.mjs ${command}`);
    assert.equal(step.if, "steps.source_mode.outputs.mode == 'source-only'");
    assert.deepEqual(step.env, { NEXUS_SOURCE_CHECK_MODE: '${{ steps.source_mode.outputs.mode }}' });
  }
  const candidateGuard = "github.ref == 'refs/heads/main' && !contains(github.event.head_commit.message, '[source-only]')";
  for (const step of steps.filter(item => item.run?.includes('npm run build') ||
    item.run?.includes('electron-builder') || item.run?.includes('artifact-manifest.mjs') ||
    item.uses?.startsWith('actions/upload-artifact')))
    assert.equal(step.if, candidateGuard);
  for (const step of steps) {
    if (typeof step.run === 'string')
      assert.doesNotMatch(step.run, /github\.event\.|head_commit|pull_request\.title|\$\{\{\s*github\.event/);
    assert.equal(step['continue-on-error'], undefined);
  }
  assert.deepEqual(workflow.on.push.branches, ['main', 'develop']);
  assert.ok(workflow.on.pull_request);
  assert.doesNotMatch(read('.github/workflows/ci.yml'), /\[skip ci\]/i);
});

test('the unit test command and its exclusions remain unchanged', () => {
  const scripts = packageJson().scripts;
  assert.equal(scripts.test, 'vitest run');
  assert.match(scripts.typecheck, /tsc --noEmit/);
  assert.match(scripts.typecheck, /tsconfig\.electron\.json --noEmit/);
  assert.match(read('vitest.config.ts'), /scripts\/\*\*\/\*\.test\.mjs/);
});
