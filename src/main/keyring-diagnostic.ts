/** Fixed metadata only. Never retain provider stderr, object paths or arguments. */
export const keyringSteps = ['NameHasOwner', 'ListActivatableNames', 'StartServiceByName', 'ReadAlias', 'Collections', 'Locked'] as const;
export type KeyringStep = typeof keyringSteps[number];
export const keyringFailures = ['timeout', 'client-missing', 'client-permission', 'dbus-error', 'invalid-response', 'unavailable'] as const;
export type KeyringFailure = typeof keyringFailures[number];
export const keyringBusErrors = [
  'org.freedesktop.DBus.Error.NoReply', 'org.freedesktop.DBus.Error.Timeout',
  'org.freedesktop.DBus.Error.ServiceUnknown', 'org.freedesktop.DBus.Error.NameHasNoOwner',
  'org.freedesktop.DBus.Error.AccessDenied', 'org.freedesktop.DBus.Error.AuthFailed',
  'org.freedesktop.DBus.Error.UnknownMethod', 'org.freedesktop.DBus.Error.UnknownObject',
  'org.freedesktop.DBus.Error.UnknownInterface', 'org.freedesktop.DBus.Error.UnknownProperty',
  'org.freedesktop.DBus.Error.Disconnected', 'org.freedesktop.DBus.Error.NotSupported',
  'org.freedesktop.DBus.Error.LimitsExceeded', 'org.freedesktop.DBus.Error.Spawn.ExecFailed',
  'org.freedesktop.Secret.Error.IsLocked', 'org.freedesktop.Secret.Error.NoSuchObject',
] as const;
export type KeyringDiagnostic = { step: KeyringStep; failure: KeyringFailure; dbusError?: typeof keyringBusErrors[number]; elapsedMs: number };

export class KeyringMetadataError extends Error {
  constructor(readonly failure: KeyringFailure, readonly dbusError?: typeof keyringBusErrors[number]) {
    super('Keyring metadata check unavailable.');
  }
}

export function keyringCommandFailure(error: { code?: string | number | null; killed?: boolean }, stderr: string): KeyringMetadataError {
  if (error.code === 'ENOENT') return new KeyringMetadataError('client-missing');
  if (error.code === 'EACCES') return new KeyringMetadataError('client-permission');
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return new KeyringMetadataError('invalid-response');
  if (error.code === 'ETIMEDOUT') return new KeyringMetadataError('timeout');
  if (error.killed) return new KeyringMetadataError('timeout');
  // busctl versions may include the structured D-Bus name in their diagnostic.
  // Do not invent one from localized prose or retain any adjacent text.
  const names: string[] = stderr.slice(0, 128_000).match(/org\.freedesktop\.(?:DBus|Secret)\.Error\.[A-Za-z0-9_.-]+/g) ?? [];
  const dbusError = keyringBusErrors.find(name => names.includes(name));
  if (dbusError) return new KeyringMetadataError(/\.(NoReply|Timeout)$/.test(dbusError) ? 'timeout' : 'dbus-error', dbusError);
  // systemd emits this fixed timeout text without a D-Bus name on some versions.
  if (/^Call failed: (Connection timed out|Method call timed out)\s*$/.test(stderr.trim())) return new KeyringMetadataError('timeout');
  return new KeyringMetadataError('unavailable');
}

export function keyringStep(args: string[]): KeyringStep {
  if (args[3] === 'Get') return args.at(-1) === 'Collections' ? 'Collections' : 'Locked';
  return keyringSteps.includes(args[3] as KeyringStep) ? args[3] as KeyringStep : 'NameHasOwner';
}
