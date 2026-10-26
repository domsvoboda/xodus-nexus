import { execFile } from 'node:child_process';
import type { KeyringStatus } from '../shared/types.js';
import { externalLauncherEnvironment } from './launcher-environment.js';
import { secretServiceProvider, type SecretServiceProvider } from './keyring-provider.js';
import { startSessionKeyring, type KdeProvider } from './keyring-session.js';
import { keyringCommandFailure, KeyringMetadataError, keyringStep, type KeyringDiagnostic } from './keyring-diagnostic.js';

export type KeyringActions = {
  startProvider?: (provider: KdeProvider, env: NodeJS.ProcessEnv, owned: () => Promise<boolean>) => Promise<void>;
  canUnlock?: () => boolean;
  unlock?: () => Promise<string>;
  canCreate?: () => boolean;
  create?: () => Promise<string>;
  diagnostic?: (value: KeyringDiagnostic) => void;
};

type Execute = (command: string, args: string[]) => Promise<string>;
const secretService = 'org.freedesktop.secrets';
const busService = ['org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus'];
const serviceObject = '/org/freedesktop/secrets';
// KDE 6 can advertise its compatibility activation name rather than the
// standard name. Never start another provider when one already owns secrets.
const activationNames = [secretService, 'org.kde.secretservicecompat', 'org.kde.kwalletd6', 'org.kde.kwalletd5'];

/** Checks are metadata-only. Preparation never reads credentials or changes policy. */
export class KeyringSupport {
  private checking?: Promise<KeyringStatus>;
  private starting?: Promise<KeyringStatus>;
  private readonly execute: Execute;
  private readonly gameMode: boolean;
  private readonly identifyProvider: () => Promise<SecretServiceProvider>;

  constructor(environment: NodeJS.ProcessEnv = process.env, execute?: Execute, private readonly platform = process.platform,
    identifyProvider?: () => Promise<SecretServiceProvider>, private readonly actions: KeyringActions = {}) {
    this.gameMode = Boolean(environment.XDG_CURRENT_DESKTOP?.split(':').some(s => s.toLowerCase() === 'gamescope'));
    const env = externalLauncherEnvironment(environment);
    this.environment = env;
    this.identifyProvider = identifyProvider ?? (() => secretServiceProvider(env));
    this.execute = execute ?? ((command, args) => new Promise((resolve, reject) => {
      execFile(command, args, { env, timeout: 3500, killSignal: 'SIGKILL', maxBuffer: 128_000 }, (error, stdout, stderr) => {
        // Provider stderr and config paths never cross the renderer boundary.
        if (error) reject(keyringCommandFailure(error, stderr));
        else resolve(stdout);
      });
    }));
  }

  private readonly environment: NodeJS.ProcessEnv;
  get busy(): boolean { return Boolean(this.starting); }

  check(): Promise<KeyringStatus> {
    if (this.starting) return this.starting;
    return this.checking ??= this.inspect().then(r => r.status).finally(() => { this.checking = undefined; });
  }

  start(): Promise<KeyringStatus> {
    return this.prepare(false);
  }

  /** One visible-launcher startup attempt. Unknown providers stay explicit. */
  startForStartup(): Promise<KeyringStatus> {
    return this.prepare(true);
  }

  /** Explicit click only. Never replaces a default or another collection. */
  createCollection(): Promise<KeyringStatus> {
    return this.starting ??= (async () => {
      if (this.checking) await this.checking;
      const before = (await this.inspect()).status;
      if (before.state !== 'needs-setup' || !before.canCreate || !this.actions.create) return before;
      try {
        const result = await this.actions.create();
        const after = (await this.inspect()).status;
        if (after.state === 'ready') return after;
        return { ...after, message: result === 'cancelled' ? 'Wallet setup was cancelled. You can try again when ready.'
          : result === 'timed-out' ? 'Wallet setup timed out. Check for the system wallet window, then try again.'
          : result === 'unavailable' ? 'Wallet setup could not be completed. Check the backend diagnostic log and try again.' : after.message };
      } catch {
        return { ...before, message: 'Wallet setup could not be completed. Check the backend diagnostic log and try again.' };
      }
    })().finally(() => { this.starting = undefined; });
  }

