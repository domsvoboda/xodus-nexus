# Shared Nexus backend

`patchId` identifies the exact source recipe. `compatibility` identifies the
game-launch contract accepted by existing launchers. A credential-only hotfix
keeps that contract when its launch arguments and behavior remain unchanged.

## Credential errors

Persistent credential writes require an exact read-back before success.
Interactive sign-in stores the account and its complete token set together in
one verified system-keyring record. Existing split credential records remain
readable without automatic migration. Logout removes both storage layouts.

Missing or malformed device-token caches can be regenerated through genuine device
authentication while preserving the device identity and stored account. Invalid
device identities and unavailable keyrings fail without automatic deletion or
replacement provisioning.

Persistent credentials written through `KeychainBackend` use the versioned
`XODUS_KEYRING_BASE64_V1:` ASCII envelope to preserve token bytes across
keyring serialization and reload. Base64 is **not encryption** and does not
change the selected keyring or its password
policy. Decoding happens before JSON validation and exact write verification.
Existing raw credentials remain readable without read-time writes or deletion;
malformed envelopes fail with a sanitized error. Logout treats already-missing
entries as successfully removed while preserving other keyring errors.

Sign out and sign in again if previously stored token data is already damaged.
Older Nexus backends and unmodified upstream Xodus cannot read the new envelope
in their shared credential store. Downgrades and switching to those builds are
not supported; signing out alone does not restore compatibility because the
device identity is preserved. Neither a keyring reset nor deletion of
unrelated passwords is required. A password-protected keyring is recommended for at-rest
security, independently of this encoding workaround.

The `credential_encoding_*` Rust tests run under the existing `credential_`
filter. `python3 scripts/keyring-textual-roundtrip.test.py` reproduces the GNOME
writer/reader mismatch and validates the envelope using in-memory GLib keyfiles
and synthetic data only. It is also run by Linux `test:ci-tools`; Python 3 and
`libglib-2.0` are required. No D-Bus session, account, or real keyring is accessed.

Credential failures exit nonzero and emit `NEXUS_CREDENTIAL_ERROR_V1 CODE` on
stderr. Codes are `keyring-unavailable`, `keyring-invalid-data`,
`keyring-write-verification`, `keyring-missing-data`, `device-authentication` and
`credential-io`. The launcher maps only these fixed codes to sign-in messages;
arbitrary stderr and stored credential values are not exposed in the UI.

## Account library and diagnostics

`library --json --market US` returns schema 1 with the account, market, check
time and verified entitlement records. The optional `skippedEntitlements`
count marks a partial result. Invalid rows, conflicting records and their
dependent licenses are omitted without granting access. Invalid envelopes,
authentication, pagination and transport errors still fail the whole request.

Library stderr may emit `NEXUS_LIBRARY_DIAGNOSTIC_V1 STAGE HTTP_STATUS COUNT`.
Stages are fixed codes; zero means no HTTP status is available. No response
bodies, account identifiers or credentials are included. The launcher records
allowlisted backend stages and process results in its private profile under
`backend-diagnostics/backend.log` (one rotated backup, 256 KiB each). Settings
offers an in-app viewer and Copy log. Arbitrary stdout, stderr, command
arguments and sign-in protocol messages are not saved. Logs remain local and
are never uploaded automatically.

### Backend update diagnostics

Launcher-side component updates use operation `update` in the same private
`backend.log`. Progress stages are `update-download`, `update-verify`,
`update-validate`, `update-activate`, `update-confirm` and `update-ready`.
Failures use fixed codes: `update-blocked` (activity gate or an update already
running), `update-discovery` (install release lookup), `update-check-failed`
(standalone release check, with the HTTP status when available),
`update-download-http` (with the HTTP status), `update-download-limit`,
`update-checksum`, `update-archive`, `update-extract`, `update-file-mismatch`,
`update-binary`, `update-permission`, `update-validate`, `update-commit`,
`update-cleanup`, `update-confirm` and `update-notify`. A cleanup failure after
another installer failure is recorded as the fixed `update-cleanup` diagnostic
while the original failure and its reason are kept; a cleanup failure after an
otherwise valid install fails the operation before activation. Each update
failure record carries `committed`, so a failure before `current.json`
publication is distinguishable from an activation that needs attention. These
records never contain messages, paths, URLs, tokens, accounts or child output.

