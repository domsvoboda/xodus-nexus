# Runtime contract regressions

The complete pinned clean-checkout recipe (including all prerequisite API
additions) is now available in [`../SHARED_RUNTIME.md`](../SHARED_RUNTIME.md).
Its source lock applies the foundation before the two increments documented
below. These exports are integrated into that development builder, not deployed
or published. The historic candidate hashes below describe the original test;
new builds record their own hashes in `components/source-manifest.json`.

These are native Windows ABI tests for the external xgameruntime component,
not launcher mocks. They do not use a game, Xbox account, network, or saves.
Run them only in a disposable Wine prefix containing the candidate DLL.
Never copy a candidate DLL into an active or production prefix.

`system-device-id-probe.c` checks all five supported XSystem interface versions,
the 45-byte documented unavailable-ID sentinel, optional result length, short
and invalid buffers, repeated queries and the neighbouring console/sandbox APIs.
The runtime does not provide a unique platform device identifier.

- `taskqueue-teardown-probe.c`: composite queue termination must drain its
  callbacks, mark pending callbacks canceled, preserve independent parent work,
  and deliver termination through the completion port (20 checks).
- `taskqueue-contract-probe.c`: four dispatch modes, serialization, shared-port
  monitor notifications, delayed readiness, monitor removal, pending work after
  handle closure, closure inside termination, synchronous cancellation, and
  concurrent submission/termination (1,302 checks; 40,000 racing submissions).
- `async-provider-contract-probe.c`: Begin setup vs provider errors, pending
  work, work errors, missing completion, first-terminal-result wins, private
  provider block, and deleting the user block during immediate completion
  without premature provider cleanup (58 checks).
- `async-completion-lifetime-probe.c`: 400 completions with block deletion,
  result consumption and block reuse, plus a completion canceled by queue
  termination that must still reach the title's callback (2,813 checks). Callback changes for a
  reused block are made **before** Begin, matching the native snapshot contract.
- `async-schedule-probe.c`: uninitialized/null/detached scheduling, valid provider
  work, terminal-state rejection and original failure preservation (16 checks).
  A vectored fault handler records the released DLL's read-0x20 crash without
  opening a debugger. No real game, account, cloud or successful-save claim.
- `winrt-json-probe.c`: real WinRT JSON activation, Parse, GetObject and
  nested array/object access (9 checks). Required by XUser endpoint parsing;
  HTTP 200 alone does not establish successful account initialization.
- `gamesave-files-probe.c`: actual file-provider async completion, retained
  synthetic user, restricted-handle sync child, stable UTF-8 folder, nested
  containers and quota computed from real files (21 checks). Explicit offline
  mode; no real account/network/cloud-success claim. The runner waits for final
  post-exit synchronization before cleaning its disposable prefix.
- `token-dispatch-probe.c`: synthetic delayed authorization failure through
  the real ANSI/UTF-16 token provider; manual Work dispatch must return without
  waiting for authorization. Checks completion and retained user lifetime when
  a terminal abort happens while work is running; includes the gamer-picture
  provider (66 checks, no network/account).
- `store-entitlements-probe.c`: exact runtime receipt validation with ephemeral
  synthetic RSA signatures, nonce/time/audience checks, expired/unrelated license
  rejection and exact licensed SKU metadata. Exercises retained query pages,
  close-in-callback, expiry and nonblocking Manual Work/cancellation through the
  actual async implementation. Its test bridge always fails, with no account or
  network access. Synthetic keys and helpers are never packaged in the runtime.
  Package-license tests reject absent proof, unowned/trial/wrong/expired SKUs;
  check retained result handles, actual expiry events, queued/running unregister,
  reentrant unregister/close and cancellation through the failing bridge.
  Synthetic lifetime fixtures do not change production trust or prove game access.
