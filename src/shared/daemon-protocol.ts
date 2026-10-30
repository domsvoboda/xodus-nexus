import type { ConnectivityStatus, Game, GameOperation } from './types.js';
import type { GameInviteState } from './game-invites.js';

/**
 * Wire protocol between the Nexus background daemon and its clients (the thin
 * Steam client and the Electron launcher): newline-delimited JSON over a Unix
 * socket, one object per line, every frame `{ schema: 1, type, ... }`.
 */
export const PROTOCOL_SCHEMA = 1;
export const MAX_FRAME_BYTES = 1_048_576;
export const MAX_ENV_BYTES = 262_144;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const GAME_ID = /^[0-9a-f]{16}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Tab is the only control character a value may carry.
const CONTROL = /[\0-\x08\x0a-\x1f\x7f]/;
const MAX_TEXT = 4096;

export class ProtocolError extends Error {
  readonly code = 'schema' as const;
  constructor(message: string) { super(message); this.name = 'ProtocolError'; }
}

export type ClientKind = 'steam' | 'electron';
export type DaemonErrorCode = 'busy' | 'wallet-locked' | 'backend-unavailable' | 'game-not-found' | 'schema' | 'internal';
/** What the launcher's Friends UI does with the daemon game's invitation bridge (`GameInviteBridge`). */
export type InviteAction = 'choose' | 'cancel' | 'accept' | 'friend';
const INVITE_ACTIONS: InviteAction[] = ['choose', 'cancel', 'accept', 'friend'];

export interface SessionState { warm: boolean; startedAt?: string; lastCheckAt?: string; error?: string }
export interface DaemonState {
  gameOperation?: GameOperation;
  inspected?: { gameId: string; patch: Partial<Game> };
  session: SessionState;
  connectivity?: ConnectivityStatus;
  /** The running game's invitations, for the launcher's Friends UI. */
  invites?: GameInviteState;
}

export type ClientFrame =
  | { schema: 1; type: 'hello'; client: ClientKind; version: string }
  | { schema: 1; type: 'launch'; requestId: string; gameId: string; env: Record<string, string>; cwd?: string; attach: boolean }
  | { schema: 1; type: 'attach'; operationId: string }
  | { schema: 1; type: 'cancel'; requestId: string }
  | { schema: 1; type: 'subscribe' }
  | { schema: 1; type: 'reload' }
  | { schema: 1; type: 'invite'; requestId: string; action: InviteAction; id: string; xuid?: string }
  | { schema: 1; type: 'ping' };

export type DaemonFrame =
  | { schema: 1; type: 'hello'; daemonVersion: string; profileId: string; state: DaemonState }
  | { schema: 1; type: 'accepted'; requestId: string; operationId: string }
  | { schema: 1; type: 'error'; requestId?: string; code: DaemonErrorCode; message: string }
  | { schema: 1; type: 'state'; state: DaemonState }
  | { schema: 1; type: 'log'; operationId: string; line: string }
  | { schema: 1; type: 'exit'; operationId: string; code: number | null; status: 'complete' | 'failed'; message?: string }
  | { schema: 1; type: 'done'; requestId: string }
  /** The game asks for a friend to invite (`choose`) or received an invitation: the launcher shows it. */
  | { schema: 1; type: 'invite-notice'; notice: 'choose' | 'invitation'; game: string; sender?: string }
  | { schema: 1; type: 'pong' };

type Dict = Record<string, unknown>;

function object(value: unknown): Dict {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError('Frame is not an object.');
  const frame = value as Dict;
  if (frame.schema !== PROTOCOL_SCHEMA) throw new ProtocolError('Unsupported protocol schema.');
  if (typeof frame.type !== 'string') throw new ProtocolError('Frame has no type.');
  return frame;
}

function text(frame: Dict, key: string, pattern?: RegExp, optional = false): string {
  const value = frame[key];
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT || CONTROL.test(value)) throw new ProtocolError(`Invalid ${key}.`);
  if (pattern && !pattern.test(value)) throw new ProtocolError(`Invalid ${key}.`);
  return value;
}

