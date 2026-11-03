# Nix flake

This flake builds the Xodus Nexus Electron launcher from source and packages the
official prebuilt Nexus Proton runtime separately. Supported system: x86_64-linux.

## Usage

```sh
nix build .#nexus-runtime -L
nix build . -L
nix run .                 # launch from this checkout
nix run .#xodus-nexus     # equivalent explicit app
```

The launcher is built with `buildNpmPackage` and runs its upstream type checks
and tests. The npm dependency hash and runtime archive hash are pinned.

The launcher runs in a private FHS environment for compatibility with the
downloaded upstream CLI and bundled Proton/Wine executables. No system-wide
`programs.nix-ld` setting is required. Graphics drivers still come from the host.

The official runtime is a fixed-output derivation; update its version, release
URL and hash in `nix/runtime.nix` to change releases. The launcher receives
`XODUS_NEXUS_WINE` and uses that binary when validation succeeds. If validation
fails, it falls back to its existing managed runtime discovery. Other launcher
features, including CLI backend downloads, continue to use upstream behavior.

## Install from another flake

```nix
inputs.nexus.url = "github:domsvoboda/xodus-nexus";
```

Then include `inputs.nexus.packages.${pkgs.stdenv.hostPlatform.system}.default`
in `environment.systemPackages` or `home.packages`.

## Notes

- The launcher uses the nixpkgs Electron version, which may differ from the
  version pinned by upstream's npm package.
- The packaged Proton runtime is an upstream prebuilt binary, not a source build.
- Runtime validation and game execution should be tested on real NixOS systems
  with working GPU drivers; successful Nix evaluation alone is insufficient.
- Commit `flake.lock` to pin the nixpkgs revision for reproducible builds.