- `package-content-probe.c`: extracted content registration with matching config,
  Appx identity/version, parent dependency and allowed products; real layout IDs
  and declared file presence, missing payload and DTD rejection, related/publisher
  scopes, callback stop/reentrancy, deduplication and actual runtime COM enumeration.
  Store-ID lookup checks exact identifiers, ambiguity, unknown/unrelated packages,
  missing current-package metadata and buffer boundaries through the real Store ABI.
  Chunk reordering checks installed current/related packages, nested executable
  paths, missing files, invalid layouts/identity, unknown packages and selector
  validation through the real package ABI. Already-installed chunks need no
  reordering; empty package identifiers are rejected, not treated as the current
  package. These checks do not establish a title's startup compatibility.
  Uses only synthetic files in a disposable prefix, without accounts or licensing.
  File presence checks are not a full package-integrity or ownership verification.
- `package-legacy-probe.c`: independent raw x64 COM-slot checks for the legacy
  package interface, current-interface compatibility and reference counts,
  package enumeration, Store-ID lookup and output-buffer boundaries. Unsupported
  install notifications and mounting fail explicitly with cleared outputs.
  Uses synthetic metadata only; does not establish a game's startup compatibility.
- `package-chunks-probe.c`: real package ABI enumeration of numeric chunks,
  deduplicated languages/tags, feature bindings and readable extracted payload.
  Covers destination paths, missing files, callback stop/reentrancy, malformed
  layouts and registration-only packages in a disposable account-free prefix.
- `package-monitors-probe.c`: metadata-backed installation snapshots, initial
  completion-port notification and subsequent availability changes, zero-interval
  query-only snapshots, selector copies, all queue dispatch modes, cancellation,
  queued/running unregister, waiting, and close from inside a callback.
  Byte totals use the SDK unknown-size sentinel for missing payload. Missing files must not report
  completion; the tests do not establish game startup or package ownership.
- `package-progress-bytes-probe.c`: real 64-bit installed file totals from a
  selected synthetic layout, overlapping FileGroups/selectors, empty and sparse
  files, unknown size, invalidated metadata and byte-only progress notifications.
  Counts declared destinations only, without reading file contents or licensing.
- `gamesave-sync-probe.c`: actual save implementation with a closed synthetic
  transport. Checks both provider formats, incomplete transfers, malformed
  metadata, unuploaded-local conflicts, replacement rollback and recovery copies.
  Network and account helpers are test-only stubs. No real saves are accessed.
- `gamesave-transfer-probe.c`: actual upload, close and synchronization helpers
  with two isolated device roots and a closed memory transport. Checks delayed
  completion, overlapping revisions, failed transfers, durable retries and
  session-release notifications without contacting cloud services.
- `user-audio-probe.c`: communication audio endpoint getters and notification
  lifetime using the actual helper, a closed MMDevice source and real task queues.
  Covers Unicode, missing devices, failed initialization, queue cancellation,
  concurrent registration and reentrant unregister, plus the real DLL ABI.
  Does not change default devices or open recording/playback streams.
- `playfab-session-probe.c`: pinned threading ABI checks, asynchronous test-only
  dialog choices, preserved title callbacks, retained synthetic users, caller
  Manual completion queue, genuine upload failure and acknowledged upload before
  SDK cleanup, explicit cloud opt-out and synchronous runtime drain while the
  title's Manual completion port is unpumped (132 checks). Test-only UI choices and synthetic SDK/Core DLLs are
  confined to the probe directory and never staged in the production runtime.
  Does not establish real cloud upload, game shutdown timing or forced-exit sync.

The Store and package-content probes also compile exact Wine XML helpers.
`build-shared-runtime.mjs` builds those with the pinned Wine compiler driver,
Wine CRT headers and UCRT startup/import libraries. Do not link them with plain
MinGW's default legacy MSVCRT plus `-lucrt`: mixing the two CRTs corrupts FILE
arguments on older Ubuntu toolchains. The builder checks both PE import tables
and rejects legacy MSVCRT imports before running the unchanged native tests.

Build the other probes with MinGW against the matching xgameruntime source/generated headers:

