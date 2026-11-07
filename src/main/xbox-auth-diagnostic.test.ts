import { expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { xboxAuthDiagnostic } from './xbox-auth-diagnostic.js';
import { BackendDiagnosticReader, BackendDiagnostics } from './backend-diagnostics.js';

const frame = 'NEXUS_XBOX_AUTH_DIAGNOSTIC_V1 xbox-xsts-http 401 8015DC09';

it('accepts fixed Xbox stage/status/code combinations, never arbitrary provider text (#382)', () => {
  expect(xboxAuthDiagnostic(frame)).toEqual({ stage: 'xbox-xsts-http', status: 401, serviceCode: '8015DC09' });
  expect(xboxAuthDiagnostic('NEXUS_XBOX_AUTH_DIAGNOSTIC_V1 xbox-user-connect 0 00000000'))
    .toEqual({ stage: 'xbox-user-connect', status: undefined, serviceCode: undefined });
  expect(xboxAuthDiagnostic('NEXUS_XBOX_AUTH_DIAGNOSTIC_V1 xbox-user-response 200 00000000'))
    .toEqual({ stage: 'xbox-user-response', status: 200, serviceCode: undefined });
  for (const text of [frame + ' PRIVATE_TOKEN', 'prefix ' + frame, frame.replace('8015DC09', '8015dc09'),
    frame.replace('401', '200'), frame.replace('xbox-xsts', 'private-user'), frame.replace('401', '999'),
    frame.replace('http 401', 'connect 0'), frame.replace('http 401', 'response 401'),
    frame.replace('http 401', 'request 401'), frame.replace('8015DC09', 'private@example.test')]) expect(xboxAuthDiagnostic(text)).toBeUndefined();
});

it('persists only bounded auth metadata from profile and download stderr, never payloads (#382)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-xbox-auth-diagnostic-'));
  try {
    const log = new BackendDiagnostics(root);
    for (const operation of ['profile', 'streaming', 'download']) {
      const reader = new BackendDiagnosticReader(operation, value => log.record(value));
      for (const byte of Buffer.from(frame + '\r\nPRIVATE_TOKEN\n' + frame + ' PRIVATE_TOKEN\n')) reader.push(Buffer.from([byte]));
    }
    new BackendDiagnosticReader('probe', value => log.record(value)).push(Buffer.from(frame + '\n'));
    const { content } = await log.read();
    const rows = content.trim().split('\n').map(line => JSON.parse(line));
    expect(rows).toHaveLength(3);
    expect(rows.every(row => row.stage === 'xbox-xsts-http' && row.status === 401 && row.serviceCode === '8015DC09')).toBe(true);
    expect(content).not.toContain('PRIVATE_TOKEN');
    expect(rows.map(row => row.operation)).toEqual(['profile', 'streaming', 'download']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