  private prepare(automatic: boolean): Promise<KeyringStatus> {
    return this.starting ??= (async () => {
      if (this.checking) await this.checking;
      const before = await this.inspect();
      try {
        if (automatic && (!this.gameMode || (before.status.state === 'stopped' && !before.autoStartAllowed))) return before.status;
        if (before.status.state === 'locked') return await this.unlock(before.status);
        if (!before.target || !before.status.canStart) return before.status;
        // Startup is limited to a known enabled KDE provider; other activation
        // remains explicit. Never enable a wallet, create one or change passwords.
        if (this.gameMode && (before.provider === 'kwallet' || before.provider === 'ksecretd')) {
          await (this.actions.startProvider ?? startSessionKeyring)(before.target === 'org.kde.kwalletd5' ? 'kwallet5' : before.provider, this.environment,
            async () => await this.bus('b', [...busService, 'NameHasOwner', 's', secretService]) === true);
        } else {
          const reply = await this.bus('u', [...busService, 'StartServiceByName', 'su', before.target, '0']);
          if (reply !== 1 && reply !== 2) throw Error('Unexpected activation reply');
        }
        let after = await this.inspect();
        const deadline = Date.now() + 4000;
        while (after.status.state === 'stopped' && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 100));
          after = await this.inspect();
        }
        if (after.status.state === 'locked') return await this.unlock(after.status);
        return after.status.state === 'stopped'
          ? this.status('unavailable', 'The keyring did not become available. Open your desktop wallet settings, then check again.') : after.status;
      } catch {
        return this.status('unavailable', 'The installed keyring could not be started. Open your desktop wallet settings, enable and unlock it, then check again.');
      }
    })().finally(() => { this.starting = undefined; });
  }

  private async unlock(status: KeyringStatus): Promise<KeyringStatus> {
    if (!status.canUnlock || !this.actions.unlock) return status;
    const result = await this.actions.unlock();
    const after = (await this.inspect()).status;
    if (after.state === 'ready') return after;
    return { ...after, message: result === 'cancelled' ? 'Wallet unlocking was cancelled. Your saved credentials are unchanged.'
      : result === 'timed-out' ? 'Wallet unlocking timed out. Check for the wallet password window, then try again.'
      : result === 'unavailable' ? 'The wallet password window could not be completed. Check the backend diagnostic log and try again.'
      : after.message };
  }

  private status(state: KeyringStatus['state'], message: string, canStart = false): KeyringStatus {
    return { state, message, canStart, gameMode: this.gameMode };
  }

  private async bus(type: string, args: string[]): Promise<unknown> {
    const start = performance.now(), step = keyringStep(args);
    try {
      const raw = await this.execute('busctl', ['--user', '--json=short', '--auto-start=no', '--allow-interactive-authorization=no', '--timeout=2s', 'call', ...args]);
      let response: { type?: unknown; data?: unknown };
      try { response = JSON.parse(raw); } catch { throw new KeyringMetadataError('invalid-response'); }
      if (!response || response.type !== type || !Array.isArray(response.data) || response.data.length !== 1)
        throw new KeyringMetadataError('invalid-response');
      const value = response.data[0];
      const objectPath = (p: unknown) => typeof p === 'string' && /^\/(?:[A-Za-z0-9_]+\/?)*$/.test(p);
      const variant = value as { type?: unknown; data?: unknown } | null;
      const valid = step === 'NameHasOwner' ? typeof value === 'boolean'
        : step === 'ReadAlias' ? objectPath(value)
        : step === 'ListActivatableNames' ? Array.isArray(value) && value.every(v => typeof v === 'string')
        : step === 'StartServiceByName' ? value === 1 || value === 2
        : step === 'Locked' ? variant?.type === 'b' && typeof variant.data === 'boolean'
        : variant?.type === 'ao' && Array.isArray(variant.data) && variant.data.every(objectPath);
      if (!valid) throw new KeyringMetadataError('invalid-response');
      return value;
    } catch (error) {
      const failure = error instanceof KeyringMetadataError ? error : new KeyringMetadataError('unavailable');
      try { this.actions.diagnostic?.({ step, failure: failure.failure, dbusError: failure.dbusError, elapsedMs: performance.now() - start }); }
      catch { /* Logging must not alter wallet or authentication behavior. */ }
      throw failure;
    }
  }

  private async inspect(): Promise<{ status: KeyringStatus; target?: string; provider?: SecretServiceProvider; autoStartAllowed?: boolean }> {
    if (this.platform !== 'linux') return { status: this.status('unavailable', 'System-keyring setup is available on Linux.') };
    try {
      const owned = await this.bus('b', [...busService, 'NameHasOwner', 's', secretService]);
      if (typeof owned !== 'boolean') throw Error('Invalid owner');
      if (owned) {
        const collection = await this.bus('o', [secretService, serviceObject, 'org.freedesktop.Secret.Service', 'ReadAlias', 's', 'default']);
        if (typeof collection !== 'string' || !/^\/(?:[A-Za-z0-9_]+\/?)*$/.test(collection)) throw Error('Invalid collection');
        if (collection === '/') {
          const status = this.status('needs-setup', 'The keyring is running, but has no default wallet. Complete wallet setup in Desktop Mode, then check again.');
          if (this.actions.canCreate?.()) {
            const collections = await this.bus('v', [secretService, serviceObject, 'org.freedesktop.DBus.Properties', 'Get', 'ss', 'org.freedesktop.Secret.Service', 'Collections']) as { type?: unknown; data?: unknown };
            if (collections?.type !== 'ao' || !Array.isArray(collections.data) || collections.data.some(p => typeof p !== 'string' || !/^\/(?:[A-Za-z0-9_]+\/?)*$/.test(p))) throw Error('Invalid collections');
            if (collections.data.length === 0) return { status: { ...status, canCreate: true,
              message: 'Create a wallet in the system dialog. Choose a password there, or leave it empty if supported. An empty password does not protect saved credentials.' } };
          }
          return { status };
        }
        const property = await this.bus('v', [secretService, collection, 'org.freedesktop.DBus.Properties', 'Get', 'ss', 'org.freedesktop.Secret.Collection', 'Locked']);
        // busctl represents a variant as a nested typed value.
        const value = property as { type?: unknown; data?: unknown };
        if (value?.type !== 'b' || typeof value.data !== 'boolean') throw Error('Invalid lock state');
        return { status: value.data
          ? { ...this.status('locked', 'Your default wallet is locked. Unlock it to use saved sign-in credentials.'), canUnlock: Boolean(this.actions.canUnlock?.()) }
          : this.status('ready', 'The default system wallet is running and unlocked. Sign-in will still verify that credentials can be saved.') };
      }
      const names = await this.bus('as', [...busService, 'ListActivatableNames']);
      if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) throw Error('Invalid service list');
      const target = activationNames.find(name => names.includes(name));
      // The standard name can activate KDE too, but merely having KDE
      // installed does not establish which provider owns that activation.
      const provider = target === secretService ? await this.identifyProvider().catch(() => 'unknown' as const)
        : target === 'org.kde.secretservicecompat' ? 'ksecretd'
        : target?.startsWith('org.kde.kwalletd') ? 'kwallet' : 'unknown';
      let configurationKnown = false;
      if (provider === 'kwallet' || provider === 'ksecretd') {
        for (const command of ['kreadconfig6', 'kreadconfig5']) {
          try {
            const groups = [[provider === 'ksecretd' ? 'KSecretD' : 'Wallet', 'Enabled'], ['org.freedesktop.secrets', 'apiEnabled']];
            let known = true;
            for (const [group, key] of groups) {
              const enabled = (await this.execute(command, ['--file', 'kwalletrc', '--group', group, '--key', key, '--default', 'UNSET'])).trim();
              if (/^(false|0)$/i.test(enabled)) return { status: this.status('disabled', 'KDE Wallet or its Secret Service is disabled. In Desktop Mode, open System Settings > KDE Wallet, enable the wallet subsystem and unlock your wallet. Then check again.') };
              known &&= /^(UNSET|true|1)$/i.test(enabled);
            }
            configurationKnown = known;
            break;
          } catch { /* Older/non-KDE desktops may have no KConfig tools. */ }
        }
      }
      if (target) return { target, provider, autoStartAllowed: configurationKnown && (provider === 'kwallet' || provider === 'ksecretd'), status: this.status('stopped', 'Start the installed keyring for this session. Its own password window may appear; wallet security settings are unchanged.', true) };
      return { status: this.status('missing', 'No compatible Secret Service is running or available for activation. Install or enable your desktop keyring provider, then check again.') };
    } catch (error) {
      return { status: this.status('unavailable', error instanceof KeyringMetadataError && error.failure === 'timeout'
        ? 'The wallet service did not answer in time. Check your desktop wallet service, then try again. See the backend diagnostic log for details.'
        : 'Keyring status could not be checked. Ensure your user D-Bus session and busctl are available, and that your desktop wallet is enabled and unlocked. See the backend diagnostic log for details.') };
    }
  }
}
