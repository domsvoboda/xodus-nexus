{ lib, stdenvNoCC, fetchurl, gnutar, xz }:

let
  version = "11.0-20261020-g8411926d";
  archive = "xodus-nexus-runtime-${version}-x86_64.tar.xz";
in
stdenvNoCC.mkDerivation {
  pname = "xodus-nexus-proton";
  inherit version;
  src = fetchurl {
    url = "https://github.com/domsvoboda/xodus-nexus/releases/download/runtime-${version}/${archive}";
    hash = "sha256-G4IXlaMJNWVwsM2vfx6Fp55RYVM2iz54389QGdAALD4=";
  };
  nativeBuildInputs = [ gnutar xz ];
  dontConfigure = true;
  dontBuild = true;
  unpackPhase = ''
    runHook preUnpack
    mkdir extracted
    tar -xJf "$src" -C extracted
    runHook postUnpack
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    cp -a extracted/xodus-nexus-runtime-*/. "$out/"
    test -f "$out/files/bin/wine"
    runHook postInstall
  '';
  meta = {
    description = "Official prebuilt Xodus Nexus Proton runtime";
    homepage = "https://github.com/domsvoboda/xodus-nexus";
    platforms = [ "x86_64-linux" ];
  };
}
