// Policy for the nexus-close-window helper: it matches windows only through
// the launch id in the owning process's environment, closes them with the
// ICCCM WM_DELETE_WINDOW protocol, and never spawns a process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./nexus-close-window.c', import.meta.url), 'utf8');
const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const code = stripComments(source);

test('never spawns a process', () => {
  assert.doesNotMatch(code, /\bsystem\s*\(/);
  assert.doesNotMatch(code, /\bpopen\s*\(/);
  assert.doesNotMatch(code, /\b(?:f?exec(?:l|lp|le|v|vp|vpe|ve)?|execveat|posix_spawnp?|fork|vfork|clone)\s*\(/);
  assert.doesNotMatch(code, /#include\s*<spawn\.h>/);
});

test('matches only on the launch id in /proc environ', () => {
  assert.match(code, /"XODUS_NEXUS_LAUNCH_ID="/);
  assert.match(code, /\/proc\/%ld\/%s/);
  assert.match(code, /"environ"/);
  assert.match(code, /"stat"/);
  // Window title and executable name are not inputs to the match.
  for (const forbidden of ['_NET_WM_NAME', 'WM_NAME', 'WM_CLASS', 'XFetchName', 'XGetWMName', '/exe', '/cmdline', '/comm'])
    assert.ok(!code.includes(forbidden), `must not use ${forbidden}`);
});

test('reads _NET_CLIENT_LIST and _NET_WM_PID and sends WM_DELETE_WINDOW', () => {
  assert.match(code, /"_NET_CLIENT_LIST"/);
  assert.match(code, /"_NET_WM_PID"/);
  assert.match(code, /"WM_PROTOCOLS"/);
  assert.match(code, /"WM_DELETE_WINDOW"/);
  assert.match(code, /XSendEvent\(display, window, False, NoEventMask, &event\)/);
  assert.match(code, /event\.xclient\.format = 32;/);
  assert.match(code, /event\.xclient\.data\.l\[1\] = CurrentTime;/);
});

test('bounds /proc reads and ignores other users\' processes', () => {
  assert.match(code, /O_RDONLY \| O_CLOEXEC \| O_NOFOLLOW/);
  assert.match(code, /st\.st_uid != getuid\(\)/);
  assert.match(code, /st\.st_uid == getuid\(\)/);
  assert.match(code, /#define MAX_ANCESTORS 32/);
  assert.match(code, /#define RESCAN_INTERVAL_MS 250/);
  assert.match(code, /#define MAX_LAUNCH_ID 256/);
  // No unbounded string functions on /proc data.
  for (const forbidden of ['strcpy(', 'strcat(', 'sprintf(', 'gets(', 'scanf("'])
    assert.ok(!code.includes(forbidden), `must not use ${forbidden}`);
  assert.doesNotMatch(code, /\bmalloc\s*\(|\brealloc\s*\(/);
});

test('is Xlib only', () => {
  const includes = [...code.matchAll(/#include\s*<([^>]+)>/g)].map(match => match[1]);
  assert.deepEqual(includes.filter(name => name.startsWith('X11/')).sort(), ['X11/Xatom.h', 'X11/Xlib.h']);
  assert.ok(!includes.some(name => /^(gtk|gdk|X11\/Intrinsic|X11\/StringDefs|Xm\/)/.test(name)));
  assert.match(code, /#define _POSIX_C_SOURCE 200809L/);
});
