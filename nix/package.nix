{ lib, buildNpmPackage, electron, buildFHSEnv, coreutils, bash, nodejs, git, gh, gnutar, xz, gzip, findutils, gnugrep, gnused, which, makeWrapper, makeDesktopItem, copyDesktopItems, src, nexusRuntime }:

let
  # Keep upstream's downloaded CLI and Proton/Wine runtime inside a private
  # Linux filesystem layout; no system-wide nix-ld configuration is required.
  runtime = buildFHSEnv {
    name = "xodus-nexus-runtime";
    targetPkgs = pkgs: (with pkgs; [
      stdenv.cc.cc.lib
      openssl
      dbus
      zlib
      glib
      libxcrypt
      libpulseaudio
      alsa-lib
      pipewire
      libudev-zero
      libdrm
      libglvnd
      vulkan-loader
      mesa
      freetype
      fontconfig
      libx11
      libxext
      libxrandr
      libxcursor
      libxi
      libxrender
      libxfixes
      libxcomposite
      libxdamage
      libxinerama
      libxcb
      wayland
      coreutils
      bash
      git
      gh
      gnutar
      xz
      gzip
      findutils
      gnugrep
      gnused
      which
    ]);
    multiPkgs = pkgs: with pkgs; [
      stdenv.cc.cc.lib
      zlib
      libglvnd
      vulkan-loader
      mesa
      alsa-lib
      libpulseaudio
      libdrm
      freetype
      fontconfig
      libx11
      libxext
      libxcb
    ];
    runScript = "${electron}/bin/electron";
  };
in
buildNpmPackage {
  pname = "xodus-nexus";
  version = (builtins.fromJSON (builtins.readFile (src + "/package.json"))).version;
  inherit src;

  npmDepsHash = "sha256-pzVbtFPUAG5tZohuD6cG2+bfK5dtfOP2rVkCav9XRtY=";
  npmFlags = [ "--ignore-scripts" ];

  nativeBuildInputs = [ makeWrapper copyDesktopItems coreutils bash ];

  # Adapt dynamically generated test fixtures to the Nix sandbox.
  postPatch = ''
    find src -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) -print0 |
      while IFS= read -r -d "" file; do
        substituteInPlace "$file" \
          --replace-warn '#!/usr/bin/env node' '#!${nodejs}/bin/node' \
          --replace-warn '#!/bin/sh' '#!${bash}/bin/bash'
      done
    substituteInPlace nix/test-echo \
      --replace-fail '#!/bin/sh' '#!${bash}/bin/bash'
    substituteInPlace src/main/game-wrapper.test.ts \
      --replace-fail ':/usr/bin:/bin' ':${coreutils}/bin:${bash}/bin'
    substituteInPlace src/main/game-shortcuts.test.ts \
      --replace-fail "'/bin/echo'" "'./nix/test-echo'"
  '';
  ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

  # Compile the renderer and Electron main process, without creating an AppImage.
  buildPhase = ''
    runHook preBuild
    export PATH="${coreutils}/bin:${bash}/bin:${nodejs}/bin:$PATH"
    npm run build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/share/xodus-nexus" "$out/bin" "$out/share/icons/hicolor/256x256/apps"
    cp -r dist dist-electron assets package.json "$out/share/xodus-nexus/"
    cp assets/icon.png "$out/share/icons/hicolor/256x256/apps/xodus-nexus.png"
    makeWrapper "${runtime}/bin/xodus-nexus-runtime" "$out/bin/xodus-nexus" \
      --set XODUS_NEXUS_WINE "${nexusRuntime}/files/bin/wine" \
      --add-flags "$out/share/xodus-nexus"
    runHook postInstall
  '';

  desktopItems = [
    (makeDesktopItem {
      name = "xodus-nexus";
      desktopName = "Xodus Nexus";
      exec = "xodus-nexus";
      icon = "xodus-nexus";
      categories = [ "Game" ];
    })
  ];

  meta = {
    description = "Xbox-inspired launcher for Xodus on Linux";
    homepage = "https://github.com/domsvoboda/xodus-nexus";
    license = lib.licenses.mit;
    platforms = [ "x86_64-linux" ];
    mainProgram = "xodus-nexus";
  };
}
