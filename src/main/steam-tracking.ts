import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseSteamCommand, wrapperPrefix } from './steam-compat.js';

const TRACKED = 'XODUS_NEXUS_STEAM_TRACKED';

/**
 * Steam starts the shortcut script with `%command%` after the game id, but
 * runs only the script: its tracking (`reaper SteamLaunch AppId=…`) is in that
 * command, and Steam's Exit signals the reaper. So the first run starts the
 * script again inside the wrappers and the tracking, with Steam's original
 * LD_PRELOAD; the second run gets the command without the tracking.
 * Undefined: no re-run.
 */
export function steamTrackingRerun(steamCommand: string[] | undefined, env: NodeJS.ProcessEnv, entry: string, gameId: string):
  { words: string[]; env: NodeJS.ProcessEnv } | undefined {
  if (env[TRACKED] === '1' || !steamCommand?.length) return undefined;
  const parts = parseSteamCommand(steamCommand);
  if (!parts.tracking.length) return undefined;
  const placeholder = steamCommand.at(-1)!;
  const next: NodeJS.ProcessEnv = { ...env, [TRACKED]: '1' };
  const preload = env.XODUS_NEXUS_STEAM_LD_PRELOAD ?? env.LD_PRELOAD;
  if (preload) next.LD_PRELOAD = preload; else delete next.LD_PRELOAD;
  return {
    words: [...wrapperPrefix(parts.wrappers), ...parts.tracking, '/bin/sh', entry, gameId, ...parts.wrappers, ...parts.tool, placeholder],
    env: next,
  };
}

/** Every live descendant of `root`, deepest first, from /proc. */
export async function descendants(root: number, proc = '/proc'): Promise<number[]> {
  const parents = new Map<number, number[]>();
  for (const name of await fs.readdir(proc).catch(() => [] as string[])) {
    if (!/^\d+$/.test(name)) continue;
    const stat = await fs.readFile(path.join(proc, name, 'stat'), 'utf8').catch(() => '');
    // The parent pid is the second field after the parenthesized command name.
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    if (Number.isInteger(ppid)) parents.set(ppid, [...(parents.get(ppid) ?? []), Number(name)]);
  }
  const found: number[] = [];
  const visit = (pid: number) => { for (const child of parents.get(pid) ?? []) { visit(child); found.push(child); } };
  visit(root);
  return found;
}

/**
 * Runs `words` with this process's stdio and returns its exit code. Steam may
 * stop only this process (its direct child); the signal goes to the whole
 * subtree, because wrappers such as pw-audio-namespace do not pass it on.
 */
export function runUnder(words: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(words[0], words.slice(1), { stdio: 'inherit', env });
    const forward = (signal: NodeJS.Signals) => () => {
      void descendants(child.pid ?? -1).then(pids => {
        for (const pid of [...pids, child.pid ?? -1]) { try { process.kill(pid, signal); } catch { /* Already gone. */ } }
      });
    };
    const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(signal => [signal, forward(signal)] as const);
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const done = () => { for (const [signal, handler] of handlers) process.off(signal, handler); };
    child.once('error', error => { done(); reject(error); });
    child.once('exit', (code, signal) => { done(); resolve(code ?? (signal ? 1 : 0)); });
  });
}
