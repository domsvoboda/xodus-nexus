// Resolve the launcher source-check mode and select runtime tool fixtures.
// The full mode keeps the existing commands. The explicit source-only mode
// omits only fixtures that invoke a native compiler, and reports the omission.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SOURCE_ONLY_MARKER = '[source-only]';
export const FULL_MODE = 'full';
export const SOURCE_ONLY_MODE = 'source-only';
export const MODES = [FULL_MODE, SOURCE_ONLY_MODE];

// Keep this list explicit. Every entry must remain selected by the
// test:runtime-tools script and must exist in the checkout. If either check
// fails, source-only mode fails closed instead of silently compiling or
// silently dropping a different fixture.
export const NATIVE_COMPILATION_FIXTURES = [
  {
    file: 'scripts/runtime-compat/staging.test.mjs',
    reason: 'builds the MinGW probe DLL, the Linux wine launcher shim and the Windows compatibility executable',
  },
];

// Source-only catches future fixtures that both spawn a process and mention a
// native compiler. A new such file must be reviewed and added to the manifest
// instead of silently compiling during a source-only check.
const COMPILER_INVOCATION_HINT = /(x86_64-w64-mingw32-gcc|\bgcc\b|\bg\+\+\b|\bclang\b|\bwinegcc\b|\bcargo\b|\brustc\b|buildCompatibility)/;
const SPAWNS_PROCESS = /from ['"]node:child_process['"]|require\(\s*['"]node:child_process['"]\s*\)/;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function hasSourceOnlyMarker(text) {
  return typeof text === 'string' && text.includes(SOURCE_ONLY_MARKER);
}

export function sourceOnlyMarkerLocation(eventName, event) {
  if (eventName === 'push') return hasSourceOnlyMarker(event?.head_commit?.message) ? 'push head commit message' : null;
  if (eventName === 'pull_request') return hasSourceOnlyMarker(event?.pull_request?.title) ? 'pull request title' : null;
  return null;
}

export function resolveMode(eventName, event) {
  return sourceOnlyMarkerLocation(eventName, event) ? SOURCE_ONLY_MODE : FULL_MODE;
}

export function readEventPayload(file) {
  if (!file) return {};
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read CI event payload: ${error.message}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('CI event payload is not valid JSON');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('CI event payload must be a JSON object');
  return payload;
}

export function parseRuntimeToolFiles(script) {
  if (typeof script !== 'string' || !script.trim())
    throw new Error('Missing test:runtime-tools script');
  const tokens = script.trim().split(/\s+/);
  if (tokens[0] !== 'node' || tokens[1] !== '--test')
    throw new Error('Unsupported test:runtime-tools command');
  const files = tokens.slice(2);
  if (files.length === 0) throw new Error('test:runtime-tools selects no test files');
  for (const file of files) {
    if (!/^[A-Za-z0-9._/-]+\.test\.mjs$/.test(file) || file.startsWith('/') || file.split('/').includes('..'))
      throw new Error(`Unsafe test:runtime-tools path: ${file}`);
  }
  return files;
}

export function buildPlan({ mode, runtimeToolsScript, exists = fs.existsSync } = {}) {
  if (!MODES.includes(mode)) throw new Error(`Unknown source check mode: ${String(mode)}`);
  const files = parseRuntimeToolFiles(runtimeToolsScript);
  if (mode === FULL_MODE) {
    return {
      mode,
      installNativeToolchain: true,
      runtimeTools: { command: ['npm', 'run', 'test:runtime-tools'], files, omitted: [] },
    };
  }
  const omitted = NATIVE_COMPILATION_FIXTURES.map(item => ({ ...item }));
  for (const item of omitted) {
    if (!files.includes(item.file))
      throw new Error(`Native compilation fixture is not selected by test:runtime-tools: ${item.file}`);
    if (!exists(item.file))
      throw new Error(`Native compilation fixture is missing from the checkout: ${item.file}`);
  }
  const omittedFiles = new Set(omitted.map(item => item.file));
  const selected = files.filter(file => !omittedFiles.has(file));
  if (selected.length === 0) throw new Error('Source-only mode would run no runtime tool tests');
  return {
    mode,
    installNativeToolchain: false,
    runtimeTools: { command: ['node', '--test', ...selected], files: selected, omitted },
  };
}

