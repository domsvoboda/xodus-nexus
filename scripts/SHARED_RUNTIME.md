# Shared runtime clean build

Nexus runtime builds on [Xodus Proton](https://github.com/xodus-gaming/Proton)
and Xodus's [Wine](https://github.com/xodus-gaming/wine) /
[XGameRuntime](https://github.com/xodus-gaming/xgameruntime), with additional
Nexus compatibility patches. It is not an independent Wine implementation.

This recipe reconstructs the single shared **development** runtime from clean,
pinned Git checkouts. It includes the PR #28/cloud-save line, subsequent
XUser/Store/license/receipt work, package/network/event/system API
additions, the queue and XAsync fixes, HTTP/2 WinHTTP, nghttp2, WinRT JSON,
and the Mono path-bounds fix. No game-specific runtime selection is introduced.
It also includes initial connectivity notifications, HTTPS/WSS security queries,
GDK WinHTTP options, installed-package metadata, verified Store update queries
and background token/signature authorization. Store queries require Nexus
backend 0.2.1 or newer and currently support the verified current-game no-update
case, not DLC or update installation.

### Licensed Store products

`XStoreQueryEntitledProductsAsync` and its result/enumeration/paging APIs query
the current game's Store ID plus `RelatedProducts` declared in its game config.
The runtime reuses the existing backend 0.2.1+ license-token transport, verifies
Microsoft's RSA signature, certificate, nonce and validity, and exposes only
specific licensed product/SKU pairs. Public catalog data supplies names, product
kinds and developer offer tokens, never ownership. No backend update or
title-specific unlock is involved. Receipt issuance uses the service's signed-in
Store account, not an inferred license from an Xbox profile or installed files.

Network work runs outside the caller's Work dispatcher. Query handles retain
their snapshot across paging and must be closed normally. Failed authentication,
missing metadata and expired receipts remain errors. This implementation requires
online receipt/catalog access; products absent from the game's declared related
list, purchase/download APIs and consumable quantities are not implemented here.

### Installed content packages

Content enumeration also discovers extracted PC add-on packages from disk.
The game config and Appx manifest must agree on identity, publisher, version
and base-package dependency. Allowed parent Store IDs determine the relationship
to the caller, not ownership. A valid layout identifier and files matching its
declared FileGroups must exist. Missing payload, mismatched metadata and DTDs
are rejected. These presence checks are not a full package-integrity audit.

Discovery is bounded to nearby installation directories and the game's `DLC`
directory. Additional roots can be supplied through `XODUS_CONTENT_ROOTS`, using
semicolon-separated absolute Windows paths visible to Wine. Enumeration retains
its snapshot during callbacks, honors early stop and applies current, related
and publisher scopes. `XStoreQueryPackageIdentifier` resolves the current game
or discovered current/related content Store ID to its real package identifier.
Unknown and ambiguous content return `E_INVALIDARG`, with bounded buffer writes.
It neither installs add-ons nor grants a Store license.
The launcher's **Manage content** action handles installation separately. It
intersects config-declared related products with fresh account entitlements and
an unambiguous Windows.Desktop x64 MSIXVC package related to the base family.
The existing backend performs genuine install-time licensing. Completed content
stays in a managed directory outside the base game and is supplied through
`XODUS_CONTENT_ROOTS` after config/Appx/dependency/layout presence checks. Partial
downloads are not supplied. These checks do not claim full payload integrity or
grant ownership; the runtime still verifies fresh signed Store proof. Installed
files remain available for discovery offline, but licensing currently needs
online access. Installation is an explicit per-package user action, not an
automatic download of every owned add-on. Only config-declared related packages
are supported; catalog-only bundles without that relationship remain unsupported.
PublisherContent and content mounting remain unsupported. A real-game test is
still required before claiming that a particular game's DLC works.

### Package license handles

`XStoreAcquireLicenseForPackageAsync` resolves an actually installed current/related
content package and fetches fresh signed Store proof off the Work dispatcher.
Only a matching licensed, downloadable, nontrial Durable SKU produces a handle.
Result retrieval, validity checks and close retain genuine proof/SKU expiration,
separately from the short catalog-query cache lifetime. Invalid, unknown, expired
or unlicensed products remain errors, without inferring ownership from disk.

Package-license lost registrations retain the caller's queue and deliver expiry
notifications on its Completion port. Unregister supports pending callbacks,
waiting, and reentrant unregister/close. This is expiry notification only, not
Microsoft's full account/network/concurrency revocation service. Offline license
acquisition, other acquisition variants and content mounting are not implemented.

### Task-queue ownership

Public queue handles and references held by pending callbacks and dispatchers
are counted separately. Closing all public references leaves pending work alive;
repeated closes cannot consume its internal references. Duplicating a closed or
unknown handle fails. Duplicates retain the existing shared-handle semantics,
so callers must still balance each successful duplicate with one close and
must not reuse stale handles after their storage can have been recycled.

### Game process replacement

`XLaunchNewGame` starts the requested executable in a new desktop process with
UTF-8 paths and arguments, preserving the current directory, package environment
and existing account bridge. The calling process exits normally even if the
request is invalid or the new process cannot start. A selected default user must
be the current retained signed-in user. Switching accounts, mounted DLC transfer
and crash-triggered restarts are unsupported.

### DXVK shader compiler

DXVK is rebuilt at the base runtime's exact revision, with pinned submodules and
build tools from `runtime-dxvk.lock.json`. The DXBC-SPIRV constant-comparison
backport preserves dynamic find-bit comparisons without treating them as
constants. All five x64 DXVK DLLs are supplied together. Compiler unit and
arithmetic regressions run before assembly; a software-Vulkan compute/readback
probe runs in a disposable prefix. These probes do not establish game compatibility.

### App-state subscriptions

App-state and app-constrained subscriptions support registration and
unregistration, including concurrent callers. Desktop processes have no
app-container lifecycle event source, so the runtime does not synthesize
suspend/resume or constrained-state callbacks.

### Configuration bootstrap

Configuration bootstrap also distinguishes inline XML, explicit files and
default discovery. A failed parse does not publish initialized state, and a
subsequent valid initialization can retry. Initializations are serialized.
These fixes do not establish a Gaming Services version or bypass its checks.

Async scheduling also rejects uninitialized/detached and completed blocks
instead of dereferencing absent state. A completed failure retains its original
HRESULT; scheduling never manufactures successful cloud/auth results. A queue
reference protects submission against immediate completion/queue release.

### File-based Xbox game saves

`XGameSaveFilesGetFolderWithUiAsync`, its result and remaining-quota query now
provide ordinary per-user/SCID folders. Full relative parent paths map to cloud
containers; Unicode file names map to blobs. Root-level files are ignored.
The encoded connected-storage cache is separate from the directory games see.
An asynchronous session monitor authenticates the real account, checks its XUID,
downloads saves before returning the folder, holds/renews the cloud lock and
uploads changed/deleted files after the game process exits. Only explicit
`XODUS_SAVE_SYNC=none` (or an unpackaged context) selects local storage; cloud
failures are not silently reported as successful synchronization.

Conflicting local/cloud changes return an actual synchronization error rather
than silently choosing one side. Pre-sync views/cache replacements retain
recovery backups. Conflict UI and backup retention limits are not implemented.
No game names, title-specific selection, fake account or cloud receipt is used.
Cloud roundtrip and exact clean-CI candidate validation remain separate from
the account-free API probe.

### Temporary Gaming Services version override

A runtime-owned bootstrap is enabled by default before materialized game
executables. `NEXUS_GAMING_SERVICES_VERSION_OVERRIDE=0` disables it. It writes
`CurrentVersion` and `AvailableVersion` as REG_QWORD `0x0026007569790000`, decoded
by the native GDK frontend as **38.117.27001.0**. This is an explicitly hardcoded
compatibility workaround, NOT a Microsoft Gaming Services installation, API
implementation, or evidence of equivalent capabilities. No title matching or
launcher modification is involved. It requires an explicit owner-only-write
`WINEPREFIX`. For diagnostics use a disposable test prefix. It overwrites only
the two version values and logs the override, leaving authentication, ownership,
cloud and service/provider settings unchanged. Setting the environment switch to 0
stops further writes but does not undo registry values already stored in that
prefix; discard the disposable prefix or restore its pre-test registry backup.
Do not promote this as a proper Gaming Services implementation.

### PlayFab Game Saves compatibility

The runtime supplies missing stock-UI-equivalent callbacks for the supported
in-process SDK. Device contention, local/cloud conflicts, sync errors and storage
errors are shown in runtime-owned dialog windows on separate threads. Cancel is
the default; save selection and device takeover always require a user choice.
Callbacks supplied by the title are preserved individually, including context.
Successful SDK initialization is not evidence of a successful cloud upload.
Device takeover uses the SDK's `SyncLastSavedData` action: it synchronizes the
last **completed** cloud save, not another device's pending progress. The dialog
shows available pending/completed descriptors and warns that local files can be
replaced. Missing completed-cloud metadata does not establish a usable profile.
The adapter does not automatically recover a local backup or choose a rollback.

Before normal `PFGameSaveFilesUninitializeAsync` cleanup, retained online users
are uploaded through the original SDK with `ReleaseDeviceAsActive`. Cleanup runs
after the real asynchronous upload returns; the caller retains its original
completion queue and receives genuine upload/cleanup failures. Failed/offline
AddUser operations and explicit `XODUS_SAVE_SYNC=none` do not trigger the extra
final upload.

The synchronous runtime `UninitializeApiImpl` additionally drains this SDK
session outside the loader lock before returning, including a cleanup already
started asynchronously by the title. SDK cleanup itself remains asynchronous;
no caller Manual completion callback is required for the in-flight drain.
Games that terminate without calling runtime uninitialization are not covered.
This is not a `DllMain` network wait or an `ExitProcess` hook.
This does not cover abrupt process termination
or games that omit SDK cleanup: local files remain, and a later session may need
the device-contention/conflict dialog. Never interpret forced termination as an
acknowledged cloud upload, nor silently resolve a conflict or discard progress.

`XUserGetGamerPictureAsync` resolves the profile using contract version 2 and
the endpoint's genuine proof-of-possession signature, then downloads the image
without forwarding Xbox credentials to the CDN. Authorization, HTTP and image
download work runs off the caller's Work dispatcher, with retained user/context
lifetime and completion on the requested queue. Network/auth failures remain
real failures, not replacement images or fabricated success. Contract reference:
[Microsoft Profile API](https://learn.microsoft.com/en-us/gaming/gdk/docs/reference/live/rest/uri/profilev2/uri-usersbatchprofilesettingspost).

Signed `XUserGetTokenAndSignature` results retain all 104 signature characters
and include a trailing NUL in the returned buffer and size, for both UTF-8 and
UTF-16. This avoids reading past the signature while building HTTP headers.
It does not bypass server-side entitlement or signature verification.

The runtime includes a native SDK forwarding adapter, not a replacement cloud
service. In an owner-private Xodus materialized launch view, its Wine entry point
detects the supported x64 `PlayFabGameSave.dll` export contract and retains the
game's original SDK as `nexus_pgs_native.dll`. The adapter supplies a missing
`saveFolder` from the current package's `XPersistentLocalStorage` root, with a
`PlayFabGameSaves` child. Caller-specified folders, queue/options, authentication,
cloud operations and genuine SDK errors are preserved. UTF-8 paths are created
through Unicode Windows APIs. Exports unrelated to UI/session lifecycle forward
unchanged.
For an omitted folder, the adapter defaults the upstream SDK's recognized
`ForceUseInprocGameSaves` policy to 1 only if absent. An explicit existing policy
is preserved; no `CurrentVersion`/`AvailableVersion` claims are provisioned.

Owner-created temporary views with umask-derived read permissions (such as
0755) are sealed to 0700 before staging; other-user-writable or symlinked views
remain untouched. NEXUS_BOOTSTRAP_DIAGNOSTICS=1 reports only staging counts.

No game names/product IDs, original-file edits, import hooks, diagnostic version
QWORDs or proprietary SDK binaries are included. Unsupported SDK exports are
left unchanged with a diagnostic; staging failures abort rather than partially
launch. `NEXUS_PLAYFAB_ADAPTER=0` disables staging for diagnosis. Ordinary Wine
commands and launches outside private Xodus views go to the unchanged loader.
This does **not** implement Microsoft Gaming Services or its version gate, nor
claim all PlayFab SDK versions, cloud-save roundtrips or all-title compatibility.
The separate temporary Gaming Services version metadata workaround is described
above; it is not an installed Microsoft service or part of the cloud-session UI.

## Build

Requirements: Linux x86-64, Node 22+, Git, GCC/G++/Make, MinGW-w64 x86-64 C/C++, glslang,
CMake, autoconf, flex, bison, Perl, Python 3, file, curl, GStreamer development
headers, and Wine build prerequisites (including freetype/GnuTLS development
packages). See the workflow's apt list.
Native tests additionally require pgrep, OpenSSL, a working Proton loader and
its host libraries. The graphics probe requires Mesa lavapipe software Vulkan.
CI uses Xvfb; desktop tests can use the current display.

```sh
node scripts/build-shared-runtime.mjs \
  --work /absolute/path/to/new-build-directory --jobs 4 \
  --base-runtime /absolute/path/to/pristine-proton-directory
```

The work directory **must not already exist**. Without `--base-runtime`, the
script builds components and probes only. A base is an extracted official
Proton distribution containing `proton`, `files/bin/wine` and its default
prefix, not a game prefix. A complete build downloads the exact FFmpeg source
archive locked in [`runtime-media.lock.json`](runtime-media.lock.json), verifies
its SHA-256, and builds LGPL shared decoder libraries. `--media-archive` accepts
the same verified tarball for offline builds. The script does not download or
install games, authenticate, switch the active runtime, or edit the base.

The source lock is [`runtime-patches.lock.json`](runtime-patches.lock.json).
It pins Wine b1dd3273, xgameruntime 64aebcab, nghttp2 85e300c7/v1.70.0 and
the base Proton's external vkd3d 2.0 (be62407e) with its Vulkan/SPIR-V headers,
plus SHA-256 for every applied patch and all modified/added runtime
source files. After patching, those files must match their locked source hashes.
The parent lock also binds `runtime-dxvk.lock.json`, which pins DXVK, compiler,
headers and build tools. No fuzz or automatic latest-upstream fallback is allowed.

Optional `--wine-mirror`, `--xgameruntime-mirror`, `--nghttp2-mirror`,
`--vkd3d-mirror`, `--vulkan-headers-mirror` and `--spirv-headers-mirror`
arguments supply local Git object repositories for those source inputs. DXVK
inputs are fetched separately at their locked commits. These options do
**not** copy dirty working-tree files, headers, DLLs, or build directories.
The same pinned commits are fetched into fresh empty checkouts and verified.

For CI parity, use the exact Xodus Proton archive pinned in
[`runtime-base.lock.json`](runtime-base.lock.json), not an arbitrary installed
Steam Proton. Its SHA-512, version and Wine/wineserver hashes are locked.
After extracting the verified archive, check the base before assembly:

```sh
node scripts/verify-runtime-base.mjs /absolute/path/to/extracted-proton
```

GitHub uses the same locked archive. There is no `latest` or alternate-base
fallback; changing it requires a reviewed lock update and new verification.
The supplied-base option remains available for isolated development tests,
but those results are not automatically evidence for the CI distribution.

Output:

- `components/`: newly built xgameruntime, winhttp, mscoree, libnghttp2, windows.web, twinapi.appcore, libvkd3d-shader-1 and five x64 DXVK DLLs,
  licenses and a source/patch/toolchain/component checksum manifest.
- `media/`: pinned FFmpeg 4.4.8 source archive, LGPL build, six shared
  libraries, configure options and checksums. The archive accompanies the
  distributed runtime source package.
- `tests/`: native ABI, WinRT JSON and HLSL compiler regression probes.
- `runtime/`: a **new copy** of the supplied Proton base with the twelve DLLs
  installed in both runtime and default-prefix locations, plus provenance.

The base Wine/Unix loader and other Proton components are supplied by that
distribution, not rebuilt here. Its GStreamer `libgstlibav.so` requires FFmpeg
4.x ABI libraries missing from the base snapshot. Nexus now builds and bundles
matching LGPL `libavcodec.so.58`, `libavformat.so.58`, `libavfilter.so.7`,
`libavutil.so.56`, `libswresample.so.3` and `libswscale.so.5` in the one shared
runtime. This introduces no per-game rule or dependency on host FFmpeg. The
FFmpeg build disables GPL/nonfree components and installs its license in the
runtime. CI builds these media libraries on Ubuntu 22.04 and rejects a
glibc requirement above 2.35; a local build on a newer distribution is only
diagnostic and must not be released as the portable artifact. Other optional
Proton plugins may still lack unrelated dependencies;
this work verifies H.264/AAC decoding, not universal media support.
Pin/checksum the base archive as well when
distributing a complete runtime. Reproducible source reconstruction does not
claim byte-identical DLLs across paths or toolchain versions; DWARF paths,
toolchains, and PE timestamps/build IDs can differ. Tool versions and output
hashes are recorded. The original working candidate stays available.

### arm64 (experimental)

Nexus's runtime changes are overlays on a Proton base, so an arm64 runtime
uses a different base and an extra PE build, not a port. The base is
[CachyOS Proton arm64](https://github.com/CachyOS/proton-cachyos), pinned by
tag, archive SHA-512 and loader hashes in
[`runtime-base-arm64.lock.json`](runtime-base-arm64.lock.json); it is the
lineage ArmadaOS ships. Its layout differs from the x86_64 snapshot:
`files/bin-arm64/{wine,wineserver}`, `files/share/default_pfx_arm64`, ARM64X
hybrid modules in `files/lib/wine/aarch64-windows` and a prefix whose
`system32` is ARM64X and `syswow64` is i386 (x86_64 games run through
ARM64EC/FEX, which the base bundles). The launcher detects that layout
(`src/main/proton-layout.ts`) and reads per-architecture overlay checksums
from `componentsByArch` in `XODUS_NEXUS_PATCH.json`.

[`arm64/build-components.sh`](arm64/build-components.sh) builds the overlay
set on an arm64 Linux host (`ubuntu-24.04-arm` in
`.github/workflows/runtime-arm64.yml`): it reuses
`build-shared-runtime.mjs --prepare-only` for the exact pinned checkouts and
patches, fetches an llvm-mingw release (clang + lld with ARM64EC support),
configures the patched Wine with `--enable-archs=aarch64,arm64ec` and builds
`xgameruntime`, `winhttp`, `mscoree`, `windows.web`, `twinapi.appcore` and
`d3dcompiler_47` as ARM64X hybrids, plus nghttp2 and vkd3d-shader as ARM64EC
(`--host=aarch64-w64-mingw32` with the `arm64ec-w64-mingw32-*` tools, since
config.sub does not know arm64ec). `d3dcompiler_47` is part of the set because
the arm64 base links vkd3d-shader into it statically, so the HLSL
state-keyword patch cannot travel in `libvkd3d-shader-1.dll` there. Machine
types are verified (ARM64X reports ARM64; ARM64EC reports AMD64 and is told
apart by its CHPE load-config metadata), the overlays are installed into
`aarch64-windows` and `default_pfx_arm64/.../system32`, and a smoke test boots
a fresh prefix with the arm64 Wine and runs an arm64 and an x86_64 probe that
load the overlaid `xgameruntime.dll`. Not yet done: assembly through
`assemble-shared-runtime.mjs` (aarch64 host shim and FFmpeg libraries, ARM64X
DXVK, both PE sets), a release job, and on-device verification.

## Patch sequence

1. `xgameruntime-shared-foundation.patch`: complete development-line delta
   from pinned xgameruntime 64aebcab, **before** the last two threading fixes.
   This incorporates PR #28 and the additional cloud-save/auth/Store/API work.
2. `xgameruntime-taskqueue-lifecycle-experimental.patch`.
3. `xgameruntime-async-provider-experimental.patch`.
4. `wine-winhttp-http2.patch`: transport plus portable header paths.
5. `wine-winhttp-private-diagnostics-disabled.patch`: disables activation of
   the legacy body-fragment scanner, which could expose token fragments.
6. `wine-mscoree-mono-path-bounds.patch`.

`windows.web.dll` is built from the pinned Wine sources without an additional
patch. This is required: the supplied stock Proton can have a stub JSON parser
which returns E_NOTIMPL after a successful HTTP response, preventing XUser
authentication and cloud-save synchronization. Do not rely on a dependency
DLL left in a previous runtime or on old absolute prefix symlinks.

The foundation supersedes the older piecemeal XGameRuntime preview patches
**for this recipe only**. Do not apply those again on top. They remain in
assets for historical builders/upstream discussions. Preserve attribution
and LGPL notices in sources; nghttp2 is MIT-licensed. The EAC bridge remains
an external official Steam tool discovered via `PROTON_EAC_RUNTIME`; it is
not replaced, fabricated, or redistributed by this recipe. Real Xodus account
and license service functionality is a separate backend requirement.

## Verification

Task-queue contract probes cover repeated termination both before and after
draining, independent callback contexts, manual completion dispatch, and a
synchronous request waiting for its own callback after an earlier termination.

Close any games/downloads before running stress tests. These commands make
fresh private prefixes and stop only their own wineservers. They never copy
credentials or saves. The HTTP/2 suite binds a loopback TLS server and trusts
its temporary test CA only in its own disposable prefix.

```sh
node scripts/runtime-tests/run-contract-probes.mjs \
  /absolute/build/runtime /absolute/build/tests /absolute/build
node scripts/runtime-tests/run-http2-suite.mjs \
  /absolute/build/runtime /absolute/build
node scripts/runtime-tests/run-media-suite.mjs \
  /absolute/build/runtime /absolute/build/media-tests
node scripts/runtime-tests/run-dxvk-suite.mjs \
  /absolute/build/runtime /absolute/build
npm run typecheck
npm test
npm run test:runtime-tools
```

Expected contract checks: queue teardown 20, queue stress 1,302, XAsync
provider 116, completion lifetime 2,805, scheduling 16, file saves 21,
WinRT JSON 9, token dispatch/lifetime 88, Store entitlements/licenses 181, installed
content 274, PlayFab folder/session 153 and initialization 19 (5,004 total),
plus 64 game-process replacement checks, 40 software-Vulkan compute checks,
and HTTP/1.1 and HTTP/2 transport, certificate-chain and response-decompression
checks. The JSON probe exercises real activation, parsing,
object access and nested array/object access without account data or network.
The token-dispatch probe uses a synthetic delayed failure, not a real identity
or token. ABI/transport tests are not a substitute for a game test: test the clean-build
candidate in a separate prefix before promotion, without overwriting the
known-working runtime.

The media suite checks that GStreamer's libav plugin resolves FFmpeg only from
the bundled runtime and registers H.264/AAC decoders. This is media evidence,
not a sign-in or game-compatibility claim. The DXVK build runs upstream compiler
unit tests and the dynamic find-bit comparison regression before copying DLLs.

Launcher provisioning installs checksum-verified nghttp2, windows.web,
twinapi.appcore and libvkd3d-shader-1 DLLs
into existing prefix system32 locations when their runtime capabilities are
present, and selects the builtin WinHTTP transport. All component checksums
are checked before replacing any entries. This is generic provisioning, not
a per-game rule.

## Limits and publication

Some package/event APIs are partial accept registrations; absence of
E_NOTIMPL does not mean full GDK semantics. XAsyncCancel/resource reclamation
remain incomplete. Some existing privilege/package answers are assumptions,
not verified account grants or support for partial/chunk installations.
HTTP/2 uses one stream per connection and has gaps for chunked uploads,
multiplexing, proxies and client certificates. The assertion observed after
manual game exit (`0x80000101`) remains unresolved. No universal game support,
multiplayer-match stability or cloud-save upload is claimed by these probes.

The workflow now uses this clean recipe, verifies the assembled candidate,
and includes corresponding source, checksums and licenses. It uses an exact
Proton snapshot archive from the base lock; expired official artifacts fail
rather than silently changing the base. Component artifacts are uploaded before snapshot lookup,
so a missing base does not lose the clean build. Default publication is off;
`publish=true` is rejected while the lock is marked `development`. Local
verification does not claim that a remote GitHub Actions run has succeeded.