function boolean(frame: Dict, key: string): boolean {
  if (typeof frame[key] !== 'boolean') throw new ProtocolError(`Invalid ${key}.`);
  return frame[key] as boolean;
}

function environment(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError('Invalid env.');
  const env: Record<string, string> = {};
  let bytes = 0;
  for (const [key, entry] of Object.entries(value as Dict)) {
    if (!ENV_KEY.test(key) || typeof entry !== 'string' || CONTROL.test(entry)) throw new ProtocolError('Invalid env.');
    bytes += Buffer.byteLength(key) + Buffer.byteLength(entry) + 2;
    if (bytes > MAX_ENV_BYTES) throw new ProtocolError('Environment is too large.');
    env[key] = entry;
  }
  return env;
}

function parse(line: string): unknown {
  if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new ProtocolError('Frame is too large.');
  try { return JSON.parse(line); }
  catch { throw new ProtocolError('Frame is not JSON.'); }
}

export function parseClientFrame(line: string): ClientFrame {
  const frame = object(parse(line));
  switch (frame.type) {
    case 'hello': {
      const client = text(frame, 'client');
      if (client !== 'steam' && client !== 'electron') throw new ProtocolError('Invalid client.');
      return { schema: 1, type: 'hello', client, version: text(frame, 'version') };
    }
    case 'launch': {
      const cwd = text(frame, 'cwd', undefined, true);
      return {
        schema: 1, type: 'launch', requestId: text(frame, 'requestId', ID), gameId: text(frame, 'gameId', GAME_ID),
        env: environment(frame.env), attach: boolean(frame, 'attach'), ...(cwd ? { cwd } : {}),
      };
    }
    case 'attach': return { schema: 1, type: 'attach', operationId: text(frame, 'operationId', ID) };
    case 'cancel': return { schema: 1, type: 'cancel', requestId: text(frame, 'requestId', ID) };
    case 'subscribe': case 'reload': case 'ping': return { schema: 1, type: frame.type };
    case 'invite': {
      const action = text(frame, 'action');
      if (!INVITE_ACTIONS.includes(action as InviteAction)) throw new ProtocolError('Invalid action.');
      const id = text(frame, 'id');
      if (id.length > 160) throw new ProtocolError('Invalid id.');
      const xuid = text(frame, 'xuid', /^\d{1,20}$/, true);
      return { schema: 1, type: 'invite', requestId: text(frame, 'requestId', ID), action: action as InviteAction, id, ...(xuid ? { xuid } : {}) };
    }
    default: throw new ProtocolError('Unknown frame type.');
  }
}

const ERROR_CODES: DaemonErrorCode[] = ['busy', 'wallet-locked', 'backend-unavailable', 'game-not-found', 'schema', 'internal'];

function state(value: unknown): DaemonState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError('Invalid state.');
  const given = value as Dict;
  const session = given.session;
  if (!session || typeof session !== 'object' || typeof (session as Dict).warm !== 'boolean') throw new ProtocolError('Invalid state.');
  const invites = given.invites as Dict | undefined;
  if (invites !== undefined && (!invites || typeof invites !== 'object' || !['active', 'outgoing', 'incoming'].every(key => Array.isArray(invites[key])))) throw new ProtocolError('Invalid state.');
  return given as unknown as DaemonState;
}

