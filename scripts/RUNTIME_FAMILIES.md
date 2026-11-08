# Managed runtime families

Per-game runtime selection accepts `default`, `nexus`, or `nexus-cachyos`.
`default` is the Standard family for an unconfigured game. A verified Standard
receipt is used directly; if no managed family is installed yet, the legacy
global runtime remains a migration fallback. An installed CachyOS family is
never the default. The game settings selector lists CachyOS only after installed
payload verification. An absent or invalid selected family fails without
falling back to another family. The selector does not download or install
variants.

## Installed receipt

A family uses `variants/<family>/current.json` beneath the configured runtime
root. Its schema is `1`, with `family`, `sourceRepository`, `sourceCommit`
(40 hexadecimal characters), `buildId` (64 hexadecimal characters), and
`manifestSha256` (64 hexadecimal characters). Repositories are fixed to
`domsvoboda/nexus-runtime` and `domsvoboda/nexus-runtime-cachyos`, respectively.

The receipt identifies `variants/<family>/releases/<buildId>/nexus-family.json`.
This schema-1 manifest repeats the identity fields and binds `arch: "x64"`,
`prefixSchema: 1`, and `sourceLockSha256`. `files` maps every regular payload
file to its SHA-256. Optional `symlinks` maps links to exact relative targets.
The combined inventory must cover every non-directory entry except the manifest
itself. Links must resolve inside the release; executable entry points cannot
be symlinks. The sole external-link exception is the exact template mapping
`files/share/default_pfx/dosdevices/z:` to `/`, recorded without traversal. ARM64 variants require a separate reviewed payload contract.

`XODUS_NEXUS_PATCH.json` belongs to the hashed inventory. Its
`sourceGraph.proton` must equal `sourceCommit`; its `sourceLockSha256` must
match the family manifest. Required launch components include Proton, Wine,
its original loader, wineserver, the runtime compatibility helpers, both Windows
ABIs of XGameRuntime, WinHTTP and nghttp2, and the default prefix template.
A receipt is an installer contract, not a substitute for native candidate gates.

## Local build import

A local build-output directory can be imported from the family card with
**Install from archive**. The directory must contain `candidate.json`, the
family binary archive, its `.sha512sum`, and the corresponding-source archive
with its checksum. The importer verifies the candidate against the fixed family
repository and main source, checks every listed SHA-256 and both SHA-512
checksums, verifies the complete payload and manifest, and writes the normal
family receipt and pointer. The recorded release tag is
`runtime-local-g<commit>` or `runtime-cachyos-local-g<commit>`, so it is never
presented as a published release. No separate profile, runtime root, data root
or game environment is used.

## Family and prefix rules

A selected managed family follows its latest successfully installed verified
build. Every new launch resolves the current family receipt and uses it
directly. The existing prefix and local saves are reused in place. No migration,
copy, transfer or prefix initialization occurs when saving the selection.

A game's prefix location is a durable backend-owned identity stored with the
game record (`runtimePrefixIdentity`). It is captured from the location that the
persisted selection already used, so changing family or updating a family build
selects only the verified runner: no separate-prefix consent, copy, reset, merge
or save migration is involved. A game without an existing prefix uses the
canonical per-game location `compatdata/<gameId>`, with `prefixes/<gameId>` for
its plain Wine root, independent of the chosen family. Existing family and build
prefixes keep their exact paths under `runtime-prefixes/<family>/prefixes/<gameId>/`
and `runtime-prefixes/<family>/<buildId>/<gameId>/`, bound by their recorded
origin rather than by the current family. Unknown, partial or mismatched bindings
and unbound nonempty experimental prefixes fail closed for every runner.
Symlinked prefixes or binding files are refused on experimental layouts with any
runner and on the canonical prefix with a managed runner; the pre-0.5 canonical
default prefix keeps its existing behaviour. A legacy history with several
existing prefixes that the persisted record does not select is refused as well,
with every prefix and save preserved and nothing merged.

## Session rules

Play and VC++ preparation capture one verified runtime and prefix before use.
Stop retains the generated runner and wineserver for that session. Later
selection or pointer changes cannot redirect it. Removal or cleanup must retain
runtime releases referenced by active sessions or retained prefixes.

## Retained builds and rollback

Installers call `retainRuntimeFamilyBuild` before replacing the current receipt.
It verifies the current build, writes an exact retained receipt under
`variants/<family>/receipts/<buildId>.json`, and revalidates that current did not
change before publishing. Reads never synthesize receipts or adopt arbitrary
release directories.

`resolveRuntimeFamily` uses the current receipt for discovery and every new
family launch. `resolveRuntimeFamilyBuild` is an exact retained-build lookup for
rollback and lifetime tooling, not a per-game launch selection. Old build files,
prefixes and saves remain in place while a running session, a retained prefix or
a rollback needs them.

## Verification

Verification streams and hashes the full payload on first resolution or after
invalidation. A bounded in-memory cache compares complete inventory and file
identities (device, inode, mode, link count, size, modification and change times)
on subsequent explicit runtime refresh, capability preview or launch resolution.
Unchanged files are not rehashed. Before/after fingerprints must match; failed
or concurrently changed scans are never cached. Concurrent requests coalesce.
Snapshot reads and ordinary UI renders perform no verification I/O. Identity
checks still walk the tree; large uncached variants may take time to verify.