export function listCompilingFixtures(files, readFile) {
  return files.filter(file => {
    const source = readFile(file);
    return SPAWNS_PROCESS.test(source) && COMPILER_INVOCATION_HINT.test(source);
  });
}

export function omissionReport(plan) {
  if (plan.mode !== SOURCE_ONLY_MODE) return [];
  const lines = [
    '[source-only] Native toolchain installation (gcc-mingw-w64-x86-64) is skipped.',
  ];
  for (const item of plan.runtimeTools.omitted)
    lines.push(`[source-only] Omitted native compilation fixture: ${item.file} (${item.reason}).`);
  lines.push(`[source-only] ${plan.runtimeTools.files.length} of ${plan.runtimeTools.files.length + plan.runtimeTools.omitted.length} runtime tool test files still run.`);
  lines.push('[source-only] Native fixture compilation did not run; this is not a substitute for the full native checks.');
  return lines;
}

export function modeOutputLine(mode) {
  if (!MODES.includes(mode)) throw new Error(`Refusing to publish unknown source check mode: ${String(mode)}`);
  return `mode=${mode}\n`;
}

export function writeGithubOutput(file, mode) {
  const line = modeOutputLine(mode);
  fs.appendFileSync(file, line, 'utf8');
  return line;
}

function currentPlan(mode) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return buildPlan({
    mode,
    runtimeToolsScript: packageJson.scripts?.['test:runtime-tools'],
    exists: file => fs.existsSync(path.join(root, file)),
  });
}

function modeFromEnv() {
  const mode = process.env.NEXUS_SOURCE_CHECK_MODE;
  if (!MODES.includes(mode)) throw new Error(`Unknown source check mode: ${String(mode)}`);
  return mode;
}

function resolveModeCommand() {
  const eventName = process.env.NEXUS_EVENT_NAME ?? process.env.GITHUB_EVENT_NAME ?? '';
  const eventPath = process.env.NEXUS_EVENT_PATH ?? process.env.GITHUB_EVENT_PATH ?? '';
  const event = readEventPayload(eventPath);
  const mode = resolveMode(eventName, event);
  const output = process.env.GITHUB_OUTPUT;
  if (output) writeGithubOutput(output, mode);
  else console.log(modeOutputLine(mode).trim());
  const location = sourceOnlyMarkerLocation(eventName, event);
  console.log(`Source check mode: ${mode}${location ? ` (marker in ${location})` : ' (default full checks)'}`);
}

function validateModeCommand() {
  console.log(`Source check mode: ${modeFromEnv()}`);
}

function reportCommand() {
  const mode = modeFromEnv();
  if (mode !== SOURCE_ONLY_MODE)
    throw new Error(`report only supports ${SOURCE_ONLY_MODE} mode, received ${mode}`);
  const plan = currentPlan(SOURCE_ONLY_MODE);
  const lines = omissionReport(plan);
  for (const line of lines) console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = ['### Source-only checks', '', ...lines.map(line => `- ${line}`), ''].join(os.EOL);
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary, 'utf8');
  }
}

function runRuntimeToolsCommand() {
  const mode = modeFromEnv();
  if (mode !== SOURCE_ONLY_MODE)
    throw new Error(`run-runtime-tools only supports ${SOURCE_ONLY_MODE} mode, received ${mode}`);
  const plan = currentPlan(mode);
  const unlisted = listCompilingFixtures(plan.runtimeTools.files, file => fs.readFileSync(path.join(root, file), 'utf8'));
  if (unlisted.length > 0)
    throw new Error(`Unlisted compiling runtime tool fixtures in source-only mode: ${unlisted.join(', ')}`);
  const [command, ...args] = plan.runtimeTools.command;
  if (command !== 'node') throw new Error(`Unexpected runtime tool command: ${command}`);
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Runtime tool tests terminated by ${result.signal}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function main() {
  const command = process.argv[2];
  if (command === 'resolve-mode') return resolveModeCommand();
  if (command === 'validate-mode') return validateModeCommand();
  if (command === 'report') return reportCommand();
  if (command === 'run-runtime-tools') return runRuntimeToolsCommand();
  throw new Error('Usage: source-check-plan.mjs <resolve-mode|validate-mode|report|run-runtime-tools>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
