import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { AUTH_FRAME_LIMIT, authFrame, type AuthFrame } from './auth-protocol.js';
import { externalLauncherEnvironment } from './launcher-environment.js';
import { CredentialErrorReader } from './credential-errors.js';
import { backendDiagnostic, observeBackendChild } from './backend-diagnostics.js';
export interface AuthView {
  open(frame: Extract<AuthFrame, { type: 'open' }>): Promise<void>;
  close(session: number): void;
  context(session: number, context: string): Promise<void>;
  dispose(): Promise<void>;
}
export type AuthViewFactory = (send: (session: number, payload: string) => void, cancel: (session: number) => void, fail: () => void) => AuthView;

export function startAuthTransport(binary: string, createView: AuthViewFactory, environment: NodeJS.ProcessEnv = process.env, timeoutMs = 600_000, player = false): {
  child: ChildProcessWithoutNullStreams; result: Promise<{ code: number; output: string }>;
} {
  // This explicit flag is absent in the native backend. Never fall back to an
  // incompatible handshake. The backend uses only these private stdio pipes.
  const child = spawn(binary, ['--external-webview-stdio', 'login', ...(player ? ['--player'] : [])], {
    env: { ...externalLauncherEnvironment(environment), XODUS_LOG: 'off', RUST_LOG: 'off' }, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
  });
  observeBackendChild(child, 'login');
  let ready = false, active: number | undefined, latest = 0, stopped = false, cancelled = false, completing = false;
  let failure: Error | undefined, line = '', total = 0, queue = Promise.resolve();
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  const decoder = new StringDecoder('utf8');
  const credentialError = new CredentialErrorReader();
  const terminate = () => { if (!stopped) { child.kill('SIGTERM'); abortTimer ??= setTimeout(() => { if (!stopped) child.kill('SIGKILL'); }, 1500); } };
  const fail = (message: string) => { if (!failure) { failure = Error(message); terminate(); } };
  const write = (event: object) => { if (!stopped && !child.stdin.destroyed && child.stdin.writable) child.stdin.write(JSON.stringify(event) + '\n'); };
  const view = createView((session, payload) => {
    if (active === session && typeof payload === 'string' && Buffer.byteLength(payload) <= AUTH_FRAME_LIMIT / 2) write({ type: 'ipc', session, payload });
  }, session => {
    if (active !== session || stopped) return;
    cancelled = true; write({ type: 'closed', session }); terminate();
  }, () => fail('The sign-in window was blocked or failed to load.'));
  const timer = setTimeout(() => fail('Sign-in timed out.'), timeoutMs);
  const force = setTimeout(() => { if (!stopped) child.kill('SIGKILL'); }, timeoutMs + 3000);
  child.stdin.on('error', () => { if (!stopped && !cancelled) fail('The sign-in backend disconnected.'); });
  child.stderr.on('data', (bytes: Buffer) => credentialError.push(bytes));
  child.stdout.on('data', bytes => {
    total += bytes.length; line += decoder.write(bytes);
    if (total > 2 * 1024 * 1024) { fail('Sign-in backend exceeded the output limit.'); return; }
    let end: number;
    while ((end = line.indexOf('\n')) >= 0) {
      const raw = line.slice(0, end).replace(/\r$/, ''); line = line.slice(end + 1);
      queue = queue.then(async () => {
        if (failure || cancelled) return;
        const frame = authFrame(raw); if (!frame) return;
        if (frame.type === 'ready') {
          if (ready) throw Error('Duplicate sign-in handshake.');
          ready = true; write({ type: 'hello', version: 1 }); return;
        }
        if (!ready) throw Error('Missing sign-in protocol handshake.');
        if (frame.type === 'open') {
          if (frame.session <= latest || latest >= 32) throw Error('Invalid sign-in session order.');
          active = frame.session; latest = frame.session;
          if (!stopped) {
            try { await view.open(frame); }
            catch (error) { if (!completing) throw error; }
          }
        } else if (frame.session === active) {
          if (frame.type === 'context') {
            if (!stopped) { try { await view.context(frame.session, frame.context); } catch (error) { if (!completing) throw error; } }
          }
          else { active = undefined; view.close(frame.session); }
        } else throw Error('Unexpected sign-in session.');
      }).catch(() => fail('The sign-in backend returned an invalid response.'));
    }
    if (Buffer.byteLength(line) > AUTH_FRAME_LIMIT) fail('Sign-in response exceeds the protocol limit.');
  });
  const result = new Promise<{ code: number; output: string }>((resolve, reject) => {
    child.once('error', () => { failure = Error('Unable to start the external sign-in backend.'); });
    child.once('close', async code => {
      // Disposing an already successful sign-in can abort loadURL/JS promises.
      // Ignore only those view rejections, never protocol validation failures.
      completing = code === 0 && !cancelled && !failure;
      stopped = true; clearTimeout(timer); clearTimeout(force); clearTimeout(abortTimer);
      await view.dispose().catch(() => {}); await queue;
      if (failure) { backendDiagnostic({ operation: 'login', event: 'validation', stage: 'protocol-error' }); reject(failure); }
      else if (code !== 0 && credentialError.message) reject(Error(credentialError.message));
      else if (!ready || line.length || (code === 0 && (active !== undefined || latest === 0))) {
        backendDiagnostic({ operation: 'login', event: 'validation', stage: 'protocol-error' });
        reject(Error('The sign-in backend did not complete its protocol.'));
      }
      else resolve({ code: cancelled ? 1 : (code ?? 1), output: '' });
    });
  });
  return { child, result };
}