export function parseDaemonFrame(line: string): DaemonFrame {
  const frame = object(parse(line));
  switch (frame.type) {
    case 'hello': return { schema: 1, type: 'hello', daemonVersion: text(frame, 'daemonVersion'), profileId: text(frame, 'profileId', ID), state: state(frame.state) };
    case 'accepted': return { schema: 1, type: 'accepted', requestId: text(frame, 'requestId', ID), operationId: text(frame, 'operationId', ID) };
    case 'error': {
      const code = text(frame, 'code');
      if (!ERROR_CODES.includes(code as DaemonErrorCode)) throw new ProtocolError('Invalid error code.');
      const requestId = text(frame, 'requestId', ID, true);
      return { schema: 1, type: 'error', code: code as DaemonErrorCode, message: text(frame, 'message'), ...(requestId ? { requestId } : {}) };
    }
    case 'state': return { schema: 1, type: 'state', state: state(frame.state) };
    case 'log': return { schema: 1, type: 'log', operationId: text(frame, 'operationId', ID), line: typeof frame.line === 'string' && frame.line.length <= MAX_TEXT ? frame.line : (() => { throw new ProtocolError('Invalid line.'); })() };
    case 'exit': {
      const code = frame.code;
      if (code !== null && (typeof code !== 'number' || !Number.isInteger(code))) throw new ProtocolError('Invalid code.');
      const status = text(frame, 'status');
      if (status !== 'complete' && status !== 'failed') throw new ProtocolError('Invalid status.');
      const message = text(frame, 'message', undefined, true);
      return { schema: 1, type: 'exit', operationId: text(frame, 'operationId', ID), code: code as number | null, status, ...(message ? { message } : {}) };
    }
    case 'done': return { schema: 1, type: 'done', requestId: text(frame, 'requestId', ID) };
    case 'invite-notice': {
      const notice = text(frame, 'notice');
      if (notice !== 'choose' && notice !== 'invitation') throw new ProtocolError('Invalid notice.');
      const sender = text(frame, 'sender', undefined, true);
      return { schema: 1, type: 'invite-notice', notice, game: text(frame, 'game'), ...(sender ? { sender } : {}) };
    }
    case 'pong': return { schema: 1, type: 'pong' };
    default: throw new ProtocolError('Unknown frame type.');
  }
}

export function encodeFrame(frame: ClientFrame | DaemonFrame): string {
  const line = JSON.stringify(frame) + '\n';
  if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new ProtocolError('Frame is too large.');
  return line;
}

const DROPPED_KEYS = new Set(['ELECTRON_RUN_AS_NODE', 'APPIMAGE', 'APPDIR', 'ARGV0', 'OWD', 'XODUS_SMOKE_SCREENSHOT']);
const DROPPED_PREFIXES = ['XODUS_NEXUS_', 'VITE_', 'XODUS_DEMO'];

/**
 * The environment a Steam client forwards for its game. Launcher-private and
 * AppImage variables go; Steam's own (overlay, app ids, display) stay. The
 * launcher wrapper strips the overlay from `LD_PRELOAD`, so the shortcut
 * script preserves Steam's original in `XODUS_NEXUS_STEAM_LD_PRELOAD`.
 */
export function filterClientEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !ENV_KEY.test(key) || CONTROL.test(value)) continue;
    if (DROPPED_KEYS.has(key) || DROPPED_PREFIXES.some(prefix => key.startsWith(prefix))) continue;
    result[key] = value;
  }
  const preload = env.XODUS_NEXUS_STEAM_LD_PRELOAD;
  if (preload && !CONTROL.test(preload)) result.LD_PRELOAD = preload;
  return result;
}

/** Splits a byte stream into complete lines, enforcing the frame cap. */
export class FrameReader {
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 0x0a) continue;
      const part = chunk.subarray(start, i);
      start = i + 1;
      lines.push(this.complete(part));
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      this.pendingBytes += rest.length;
      if (this.pendingBytes > MAX_FRAME_BYTES) { this.pending = []; this.pendingBytes = 0; throw new ProtocolError('Frame is too large.'); }
      this.pending.push(Buffer.from(rest));
    }
    return lines.filter(line => line.length > 0);
  }

  private complete(part: Buffer): string {
    const bytes = this.pending.length ? Buffer.concat([...this.pending, part]) : part;
    this.pending = [];
    this.pendingBytes = 0;
    if (bytes.length > MAX_FRAME_BYTES) throw new ProtocolError('Frame is too large.');
    const decoded = new TextDecoder('utf-8', { fatal: true });
    let line: string;
    try { line = decoded.decode(bytes); }
    catch { throw new ProtocolError('Frame is not UTF-8.'); }
    return line.endsWith('\r') ? line.slice(0, -1) : line;
  }
}
