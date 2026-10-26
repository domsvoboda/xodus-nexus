import { expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BackendDiagnostics, BackendDiagnosticReader, observeBackendChild, setBackendDiagnostics } from './backend-diagnostics.js';
import { spawnTracked } from './process.js';

it('records social HTTP status and fixed failure stages without friends, message bodies or tokens',()=>{
  const records:unknown[]=[];const reader=new BackendDiagnosticReader('social',r=>records.push(r));
  reader.push(Buffer.from('NEXUS_SOCIAL_DIAGNOSTIC_V1 conversation-http 200\nNEXUS_SOCIAL_ERROR_V1 conversation-response\n'));
  reader.push(Buffer.from('NEXUS_SOCIAL_ERROR_V1 private-peer\nNEXUS_SOCIAL_DIAGNOSTIC_V1 conversation-http 200 private-token\nPRIVATE MESSAGE\n'));
  expect(records).toEqual([{operation:'social',event:'diagnostic',stage:'conversation-http',status:200,skipped:undefined,serviceCode:undefined},
    {operation:'social',event:'diagnostic',stage:'conversation-response',status:undefined,skipped:undefined,serviceCode:undefined}]);
  const wrong:unknown[]=[];new BackendDiagnosticReader('run',r=>wrong.push(r)).push(Buffer.from('NEXUS_SOCIAL_ERROR_V1 conversation-response\n'));expect(wrong).toEqual([]);
});

it('retains bounded outgoing-session stages without credentials, app IDs or policy payloads',()=>{
  const frames=['chat-policy-http','chat-device-http','chat-context-http','chat-xsts-http'];
  const failures=['chat-ticket-lifetime','chat-token-expired','chat-request-signature','chat-policy-audience','chat-privacy-request'];
  const records:unknown[]=[];
  const reader=new BackendDiagnosticReader('social',r=>records.push(r));
  for(const byte of Buffer.from(frames.map(stage=>'NEXUS_SOCIAL_DIAGNOSTIC_V1 '+stage+' 200\r\n').join('')+
    failures.map(stage=>'NEXUS_SOCIAL_ERROR_V1 '+stage+'\n').join('')))reader.push(Buffer.from([byte]));
  expect(records).toHaveLength(frames.length+failures.length);
  for(const frame of ['NEXUS_SOCIAL_DIAGNOSTIC_V1 chat-context-http 200 PRIVATE_TOKEN',
    'NEXUS_SOCIAL_ERROR_V1 chat-secret-private','NEXUS_SOCIAL_DIAGNOSTIC_V1 chat-xsts-http 999'])reader.push(Buffer.from(frame+'\n'));
  expect(records).toHaveLength(frames.length+failures.length);expect(JSON.stringify(records)).not.toContain('PRIVATE_TOKEN');
  const wrong:unknown[]=[];
  new BackendDiagnosticReader('run',r=>wrong.push(r)).push(Buffer.from('NEXUS_SOCIAL_DIAGNOSTIC_V1 chat-context-http 200\nNEXUS_SOCIAL_ERROR_V1 chat-token-expired\n'));
  expect(wrong).toEqual([]);
});

it('records a fixed loader category without exposing the local binary path or missing library text (#328)',()=>{
  const records:unknown[]=[];const reader=new BackendDiagnosticReader('probe',r=>records.push(r));
  const lines=[
    '/private/user/xodus-cli: error while loading shared libraries: libssl.so.3: cannot open shared object file: No such file or directory',
    '/private/user/xodus-cli: error while loading shared libraries: libdbus-1.so.3: cannot open shared object file: No such file or directory',
    "/private/user/xodus-cli: /lib/libc.so.6: version `GLIBC_2.38' not found (required by /private/user/xodus-cli)",
  ];
  for(const byte of Buffer.from(lines.join('\n')+'\n'))reader.push(Buffer.from([byte]));
  expect(records.map((v:any)=>v.stage)).toEqual(['loader-openssl','loader-dbus','loader-glibc']);
  expect(JSON.stringify(records)).not.toMatch(/private|libssl|libdbus|GLIBC_2/);
});