Component update orchestration (`Update all components`) uses operation
`component-update` in the same private log. Only failures are recorded:
`plan-blocked` (the check was requested while another update batch holds the
launcher), `plan-discovery` (a component's read-only release discovery failed;
`component` is `backend`, `runtime` or `launcher`, and `status` is present only
when the failure carried an HTTP status) and `apply-blocked` (the update start
was rejected by the activity gate or another running batch). These records never
contain messages, paths, URLs, tokens or accounts, and they never replace the
installer's own `update` failure, start or exit records.

## Package selection

`resolve-package PRODUCT --json --market US` reads public Store metadata without
keyring access or sign-in. Schema 1 returns the root product, market, `status`
(`ready`, `choice`, `unavailable`) and package choices with title, Product ID,
Content ID, platform, package format, kind and support status. A plan is not a
license. Resolution has bounded depth, product count, response size and time;
circular or incomplete graphs fail without guessing a package.

For an unambiguous PC base game, Nexus selects automatically. Otherwise it asks
the user to choose a supported package. `streaming PRODUCT DESTINATION
--selected-content-id UUID --market US` verifies the choice against fresh Store
metadata before requesting the normal authenticated package and license. It
never reads package selection from stdin, which remains reserved for download
controls. Resume preserves the chosen package and market. Update the backend
in Settings if package selection is unavailable.

## Structured downloads

`streaming --progress-json --control-stdin` enables Nexus progress protocol v1.
The CLI emits `NEXUS_PROGRESS ` followed by one JSON object per line. Records
carry `schema`, monotonically increasing `sequence`, `event: "progress"`, `phase`,
`completedBytes`, nullable `totalBytes`, `bytesPerSecond`, `paused` and `canPause`.
Progress updates are throttled; phase/control/terminal transitions are immediate.
Logs remain separate from these prefixed records. A successful process exit AND
a `complete` record are required before the launcher marks installation complete.

Stdin accepts `{"schema":1,"command":"pause"}` and `resume` commands, one per
line. Pause is available during game-file transfer, not metadata/finalization.
It cooperatively closes HTTP streams and checkpoints flushed output; resume opens
validated Range requests without stopping the process or discarding files.

`.nexus-streaming-v1.jsonl` in the destination is an append-only checkpoint
journal, compacted atomically on reopen. Identity includes signed XVD/header data
and the exact file layout. Checkpoints record completed byte offsets and a
SHA-256 boundary digest; they are synced after file data, on pause/completion and
at most every 32 MiB while transferring. After interruption the last unchecked
tail may be downloaded again; this is not a full-file integrity verification.
A changed package, missing/truncated file or mismatched boundary is not resumed
from an unverified offset. An exclusive folder lock prevents concurrent writers.
CDN URLs/credentials are never stored in the journal. Restart refreshes normal
package authentication/URLs, then restores matching checkpoints.

The launcher probes `streaming --help` before enabling these optional features.
Older backends can still download without numeric progress or pause controls.

