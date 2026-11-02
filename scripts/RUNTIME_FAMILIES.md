# Managed runtime families

Per-game runtime selection accepts `default`, `nexus`, or `nexus-cachyos`.
The default keeps the global runtime and existing prefix locations. The game
settings selector lists other families only after installed payload verification.
An absent or invalid selected family fails without falling back to the default.
The selector does not download or install variants.

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
be symlinks. ARM64 variants require a separate reviewed payload contract.

`XODUS_NEXUS_PATCH.json` belongs to the hashed inventory. Its
`sourceGraph.proton` must equal `sourceCommit`; its `sourceLockSha256` must
match the family manifest. Required launch components include Proton, Wine,
its original loader, wineserver, the runtime compatibility helpers, both Windows
ABIs of XGameRuntime, WinHTTP and nghttp2, and the default prefix template.
A receipt is an installer contract, not a substitute for native candidate gates.

## Prefix and session rules

Selecting a managed family requires an explicit separate-prefix choice. Its
prefix lives under `runtime-prefixes/<family>/<buildId>/<gameId>/`, separately
from default `compatdata/<gameId>` and `prefixes/<gameId>`. Existing local saves
stay in their old prefix. No copying, transfer or prefix initialization occurs
when saving the selection. Unknown or mismatched prefix bindings fail closed.

Play and VC++ preparation capture one verified runtime and prefix before use.
Stop retains the generated runner and wineserver for that session. Later
selection or pointer changes cannot redirect it. Removal or cleanup must retain
runtime releases referenced by active sessions or retained prefixes.

Verification currently streams and hashes the full payload on explicit runtime
refresh, capability preview and launch resolution. Snapshot reads and ordinary
UI renders do not scan the payload. Large installed variants may make those
explicit operations slower; no verification cache or performance claim is made.