```sh
x86_64-w64-mingw32-gcc -D__WINESRC__ -O2 -Wall \
  -I "$XGRT_GENERATED_HEADERS" -I "$XGRT_SOURCE" \
  scripts/runtime-tests/taskqueue-teardown-probe.c -o taskqueue-teardown-probe.exe
x86_64-w64-mingw32-gcc -D__WINESRC__ -O2 -Wall \
  -I "$XGRT_GENERATED_HEADERS" -I "$XGRT_SOURCE" \
  scripts/runtime-tests/taskqueue-contract-probe.c -o taskqueue-contract-probe.exe
x86_64-w64-mingw32-gcc -D__WINESRC__ -O2 -Wall \
  -I "$XGRT_GENERATED_HEADERS" -I "$XGRT_SOURCE" \
  scripts/runtime-tests/async-provider-contract-probe.c -o async-provider-contract-probe.exe
x86_64-w64-mingw32-gcc -D__WINESRC__ -O2 -Wall \
  -I "$XGRT_GENERATED_HEADERS" -I "$XGRT_SOURCE" \
  scripts/runtime-tests/async-completion-lifetime-probe.c -o async-completion-lifetime-probe.exe
x86_64-w64-mingw32-gcc -O2 -Wall \
  scripts/runtime-tests/winrt-json-probe.c -o winrt-json-probe.exe -lruntimeobject
```

Use the candidate Wine runner with an explicitly selected disposable prefix.
Each executable returns nonzero on failure. ABI success does **not** establish
game compatibility, Xbox service availability, or an authenticated EAC session.
These tests do not yet cover registered wait handles, resource-exhaustion paths,
or complete XAsync cancellation semantics.

## WinHTTP transport checks

`run-http2-suite.mjs RUNTIME WORK_PARENT` builds `http2-suite.c` and runs it
against a loopback-only TLS server. It creates a fresh prefix and installs its
temporary CA only there. No game, account, external server or host trust-store
change is involved.

The suite checks HTTP/1.1 and HTTP/2 requests, uploads, redirects, asynchronous
reads and cancellation, certificate-chain ownership and TLS hostname rejection.
Compression checks cover session/request opt-in, unchanged raw responses when
disabled, decoded availability, small reads, large and fragmented bodies,
chunked transfers, malformed/truncated gzip and repeated requests.

## Experimental lifecycle patch

`assets/xgameruntime-taskqueue-lifecycle-experimental.patch` is a diagnostic
increment against the exported shared foundation, applied by the new clean
development builder. Its `xthreading.c`
preimage SHA-256 is
`f70629357efe3cf6c4dcb553fa46dbed2d811f4b4cb403d388936046cc50d5db`.
Do not apply it to a different upstream revision with fuzz. The development
line's prerequisite changes are exported in `xgameruntime-shared-foundation.patch`.

The patch changes queue scheduling/lifetime, not identity tokens, entitlement,
game binaries, or anti-cheat responses. It retains the existing XAsync behavior,
including its unimplemented cancellation; it is not a complete GDK replacement.
Delayed submissions currently wait on the cancellation event in a thread-pool
worker, so timer scaling and allocation/thread-pool failure handling need further
work before release. Keep the known-good runtime available for rollback.

## Experimental XAsync provider patch

`assets/xgameruntime-async-provider-experimental.patch` follows the queue
increment above. Its exact `xthreading.c` preimage SHA-256 is
`f60d1102b9289999ef4198b7ae415d48c7eb8065766982a7b4fbe414823c1c4d`.
It is integrated into the clean development builder, not deployed to production.

The patch reports provider Begin failures through asynchronous completion,
propagates terminal DoWork failures, ignores Complete(E_PENDING), accepts only
the first terminal completion, and supplies runtime-owned provider blocks.
Provider cleanup is deferred until active provider calls return, so the
application can safely delete/reuse its user block inside completion.
These contracts follow Microsoft's libHttpClient `Source/Task/AsyncLib.cpp`.

