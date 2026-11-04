import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startAuthTransport, type AuthViewFactory } from './auth-transport.js';
import { BackendDiagnostics, setBackendDiagnostics } from './backend-diagnostics.js';
const fixture = String.raw`#!/usr/bin/env node
const readline=require('node:readline');
const out=value=>process.stdout.write('NEXUS_AUTH_V1 '+JSON.stringify(value)+'\n');
const mode=process.env.FIXTURE_MODE;
if(mode==='no-handshake'){process.stdout.write('ordinary help\n');process.exit(0);}
if(mode==='credential-failure'){
 process.stderr.write('synthetic-secret-must-not-be-logged\nNEXUS_CREDENTIAL_ERROR_V1 keyring-write-verification\n');process.exit(1);
}
if(mode==='unknown-credential'){
 process.stderr.write('NEXUS_CREDENTIAL_ERROR_V1 synthetic-secret-must-not-be-logged\n');process.exit(1);
}
out({type:'ready',version:1});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const event=JSON.parse(line);
 if(event.type==='hello'){
  if(mode==='invalid'){out({type:'execute',session:1,code:'synthetic-secret'});return;}
  out({type:'open',session:1,url:'https://login.live.com/ppsecure/InlineLogin.srf',headers:{hostapp:'CloudExperienceHost'}});
 }
 if(event.type==='ipc'){
  process.stdout.write('synthetic-secret-must-not-be-logged\n');
  out({type:'close',session:1});setTimeout(()=>process.exit(0),20);
 }
});
`;
describe('private auth transport', () => {
  it.each([false, true])('does not report a successful sign-in as invalid when cleanup aborts a pending view (late close: %s)', async incomplete => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-auth-completion-'));
    let abort!: (error: Error) => void;
    try {
      const binary = path.join(root, 'cli');
      const body = incomplete ? fixture.replace("out({type:'close',session:1});", '') : fixture;
      await fs.writeFile(binary, body, { mode: 0o700 });
      const tracked = startAuthTransport(binary, send => ({
        async open(frame) { send(frame.session, '{}'); await new Promise<void>((_resolve, reject) => { abort = reject; }); },
        close() {}, async context() {}, async dispose() { abort(Error('load aborted by disposal')); },
      }), { ...process.env, FIXTURE_MODE: 'success' }, 3000);
      if (incomplete) await expect(tracked.result).rejects.toThrow('did not complete its protocol');
      else expect((await tracked.result).code).toBe(0);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it.each([false, true].flatMap(player => ['success', 'invalid', 'no-handshake', 'cancel', 'load-failure', 'credential-failure', 'unknown-credential'].map(mode => ({player, mode}))))('handles $mode, player=$player without exposing protocol output', async ({mode, player}) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-auth-fixture-'));
    let disposed = false, opens = 0, closes = 0;
    try {
      const diagnostics = new BackendDiagnostics(root); setBackendDiagnostics(diagnostics);
      const binary = path.join(root, 'cli'); await fs.writeFile(binary, fixture, { mode: 0o755 });
      const factory: AuthViewFactory = (send, cancel) => ({
        async open(frame) { opens++; if (mode === 'cancel') cancel(frame.session); else if (mode === 'load-failure') throw Error('synthetic-secret'); else send(frame.session, '{"synthetic":"not-a-real-token"}'); },
        close() { closes++; }, async context() {}, async dispose() { disposed = true; },
      });
      const tracked = startAuthTransport(binary, factory, { ...process.env, FIXTURE_MODE: mode }, 3000, player);
      expect(tracked.child.spawnargs).toEqual([binary, '--external-webview-stdio', 'login', ...(player ? ['--player'] : [])]);
      if (mode === 'credential-failure') { await expect(tracked.result).rejects.toThrow('keyring did not return the credentials just saved'); expect(opens).toBe(0); }
      else if (mode === 'invalid' || mode === 'no-handshake' || mode === 'load-failure' || mode === 'unknown-credential') await expect(tracked.result).rejects.toThrow(/sign-in/i);
      else { const result = await tracked.result; expect(result.code).toBe(mode === 'cancel' ? 1 : 0); expect(result.output).toBe(''); }
      expect(disposed).toBe(true);
      const logged = (await diagnostics.read()).content;
      expect(logged).toContain('"operation":"login"');
      expect(logged).not.toMatch(/synthetic-secret|login.live.com|CloudExperienceHost|not-a-real-token/);
      if (mode === 'success') { expect(opens).toBe(1); expect(closes).toBe(1); }
    } finally { setBackendDiagnostics(undefined); await fs.rm(root, { recursive: true, force: true }); }
  });
});