The backend source, account-free regression tests, package builder and release workflow live in [nexus-backend](https://github.com/domsvoboda/nexus-backend).
`assets/backend-source.lock.json` pins an exact fork commit, Cargo.lock and build-configuration hashes, and the Rust toolchain. No backend patch series is applied by the launcher.

For a local development package:

```sh
node scripts/build-backend.mjs --work ./backend-build --output ./backend-release
```

The wrapper verifies the source pin before delegating to the backend's own builder. See [backend build instructions](https://github.com/domsvoboda/nexus-backend/blob/main/docs/BUILD.md) for dependencies, offline builds and package validation.

The launcher checks stable releases in `domsvoboda/nexus-backend` and retains support for existing compatible packages in `domsvoboda/nexus-launcher`. The source-build version is separate from the minimum installable version, so creating the fork does not require replacing an installed backend or publishing a release. Every package still requires matching checksums, architecture, source archives and command capabilities.

## Electron sign-in host (backend 0.2.3, launcher 0.3.2)

The backend implements the Electron sign-in protocol directly.
The packaged recipe uses `--no-default-features` to build
a CLI without Tao/Wry, GTK or WebKit linkage. All authentication, token exchange
and keychain storage remain in the backend.

The launcher detects the CLI's `--external-webview-stdio` capability before
starting sign-in. It
hosts the Microsoft page in a separate sandboxed, context-isolated Electron
window with no Node or launcher API. Private stdio carries versioned, bounded
UI messages, never a listening port. Initial headers and navigation destinations
are restricted, cookies live only for one attempt, and cancellation cleans up
the window and child process. Protocol messages are not added to UI logs.

Backend 0.2.3 requires launcher 0.3.2 or newer. The source keeps upstream's native
WebKit feature for developers, but public packages use one Electron-hosted path.
Use separate profiles for development and never replace a validated release
artifact. Game compatibility is listed in the compatibility guide.

The keyring activation handler supports KDE systems
that advertise their installed Secret Service under `org.kde.secretservicecompat`
only. It activates that existing user service if the standard Secret Service
name has neither an owner nor an activation provider. Existing/default providers
are left alone. No packages, keyring configuration or plaintext fallback are
introduced, and keyring failures remain errors.

## Incremental game updates

Streaming updates stage one changed file at a time in `.nexus-update-v1` under
its game folder. The space check counts the largest replacement plus net growth
and a metadata reserve, rather than requiring another full installation. A
finished file is synced and atomically renamed; incomplete files and checkpoints
remain available for Retry. The completed package marker changes only after all
files finish. Before the first replacement the backend syncs an
`.nexus-update-incomplete-v1` barrier. A cancelled or failed update retains this
barrier, so the launcher and `run` refuse to start the incomplete installation,
even after queue history is cleared or the launcher restarts. **Resume update**
continues installation and clears the barrier only after the final package
metadata has been committed and synced. This is per-file protection, not
whole-game rollback. The streaming help advertises `update-recovery-v1`;
the launcher requires that capability before updating an installed game.

Matching package page hashes can identify old data even after archive offsets
move. Before reuse, installed plaintext is encrypted in memory with the normal
licensed package key and the new page's XTS parameters, then checked against the
new package's truncated SHA-256. Ciphertext files are checked directly. Modified,
missing, short or unverifiable pages are downloaded using the existing bounded
HTTP transfer path. No keys are written to the update journal. Small reusable
islands between missing pages may also be downloaded to avoid tiny HTTP requests.
This does not implement Microsoft's XSP delta format, and a full download remains
the fallback when no local data verifies.

Nexus shows separate local-reuse and network byte counters. Overall progress and
ETA measure files rebuilt, including local copying; they are not network totals.
Unchanged optional archives retain their existing zero-byte placeholders; updates
do not implicitly install omitted language/content packs. Encrypted executables
still receive the existing truncated-ciphertext repair check.

`cargo test --no-default-features -p xodus-cli -p msixvc streaming_` covers relocated
and corrupt pages, partial staged resumes, licensed plaintext/ciphertext checks,
wrong keys, space accounting, safe replacement, plus existing HTTP/pause/resume
and failure handling. Tests use synthetic fixtures and loopback HTTP only.

## Native social API

The optional `native-social` command provides the account-bound people, profile,
conversation and relationship services alongside the existing `social --json`
interface. Explicit writes use the signed session and are never silently retried.
The launcher exposes these operations through a separate `nativeSocial` IPC API.
Window, party and overlay features register their own authorized senders and lifecycle
callbacks; the API foundation performs no automatic writes.