Known limitations remain: explicit XAsyncCancel is not implemented; state/event
reclamation, full result-identity validation, scheduling guards, and all native
wait/cleanup timing semantics still need work. Passing these focused tests is
not proof of complete XAsync support.

## Applying the exported fix pair

Both patches use paths relative to the **Wine source root**, not the
`dlls/xgameruntime` subdirectory. Apply them in this order, in a separate
development checkout with the prerequisite development changes already present:

1. `assets/xgameruntime-taskqueue-lifecycle-experimental.patch`
2. `assets/xgameruntime-async-provider-experimental.patch`

The exact starting `dlls/xgameruntime/xthreading.c` SHA-256 must be
`f70629357efe3cf6c4dcb553fa46dbed2d811f4b4cb403d388936046cc50d5db`.
After patch 1 it must be
`f60d1102b9289999ef4198b7ae415d48c7eb8065766982a7b4fbe414823c1c4d`;
after patch 2 it must be
`6679fa0c92e40821f53d86037ce7a053e78f5f687c6e80a6d1e0d47c9b8e871b`.
Check these hashes in addition to `git apply --check`. A clean upstream clone
is **not** the required preimage: this pair exports only these two increments.
The source lock separately applies the shared foundation and HTTP/2 changes.
Do not force
application or assume the pair alone reproduces the complete working runtime.

For each patch, with `PATCH` set to its absolute path and the current directory
set to the matching Wine source root:

```sh
git apply --check "$PATCH"
git apply "$PATCH"
sha256sum dlls/xgameruntime/xthreading.c
```

The pair has been replayed against a disposable copy of the exact starting
source and byte-compared with both the intermediate and final source snapshots.
Neither patch changes a game executable, identity token, entitlement, or EAC
attestation response.

## Observed validation and release status

The final candidate DLL SHA-256 is
`ba0c6979ca1eada15d47239d79e7d31925582a0acf03eaee447ee1042e03df6a`.
The four probes above passed 4,185 checks; separate authenticated XUser/Store
tests passed 2,071 checks (6,256 total). The user additionally confirmed entry
into the Gears online lobby and then manually closed the game. No multiplayer
match, long-session stability, cloud-save upload, or other-title compatibility
is established by that test.

The game provider returned E_PENDING from Begin and DoWork. Returning that
failed HRESULT directly from XAsyncBegin was a concrete contract violation:
successful setup must return S_OK while the operation remains pending. This
is the strongest observed explanation for the original Play crash, but the
two increments were tested together, not in a single-change game A/B test.

A separate Wine assertion (`0x80000101`) was recorded after manual exit; its
cause and user-visible impact remain unresolved. It is not the earlier Play
access violation. The pair remains labeled experimental because of this
finding and the incomplete API semantics above. The full clean build integration
is now available; no production deployment, Git commit or push has occurred.

## PlayFab save-folder adapter contract

`playfab-folder-probe.c` builds a synthetic native SDK and storage COM fixture
plus a probe executable. `run-contract-probes.mjs` runs it in the same disposable,
account-free test prefix. It checks caller path/queue/options preservation,
forwarded SDK errors, retry after storage discovery failure, Unicode folders,
the real in-process provider policy (without Windows version claims), and
preservation of explicit provider settings. These fixtures are tests only and
are never bundled as a runtime or used for real games/cloud authentication.

## Token and signature string contract

The token-dispatch fixture also checks signed UTF-8 and UTF-16 results using an
offline IUser that supplies exactly 104 signature characters. Public results
must preserve those characters, append a NUL within the reported buffer size,
and relocate pointers into the caller's result buffer without overwriting it.
These checks use no account or network and do not establish server acceptance.

## Configuration initialization contract

`runtime-init-probe.c` checks inline XML, default-options file discovery and
retry after malformed configuration against the actual runtime DLL. It also
checks the resulting package-local storage identity, so a misleading success
without loading the configuration cannot pass. Three fresh processes use
synthetic configuration and no account/network/cloud. This does not prove a
game's version gate or the cause of an early game exit.