it('accepts only fixed receipt shape flags, never message IDs, payloads or raw error text',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-receipt-diagnostic-'));
  try{
    const log=new BackendDiagnostics(root),records:unknown[]=[];
    const reader=new BackendDiagnosticReader('social',value=>{records.push(value);log.record(value);});
    reader.push(Buffer.from('NEXUS_SOCIAL_RECEIPT_V1 1 1 2 0\n'));
    for(const frame of ['1 1 4 0','1 1 true 0','1 1 2 0 PRIVATE_TOKEN','private-id 1 0 0'])
      reader.push(Buffer.from('NEXUS_SOCIAL_RECEIPT_V1 '+frame+'\n'));
    new BackendDiagnosticReader('run',value=>records.push(value)).push(Buffer.from('NEXUS_SOCIAL_RECEIPT_V1 1 1 2 0\n'));
    expect(records).toEqual([{operation:'social',event:'diagnostic',stage:'send-receipt',socialReceipt:{hasMessageId:true,hasConversationId:true,nudge:'true',hasError:false}}]);
    log.record({operation:'social',event:'diagnostic',stage:'send-receipt',socialReceipt:{hasMessageId:true,hasConversationId:true,nudge:'false',hasError:false,secret:'PRIVATE_TOKEN'} as never});
    const {content}=await log.read();expect(content).not.toContain('PRIVATE_TOKEN');
    expect(content.trim().split('\n').map(s=>JSON.parse(s).socialReceipt)).toEqual([
      {hasMessageId:true,hasConversationId:true,nudge:'true',hasError:false},
      {hasMessageId:true,hasConversationId:true,nudge:'false',hasError:false}]);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

it('records only fixed keyring failure metadata, never collection paths or provider text (#329)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-keyring-diagnostic-'));
  try {
    const log = new BackendDiagnostics(root);
    log.record({operation:'keyring',event:'diagnostic',elapsedMs:2042,keyring:{step:'ReadAlias',failure:'timeout',dbusError:'org.freedesktop.DBus.Error.NoReply',elapsedMs:2042}});
    log.record({operation:'keyring',event:'diagnostic',keyring:{step:'Locked',failure:'dbus-error',dbusError:'org.freedesktop.DBus.Error.AccessDenied',elapsedMs:1}});
    const privateData={step:'/private_collection',failure:'secret password',dbusError:'org.freedesktop.DBus.Error.PrivateAccount',elapsedMs:1};
    log.record({operation:'keyring',event:'diagnostic',keyring:privateData as never});
    log.record({operation:'keyring',event:'diagnostic',keyring:{...privateData,step:'ReadAlias',failure:'unavailable'} as never});
    log.record({operation:'login',event:'diagnostic',keyring:{step:'Locked',failure:'timeout',elapsedMs:1}});
    const {content}=await log.read(), records=content.trim().split('\n').map(s=>JSON.parse(s));
    expect(records.filter(r=>r.keyringStep)).toHaveLength(3);
    expect(records.filter(r=>r.dbusError)).toHaveLength(2);
    expect(records[0]).toMatchObject({operation:'keyring',keyringStep:'ReadAlias',keyringFailure:'timeout',elapsedMs:2042});
    expect(content).not.toMatch(/private_collection|secret password|PrivateAccount/);
    expect((await fs.stat(path.join(root,'backend-diagnostics','backend.log'))).mode & 0o777).toBe(0o600);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

it('records bounded access-resolution reasons without product IDs, account data or arbitrary text', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-access-diagnostic-'));
  try {
    const log = new BackendDiagnostics(root);
    for (const stage of ['access-unresolved', 'access-conditional', 'access-special', 'access-parent-unavailable', 'access-cycle', 'access-depth'])
      log.record({ operation: 'library', event: 'validation', stage, skipped: 3 });
    log.record({ operation: 'library', event: 'validation', stage: 'CFQ7TTBZT8LN private@example.test', skipped: 300_000 });
    const content = (await log.read()).content;
    const records = content.trim().split('\n').map(line => JSON.parse(line));
    expect(records.filter(row => row.stage)).toHaveLength(6);
    expect(records.filter(row => row.skipped === 3)).toHaveLength(6);
    expect(content).not.toMatch(/CFQ7TTBZT8LN|private@example.test|300000/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('accepts only a bounded ticket error code for profile/library and never stores fault text or URLs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-ticket-diagnostic-'));
  try {
    const log = new BackendDiagnostics(root);
    for (const operation of ['library', 'profile', 'login', 'run', 'streaming']) {
      const reader = new BackendDiagnosticReader(operation, event => log.record(event));
      const frame = 'NEXUS_TICKET_DIAGNOSTIC_V1 ticket-refused 800488AB';
      for (const raw of [frame, frame + ' private-secret', frame.replace('800488AB', 'https://private.test/?token=secret'),
        frame.replace('800488AB', '800488ABC'), frame.replace('800488AB', '800488AZ')]) reader.push(Buffer.from(raw + '\n'));
    }
    log.record({ operation: 'library', event: 'diagnostic', stage: 'ticket-refused', serviceCode: 'private-secret' });
    const { content } = await log.read();
    const records = content.trim().split('\n').map(line => JSON.parse(line));
    expect(records.filter(row => row.serviceCode)).toHaveLength(2);
    expect(records.filter(row => row.serviceCode).map(row => row.operation)).toEqual(['library', 'profile']);
    expect(content).not.toMatch(/private-secret|private.test|token=secret/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('records exact transfer causes only for download operations and never signed URLs', () => {
  for (const operation of ['streaming','download']) {
    const events: unknown[] = [];
    const reader = new BackendDiagnosticReader(operation, event => events.push(event));
    const text = 'https://private.example/?token=SECRET\nNEXUS_TRANSFER_DIAGNOSTIC_V1 transfer-http 503\nNEXUS_TRANSFER_DIAGNOSTIC_V1 transfer-idle-timeout 0\n';
    for (const byte of Buffer.from(text)) reader.push(Buffer.from([byte]));
    expect(events).toEqual([
      {operation,event:'diagnostic',stage:'transfer-http',status:503,skipped:undefined},
      {operation,event:'diagnostic',stage:'transfer-idle-timeout',status:undefined,skipped:undefined},
    ]);
    for (const line of ['NEXUS_TRANSFER_DIAGNOSTIC_V1 unknown 0','NEXUS_TRANSFER_DIAGNOSTIC_V1 transfer-http 999','NEXUS_TRANSFER_DIAGNOSTIC_V1 transfer-http 403 SECRET']) reader.push(Buffer.from(line+'\n'));
    expect(events).toHaveLength(2); expect(JSON.stringify(events)).not.toContain('SECRET');
  }
  for (const operation of ['login','library','profile','run','license']) {
    const events: unknown[] = [];
    new BackendDiagnosticReader(operation,event=>events.push(event)).push(Buffer.from('NEXUS_TRANSFER_DIAGNOSTIC_V1 transfer-http 403\n'));
    expect(events).toHaveLength(0);
  }
});

it('records allowlisted content-license stages/status only for licensing operations', () => {
  for (const operation of ['streaming', 'download', 'license', 'run']) {
    const events: unknown[] = [];
    const reader = new BackendDiagnosticReader(operation, event => events.push(event));
    const input = Buffer.from('private@example.test token=SECRET\nNEXUS_CONTENT_LICENSE_DIAGNOSTIC_V1 content-http 403\r\nNEXUS_CONTENT_LICENSE_DIAGNOSTIC_V1 content-schema 200\nNEXUS_CONTENT_LICENSE_DIAGNOSTIC_V1 content-device-limit 200\n');
    for (const byte of input) reader.push(Buffer.from([byte]));
    expect(events).toEqual([
      { operation, event: 'diagnostic', stage: 'content-http', status: 403, skipped: undefined },
      { operation, event: 'diagnostic', stage: 'content-schema', status: 200, skipped: undefined },
      { operation, event: 'diagnostic', stage: 'content-device-limit', status: 200, skipped: undefined },
    ]);
    for (const line of ['NEXUS_CONTENT_LICENSE_DIAGNOSTIC_V1 unknown 403',
      'prefix NEXUS_CONTENT_LICENSE_DIAGNOSTIC_V1 content-http 403', 'NEXUS_CONTENT_LICENSE_DIAGNOSTIC_V1 content-http 403 private-secret',
      'NEXUS_CONTENT_LICENSE_DIAGNOSTIC_V1 content-http 999']) reader.push(Buffer.from(line+'\n'));
    expect(events).toHaveLength(3); expect(JSON.stringify(events)).not.toMatch(/SECRET|example.test|private-secret/);
  }
  for (const operation of ['profile', 'login', 'library']) {
    const events: unknown[] = [];
    new BackendDiagnosticReader(operation, event => events.push(event)).push(Buffer.from('NEXUS_CONTENT_LICENSE_DIAGNOSTIC_V1 content-http 403\nNEXUS_CONTENT_LICENSE_DIAGNOSTIC_V1 content-device-limit 200\n'));
    expect(events).toHaveLength(0);
  }
});

it('records only allowlisted session stages for optional account reads', () => {
  for (const operation of ['library', 'profile']) {
    const events: unknown[] = [];
    const reader = new BackendDiagnosticReader(operation, event => events.push(event));
    reader.push(Buffer.from('NEXUS_SESSION_DIAGNOSTIC_V1 ticket-timeout\nNEXUS_SESSION_DIAGNOSTIC_V1 ticket-retry\nNEXUS_SESSION_DIAGNOSTIC_V1 session-user-expired\n'));
    expect(events).toHaveLength(3);
    for (const raw of ['NEXUS_SESSION_DIAGNOSTIC_V1 private-secret',
      'prefix NEXUS_SESSION_DIAGNOSTIC_V1 ticket-timeout', 'NEXUS_SESSION_DIAGNOSTIC_V1 ticket-timeout private-secret']) reader.push(Buffer.from(raw + '\n'));
    expect(events).toHaveLength(3); expect(JSON.stringify(events)).not.toContain('private-secret');
  }
  const events: unknown[] = [];
  new BackendDiagnosticReader('login', event => events.push(event)).push(Buffer.from('NEXUS_SESSION_DIAGNOSTIC_V1 ticket-timeout\n'));
  expect(events).toHaveLength(0);
});

it('parses fixed legacy and new stages across chunks, never raw or injected output', () => {
  const events: unknown[] = [];
  const reader = new BackendDiagnosticReader('library', event => events.push(event));
  const input = Buffer.from('private-user@example.test t=SECRET&p=SECRET\nNEXUS_LIBRARY_DIAGNOSTIC_V1 entitlements-http 403 0\r\nNEXUS_CREDENTIAL_ERROR_V1 keyring-unavailable\nAccount library unavailable (stored-device); credentials and installed games are unchanged.\n');
  for (const byte of input) reader.push(Buffer.from([byte]));
  expect(events).toHaveLength(3);
  expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ stage: 'entitlements-http', status: 403 })]));
  expect(JSON.stringify(events)).not.toMatch(/SECRET|example.test/);
  for (const line of ['NEXUS_CREDENTIAL_ERROR_V1 private-secret', 'prefix NEXUS_CREDENTIAL_ERROR_V1 keyring-unavailable',
    'NEXUS_LIBRARY_DIAGNOSTIC_V1 entitlements-http 403 0 private-secret', 'NEXUS_LIBRARY_DIAGNOSTIC_V1 private-secret 403 0',
    'NEXUS_LIBRARY_DIAGNOSTIC_V1 entitlements-http 999 0', 'NEXUS_LIBRARY_DIAGNOSTIC_V1 partial 0 999999', 'NEXUS_CREDENTIAL_ERROR_V1 partial',
    'NEXUS_CREDENTIAL_ERROR_V1 keyring-unavailable private-secret', 'x'.repeat(800) + 'NEXUS_CREDENTIAL_ERROR_V1 keyring-unavailable']) reader.push(Buffer.from(line + '\n'));
  expect(events).toHaveLength(3);
  reader.push(Buffer.from('NEXUS_CREDENTIAL_ERROR_V1 keyring-missing-data'));
  expect(events).toHaveLength(3);
});

it('bounds line count, line length and total parsing', () => {
  const events: unknown[] = [];
  const reader = new BackendDiagnosticReader('library', event => events.push(event));
  reader.push(Buffer.from(('NEXUS_LIBRARY_DIAGNOSTIC_V1 partial 0 2\n').repeat(1000)));
  expect(events).toHaveLength(32);
  const oversized = new BackendDiagnosticReader('library', event => events.push(event));
  oversized.push(Buffer.alloc(2 * 1024 * 1024, 120));
  oversized.push(Buffer.from('\nNEXUS_CREDENTIAL_ERROR_V1 keyring-unavailable\n'));
  expect(events).toHaveLength(32);
});

it('persists private bounded logs, rotates only its own log and omits arbitrary fields', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-backend-log-'));
  try {
    const log = new BackendDiagnostics(root, () => ({ launcher: '0.3.6', backend: '0.2.6', source: 'managed' }), 1024);
    for (let i = 0; i < 30; i++) { log.record({ operation: 'library', event: 'diagnostic', stage: 'partial', skipped: i }); await log.flush(); }
    log.record({ operation: 'library', event: 'diagnostic', stage: 'private-secret', signal: 'private-secret', status: 999, skipped: -1 });
    log.record({ operation: 'private-secret', event: 'start' });
    const result = await log.read();
    expect(result.content).toContain('"backend":"0.2.6"');
    expect(result.content).not.toContain('private-secret');
    const dir = path.join(root, 'backend-diagnostics');
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    for (const name of ['backend.log', 'backend.log.1']) {
      const stat = await fs.stat(path.join(dir, name));
      expect(stat.mode & 0o777).toBe(0o600); expect(stat.size).toBeLessThanOrEqual(1024);
    }
    const persisted = new BackendDiagnostics(root);
    expect((await persisted.read()).content).toBe(result.content);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it.each(['file-symlink', 'directory-symlink', 'hardlink', 'public-file'])('refuses unsafe %s without changing or reading its target', async kind => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-log-unsafe-'));
  try {
    const outside = path.join(root, 'outside'); await fs.mkdir(outside, { mode: 0o700 });
    const target = path.join(outside, 'secret'); await fs.writeFile(target, 'private-secret', { mode: 0o600 });
    const dir = path.join(root, 'backend-diagnostics');
    if (kind === 'directory-symlink') await fs.symlink(outside, dir);
    else {
      await fs.mkdir(dir, { mode: 0o700 });
      if (kind === 'file-symlink') await fs.symlink(target, path.join(dir, 'backend.log'));
      if (kind === 'hardlink') await fs.link(target, path.join(dir, 'backend.log'));
      if (kind === 'public-file') await fs.writeFile(path.join(dir, 'backend.log'), 'private-secret', { mode: 0o644 });
    }
    const log = new BackendDiagnostics(root); log.record({ operation: 'account', event: 'start' });
    await expect(log.read()).rejects.toThrow('could not be saved');
    expect(await fs.readFile(target, 'utf8')).toBe('private-secret');
    await expect(new BackendDiagnostics(root).read()).rejects.toThrow('opened safely');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('does not break backend calls when logging fails and never captures stdout or command arguments', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-log-process-'));
  try {
    const log = new BackendDiagnostics(root); setBackendDiagnostics(log);
    const child = spawn(process.execPath, ['-e', "process.stdout.write('user@example.test t=SECRET&p=SECRET'); process.stderr.write('raw-secret\\nNEXUS_CREDENTIAL_ERROR_V1 keyring-unavailable\\n');process.exitCode=1"]);
    let fixtureError = ''; child.stderr.on('data', bytes => { fixtureError += bytes.toString(); });
    observeBackendChild(child, 'login'); child.stdout.resume();
    await new Promise(resolve => child.once('close', resolve));
    const result = await log.read();
    expect(result.content, fixtureError).toContain('keyring-unavailable');
    expect(result.content).toContain('"code":1');
    expect(result.content).not.toMatch(/SECRET|raw-secret|example.test/);
    await fs.rm(path.join(root, 'backend-diagnostics'), { recursive: true });
    await fs.writeFile(path.join(root, 'backend-diagnostics'), 'occupied');
    const tracked = spawnTracked(process.execPath, ['-e', 'process.stdout.write("ok")']);
    expect((await tracked.result).code).toBe(0);
    const other = spawn(process.execPath, ['-e', 'process.exit(0)']);
    observeBackendChild(other, 'service');
    await new Promise(resolve => other.once('close', resolve));
    await log.flush(); // Logger failure must not reject or interfere with the process.
  } finally { setBackendDiagnostics(undefined); await fs.rm(root, { recursive: true, force: true }); }
});

it('observes actual tracked CLI calls without capturing license JSON or paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-log-cli-'));
  try {
    const log = new BackendDiagnostics(root); setBackendDiagnostics(log);
    const binary = path.join(root, 'xodus-cli');
    await fs.writeFile(binary, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({account:"user@example.test",secret:"synthetic-token"}));process.stderr.write("NEXUS_LIBRARY_DIAGNOSTIC_V1 entitlements-http 401 0\\n");process.exitCode=1;\n', { mode: 0o755 });
    const result = await spawnTracked(binary, ['library', '--json', '--market', 'US']).result;
    expect(result.code).toBe(1);
    const content = (await log.read()).content;
    expect(content).toContain('entitlements-http'); expect(content).toContain('"status":401');
    expect(content).not.toMatch(/example.test|synthetic-token|--json|nexus-log-cli/);
  } finally { setBackendDiagnostics(undefined); await fs.rm(root, { recursive: true, force: true }); }
});

it('records achievement command metadata without its title ID, account or response', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-log-achievements-'));
  try {
    const log = new BackendDiagnostics(root); setBackendDiagnostics(log);
    const binary = path.join(root, 'xodus-cli');
    await fs.writeFile(binary, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({account:"sample@example.test",items:[{name:"PRIVATE ACHIEVEMENT"}]}));\n', { mode: 0o755 });
    expect((await spawnTracked(binary, ['achievements', '12345678', '--json']).result).code).toBe(0);
    const content = (await log.read()).content;
    expect(content).toContain('"operation":"achievements"'); expect(content).toContain('"code":0');
    expect(content).not.toMatch(/12345678|PRIVATE|example.test|--json|nexus-log-achievements/);
  } finally { setBackendDiagnostics(undefined); await fs.rm(root, { recursive: true, force: true }); }
});
