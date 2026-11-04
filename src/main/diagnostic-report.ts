import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppSnapshot, DiagnosticLog, DiagnosticReport } from '../shared/types.js';

const LOG_LIMIT = 1024 * 1024;
export const REPORT_LIMIT = 8 * 1024 * 1024;
const clean = (value: unknown) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 256) : 'unavailable';

async function smallFile(file: string, limit = 64 * 1024): Promise<string> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw Error('Not a file');
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > limit) throw Error('Too large');
    return bytes.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

// Only explicit hardware fields, never hostname, serial numbers, the process
// environment, command output, /proc/cmdline or the account database.
export async function reportSystemInfo(environment: NodeJS.ProcessEnv = process.env,
  roots = { osRelease: '/etc/os-release', drm: '/sys/class/drm' }): Promise<string> {
  const lines = [`OS: ${os.platform()} ${os.arch()}`, `Kernel: ${clean(os.release())}`];
  try {
    const text = await smallFile(roots.osRelease);
    for (const name of ['PRETTY_NAME', 'ID', 'VERSION_ID', 'VARIANT_ID']) {
      const value = text.split('\n').find(line => line.startsWith(name + '='))?.slice(name.length + 1).replace(/^(["'])(.*)\1$/, '$2');
      if (value) lines.push(`${name}: ${clean(value)}`);
    }
  } catch { lines.push('Distribution: unavailable'); }
  const desktop = environment.XDG_CURRENT_DESKTOP?.toLowerCase().split(':').filter(item => ['kde', 'gnome', 'gamescope', 'xfce', 'cinnamon', 'mate', 'lxqt', 'sway', 'hyprland'].includes(item));
  lines.push(`Desktop: ${desktop?.join(':') || 'unknown'}`);
  lines.push(`Session: ${['x11', 'wayland', 'tty'].includes(environment.XDG_SESSION_TYPE ?? '') ? environment.XDG_SESSION_TYPE : 'unknown'}`);
  lines.push(`Steam launch: ${Boolean(environment.SteamGameId || environment.SteamAppId)}`);
  const cpus = os.cpus();
  lines.push(`CPU: ${clean(cpus[0]?.model)} (${cpus.length} logical CPUs)`, `RAM: ${Math.round(os.totalmem() / 1024 ** 2)} MiB`);
  try {
    const cards = (await fs.readdir(roots.drm)).filter(name => /^card[0-9]+$/.test(name)).slice(0, 16);
    let found = false;
    for (const card of cards) {
      try {
        const device = path.join(roots.drm, card, 'device');
        const vendor = (await smallFile(path.join(device, 'vendor'), 128)).trim();
        const id = (await smallFile(path.join(device, 'device'), 128)).trim();
        if (!/^0x[0-9a-f]{4}$/i.test(vendor) || !/^0x[0-9a-f]{4}$/i.test(id)) continue;
        let driver = 'unknown';
        try { driver = path.basename(await fs.readlink(path.join(device, 'driver'))); } catch { /* optional */ }
        lines.push(`GPU: ${vendor}:${id}, driver ${clean(driver)}`); found = true;
      } catch { /* virtual devices need not have PCI IDs */ }
    }
    if (!found) lines.push('GPU: unavailable');
  } catch { lines.push('GPU: unavailable'); }
  return lines.join('\n');
}

export function redactDiagnosticText(text: string, privateValues: string[] = []): string {
  // Omit sensitive records in full rather than trying to guess token lengths
  // or the syntax of every auth provider. Redaction remains best effort, so the
  // report is editable and must be reviewed before the user shares it.
  text = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  text = text.replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g, '[private key removed]');
  text = text.split(/\r?\n/).map(line =>
    /authorization|\bbearer\b|\bcookies?\b|password|client.?secret|(?:access|refresh|device|session|id)[ _-]?token|\btoken\s*["':=]|\bxuid\b|\buhs\b|user.?hash|account.?id|user.?id|machine.?id|login.?id|host.?name|tenant.?id|serial.?number|gamertag|\busername\b|\bemail\b|"(?:displayName|unique_name|preferred_username)"|(?:^|[?&])(?:sig|jwt|email_token)=/i.test(line)
      ? '[sensitive record removed]' : line).join('\n');
  // Remove whole URLs, including notification email_token and signed package
  // query strings, not only the familiar sig= parameter.
  text = text.replace(/(?:https?|wss?|ftp):\/\/[^\s<>"'`]+/gi, '[URL removed]');
  text = text.replace(/\b[A-Za-z0-9_-]{8,}\.(?:[A-Za-z0-9_-]*\.){1,3}[A-Za-z0-9_-]{8,}\b/g, '[token removed]');
  text = text.replace(/\b[A-Za-z0-9_+/=-]{96,}\b/g, '[long value removed]');
  // Bound both email components so a long opaque log value without an @ does
  // not cause quadratic regular-expression work on the Electron main thread.
  text = text.replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}/gi, '[email removed]');
  text = text.replace(/\b\d{16,20}\b/g, '[numeric identifier removed]');
  text = text.replace(/\/home\/[^/\s"'\\]+/g, '/home/[user]').replace(/\/run\/user\/\d+/g, '/run/user/[uid]');
  text = text.replace(/([A-Z]:\\+users\\+)[^\\\s"']+/gi, '$1[user]');
  // Known display/account names and nonstandard home paths also disappear.
  for (const value of [...new Set(privateValues)].filter(value => value.length >= 2).sort((a, b) => b.length - a.length)) {
    text = text.split(value).join('[private]');
  }
  return text;
}

async function reportLog(file: string, root: string): Promise<DiagnosticLog> {
  const canonicalRoot = await fs.realpath(root);
  const parent = await fs.realpath(path.dirname(file));
  if (parent !== canonicalRoot) throw Error('Not a launcher log');
  const handle = await fs.open(path.join(parent, path.basename(file)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.geteuid?.() || stat.nlink !== 1) throw Error('Unsafe log');
    const length = Math.min(stat.size, LOG_LIMIT), bytes = Buffer.alloc(length), start = stat.size - length;
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(bytes, offset, length - offset, start + offset);
      if (!bytesRead) throw Error('Log changed');
      offset += bytesRead;
    }
    let content = bytes.toString('utf8');
    if (start > 0) content = content.includes('\n') ? content.slice(content.indexOf('\n') + 1) : '';
    return { name: path.basename(file), content, truncated: start > 0 };
  } finally { await handle.close(); }
}

export async function createDiagnosticReport(input: {
  snapshot: AppSnapshot; launcherVersion: string; systemInfo: string;
  backendLog: () => Promise<DiagnosticLog>; logsRoot: string; gameId?: string;
  privateValues?: string[];
}): Promise<DiagnosticReport> {
  const { snapshot: data } = input;
  const lines = ['Nexus Launcher diagnostic report', `Created: ${new Date().toISOString()}`,
    'Automatic redaction is best effort. Review this report before sharing.',
    'Logs are bounded snapshots, not complete files. Prefixes, game files and saves are not read.',
    '', '## Versions', `Launcher: ${clean(input.launcherVersion)}`,
    `Backend: ${clean(data.backend.version)}; available: ${data.backend.available}; source: ${clean(data.backend.source)}`,
    `Backend commit: ${clean(data.backend.commit)}; compatibility: ${clean(data.backend.linuxRunPatch)}`,
    `Runtime: ${clean(data.runtime.name)}; installed: ${data.runtime.installed}; commit: ${clean(data.runtime.commit)}`,
    '', '## System', input.systemInfo, '', '## Download settings',
    `Parallel downloads: ${data.settings.parallelDownloads}; limit: ${data.settings.downloadLimitMiB ?? 0} MiB/s; market: ${clean(data.settings.market)}`];
  async function appendLog(label: string, read: () => Promise<DiagnosticLog>) {
    lines.push('', `## ${label}`);
    try {
      const log = await read();
      const truncated = log.truncated || Buffer.byteLength(log.content) > LOG_LIMIT;
      lines.push(truncated ? '[TRUNCATED: most recent log tail only]' : '[Complete available snapshot]', log.content.slice(-LOG_LIMIT) || '[Empty log]');
    } catch { lines.push('[Log missing, changed or unavailable for safe reading]'); }
  }
  await appendLog('Backend log', input.backendLog);
  const tasks = data.downloads.slice(0, 5);
  for (const [index, task] of tasks.entries()) {
    const log = task.log.slice(-200).map(line => line.slice(-8192)).join('\n');
    lines.push('', `## Download ${index + 1}: ${clean(task.title)}`,
      `Product: ${clean(task.productId)}; kind: ${clean(task.kind ?? 'install')}; status: ${clean(task.status)}; exit: ${task.exitCode ?? 'unavailable'}`,
      `Phase: ${clean(task.phase)}`, `Error: ${task.error?.slice(-4096) ?? 'none recorded'}`, 'Only the most recent stored output is available.', log.slice(-64 * 1024) || '[No download output]');
  }
  if (!tasks.length) lines.push('', '## Downloads', '[No stored download logs]');
  if (input.gameId !== undefined) {
    const game = data.games.find(game => game.id === input.gameId);
    if (!game || !/^[a-f0-9]{16}$/.test(game.id)) throw Error('Game not found for diagnostics.');
    lines.push('', '## Selected game', `Title: ${clean(game.title)}; product: ${clean(game.storeId)}; version: ${clean(game.installedVersion)}; state: ${clean(game.installState)}`);
    for (const [suffix, label] of [['latest', 'Game log'], ['vc-runtime', 'Prerequisite log']]) {
      await appendLog(label, () => reportLog(path.join(input.logsRoot, `${game.id}-${suffix}.log`), input.logsRoot));
    }
  } else lines.push('', '## Game logs', '[No game selected]');
  const privateValues = [...(input.privateValues ?? []), data.auth.username ?? '', data.auth.gamertag ?? ''];
  const content = redactDiagnosticText(lines.join('\n') + '\n', privateValues);
  validateReportContent(content);
  return { name: `nexus-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`, content };
}

export function validateReportContent(content: unknown): asserts content is string {
  if (typeof content !== 'string' || !content.trim() || content.includes('\0') || Buffer.byteLength(content) > REPORT_LIMIT) throw Error('Invalid or oversized diagnostic report.');
}

export async function saveDiagnosticReport(file: string, content: unknown): Promise<void> {
  validateReportContent(content);
  if (!path.isAbsolute(file) || !file.toLowerCase().endsWith('.txt')) throw Error('Choose a new .txt file for the report.');
  // No automatic upload, arbitrary path reads, symlink following or overwrites.
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(content, 'utf8'); }
  finally { await handle.close(); }
}
