import { describe, expect, it } from 'vitest';
import {
  encodeFrame, filterClientEnvironment, FrameReader, MAX_ENV_BYTES, MAX_FRAME_BYTES, parseClientFrame, parseDaemonFrame, ProtocolError,
  type ClientFrame, type DaemonFrame,
} from './daemon-protocol.js';

const state = { session: { warm: true, startedAt: '2026-10-25T00:00:00.000Z' }, connectivity: { state: 'online' as const } };

describe('daemon protocol frames', () => {
  it('round-trips every client frame', () => {
    const frames: ClientFrame[] = [
      { schema: 1, type: 'hello', client: 'steam', version: '0.3.12' },
      { schema: 1, type: 'launch', requestId: 'req-1', gameId: '0123456789abcdef', env: { DISPLAY: ':0', SteamGameId: '123' }, cwd: '/home/deck', attach: true },
      { schema: 1, type: 'launch', requestId: 'r', gameId: 'ffffffffffffffff', env: {}, attach: false },
      { schema: 1, type: 'launch', requestId: 'r', gameId: 'ffffffffffffffff', env: {}, attach: true, steamCommand: ['/steam/proton', 'waitforexitandrun', '/bin/sh'] },
      { schema: 1, type: 'attach', operationId: 'game-0123456789abcdef' },
      { schema: 1, type: 'cancel', requestId: 'req_2' },
      { schema: 1, type: 'subscribe' },
      { schema: 1, type: 'reload' },
      { schema: 1, type: 'ping' },
    ];
    for (const frame of frames) expect(parseClientFrame(encodeFrame(frame).trimEnd())).toEqual(frame);
  });

  it('round-trips every daemon frame', () => {
    const frames: DaemonFrame[] = [
      { schema: 1, type: 'hello', daemonVersion: '0.3.12', profileId: 'abc123def456', state },
      { schema: 1, type: 'accepted', requestId: 'req-1', operationId: 'game-0123456789abcdef' },
      { schema: 1, type: 'error', requestId: 'req-1', code: 'busy', message: 'Another game is running.' },
      { schema: 1, type: 'error', code: 'internal', message: 'boom' },
      { schema: 1, type: 'state', state: { ...state, gameOperation: { id: 'game-1', gameId: '1', title: 'T', status: 'running', phase: 'p', log: [], startedAt: 'now' } } },
      { schema: 1, type: 'log', operationId: 'game-1', line: 'Proton prefix ready' },
      { schema: 1, type: 'exit', operationId: 'game-1', code: 0, status: 'complete' },
      { schema: 1, type: 'exit', operationId: 'game-1', code: null, status: 'failed' },
      { schema: 1, type: 'pong' },
    ];
    for (const frame of frames) expect(parseDaemonFrame(encodeFrame(frame).trimEnd())).toEqual(frame);
  });

  it('rejects a Steam command that is empty, too long or carries control characters', () => {
    const launch = (steamCommand: unknown) => JSON.stringify({ schema: 1, type: 'launch', requestId: 'r', gameId: 'ffffffffffffffff', env: {}, attach: true, steamCommand });
    for (const bad of [[], 'proton', [''], ['a\nb'], [1], Array(65).fill('x')]) expect(() => parseClientFrame(launch(bad))).toThrow(ProtocolError);
  });

  it('rejects malformed frames with a ProtocolError and nothing else', () => {
    const bad = [
      'not json', '[]', 'null', '{"type":"ping"}', '{"schema":2,"type":"ping"}', '{"schema":1,"type":"dance"}',
      '{"schema":1,"type":"hello","client":"browser","version":"1"}',
      '{"schema":1,"type":"launch","requestId":"r","gameId":"ABCDEF0123456789","env":{},"attach":true}',
      '{"schema":1,"type":"launch","requestId":"r","gameId":"0123456789abcdef","env":{},"attach":"yes"}',
      '{"schema":1,"type":"launch","requestId":"r","gameId":"0123456789abcdef","env":{"1BAD":"x"},"attach":true}',
      '{"schema":1,"type":"launch","requestId":"r","gameId":"0123456789abcdef","env":{"A":"x\\u0000y"},"attach":true}',
      '{"schema":1,"type":"launch","requestId":"r","gameId":"0123456789abcdef","env":[],"attach":true}',
      '{"schema":1,"type":"cancel","requestId":"has space"}',
      '{"schema":1,"type":"attach","operationId":"' + 'x'.repeat(65) + '"}',
    ];
    for (const line of bad) {
      let error: unknown;
      try { parseClientFrame(line); } catch (caught) { error = caught; }
      expect(error, line).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe('schema');
    }
    const badDaemon = [
      '{"schema":1,"type":"error","code":"teapot","message":"m"}',
      '{"schema":1,"type":"exit","operationId":"g","code":1.5,"status":"complete"}',
      '{"schema":1,"type":"exit","operationId":"g","code":1,"status":"done"}',
      '{"schema":1,"type":"state","state":{}}',
      '{"schema":1,"type":"hello","daemonVersion":"1","profileId":"p","state":{"session":{}}}',
    ];
    for (const line of badDaemon) expect(() => parseDaemonFrame(line), line).toThrow(ProtocolError);
  });

  it('caps the forwarded environment and the frame size', () => {
    const env: Record<string, string> = {};
    for (let i = 0; env[`K${i}`] === undefined && i < 40; i++) env[`K${i}`] = 'v'.repeat(8192);
    const launch = `{"schema":1,"type":"launch","requestId":"r","gameId":"0123456789abcdef","env":${JSON.stringify(env)},"attach":true}`;
    expect(Buffer.byteLength(JSON.stringify(env))).toBeGreaterThan(MAX_ENV_BYTES);
    expect(() => parseClientFrame(launch)).toThrow('Environment is too large.');
    expect(() => encodeFrame({ schema: 1, type: 'log', operationId: 'g', line: 'x'.repeat(MAX_FRAME_BYTES) })).toThrow('Frame is too large.');
  });
});

describe('filterClientEnvironment', () => {
  it('drops launcher-private variables, keeps Steam ones and restores the overlay preload', () => {
    const filtered = filterClientEnvironment({
      ELECTRON_RUN_AS_NODE: '1', APPIMAGE: '/x.AppImage', APPDIR: '/tmp/.mount_x', ARGV0: 'x', OWD: '/', XODUS_SMOKE_SCREENSHOT: '1',
      XODUS_NEXUS_FONTCONFIG: '/f', XODUS_NEXUS_STEAM_LD_PRELOAD: '/steam/gameoverlayrenderer.so', VITE_DEV_SERVER_URL: 'http://x', XODUS_DEMO: '1', XODUS_DEMO_TOUR: '1',
      LD_PRELOAD: '', SteamGameId: '123', SteamOverlayGameId: '123', SteamAppId: '0', DISPLAY: ':1', WAYLAND_DISPLAY: 'gamescope-0',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', XDG_RUNTIME_DIR: '/run/user/1000', XDG_CURRENT_DESKTOP: 'gamescope',
      XODUS_FORCE_OFFLINE: '1', BAD: 'a\u0001b', 'weird-key': 'x', UNDEFINED: undefined,
    });
    expect(filtered).toEqual({
      LD_PRELOAD: '/steam/gameoverlayrenderer.so', SteamGameId: '123', SteamOverlayGameId: '123', SteamAppId: '0', DISPLAY: ':1', WAYLAND_DISPLAY: 'gamescope-0',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', XDG_RUNTIME_DIR: '/run/user/1000', XDG_CURRENT_DESKTOP: 'gamescope', XODUS_FORCE_OFFLINE: '1',
    });
  });

  it('leaves LD_PRELOAD alone when Steam did not set one', () => {
    expect(filterClientEnvironment({ LD_PRELOAD: '/other.so' })).toEqual({ LD_PRELOAD: '/other.so' });
    expect(filterClientEnvironment({ LD_PRELOAD: '/other.so', XODUS_NEXUS_STEAM_LD_PRELOAD: '' })).toEqual({ LD_PRELOAD: '/other.so' });
    expect(filterClientEnvironment({ PATH: '/usr/bin', TAB: 'a\tb' })).toEqual({ PATH: '/usr/bin', TAB: 'a\tb' });
  });
});

describe('FrameReader', () => {
  it('splits chunks mid-line, handles CRLF and multi-byte characters', () => {
    const reader = new FrameReader();
    const text = '{"a":"héllo"}\r\n{"b":2}\n{"c":';
    const bytes = Buffer.from(text);
    const lines = [...reader.push(bytes.subarray(0, 5)), ...reader.push(bytes.subarray(5, 20)), ...reader.push(bytes.subarray(20))];
    expect(lines).toEqual(['{"a":"héllo"}', '{"b":2}']);
    expect(reader.push(Buffer.from('3}\n\n'))).toEqual(['{"c":3}']);
  });

  it('enforces the frame cap and rejects invalid UTF-8', () => {
    const reader = new FrameReader();
    expect(() => reader.push(Buffer.alloc(MAX_FRAME_BYTES + 1, 0x61))).toThrow('Frame is too large.');
    expect(reader.push(Buffer.from('{"ok":1}\n'))).toEqual(['{"ok":1}']);
    expect(() => reader.push(Buffer.from([0xff, 0xfe, 0x0a]))).toThrow('Frame is not UTF-8.');
  });
});
