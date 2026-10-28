#!/usr/bin/env bash
# Xodus Nexus user installer.
#
# One-liner (once the repository is public):
#   curl -fsSL https://raw.githubusercontent.com/domsvoboda/xodus-nexus/main/scripts/install.sh | bash
#
# What it does, without further input:
#   1. Installs system prerequisites with your package manager (skip with
#      XODUS_NEXUS_SKIP_DEPS=1): backend sign-in and Electron runtime libraries.
#      Rust/Cargo/protoc are not needed for the prebuilt backend.
#   2. Downloads the latest Xodus Nexus AppImage from GitHub Releases.
#   3. Installs it to ~/.local/opt/xodus-nexus, links it into ~/.local/bin
#      and registers a desktop entry with the app icon.
#
# Environment overrides:
#   XODUS_NEXUS_SKIP_DEPS=1       do not touch system packages
#   XODUS_NEXUS_APPIMAGE=<file>   install a local AppImage instead of downloading
set -euo pipefail

REPO="domsvoboda/xodus-nexus"
PREFIX="${XODUS_NEXUS_PREFIX:-$HOME/.local}"
APP_DIR="$PREFIX/opt/xodus-nexus"
BIN_DIR="$PREFIX/bin"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
LOCAL_APPIMAGE="${XODUS_NEXUS_APPIMAGE:-}"
SKIP_DEPS="${XODUS_NEXUS_SKIP_DEPS:-0}"
AS_INSTALLER=0
[[ "${1:-}" == "--skip-deps" ]] && SKIP_DEPS=1
[[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && AS_INSTALLER=1

if [[ $AS_INSTALLER -eq 1 ]]; then
  sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m -> %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Linux" ]] || die "This installer supports Linux only."
case "$(uname -m)" in
  x86_64) APPIMAGE_ARCH=x86_64 ;;
  aarch64) APPIMAGE_ARCH=arm64 ;;
  *) die "Only x86_64 and aarch64 builds are published." ;;
esac
command -v curl >/dev/null || die "curl is required to run this installer."

# ---------------------------------------------------------------- system deps
install_deps() {
  local root="$1"; shift
  if [[ $EUID -eq 0 ]]; then
    "$root" "$@"
  elif command -v sudo >/dev/null; then
    sudo "$root" "$@"
  else
    warn "No sudo available; install these packages yourself: $*"
    return 0
  fi
}

if [[ $SKIP_DEPS -eq 1 ]]; then
  warn "Skipping system packages (XODUS_NEXUS_SKIP_DEPS=1)."
else
  source /etc/os-release 2>/dev/null || true
  distro="${ID:-unknown}"
  case "${ID_LIKE:-}" in
    *arch*) distro=arch ;;
    *debian*) distro=debian ;;
    *fedora*) distro=fedora ;;
  esac
  case "$distro" in
    arch)
      log "Installing prerequisites with pacman (Arch/CachyOS)…"
      install_deps pacman -S --needed --noconfirm \
        curl tar xz fuse2 \
        webkit2gtk-4.1 gtk3 nss libxtst desktop-file-utils || warn "Some packages failed to install; continuing."
      ;;
    debian)
      log "Installing prerequisites with apt (Debian/Ubuntu)…"
      install_deps apt-get update -y || true
      # Newer distributions renamed some shared libraries for the time64 ABI.
      nexus_fuse=libfuse2; nexus_gtk=libgtk-3-0; nexus_alsa=libasound2
      if apt-cache show libfuse2t64 >/dev/null 2>&1; then nexus_fuse=libfuse2t64; fi
      if apt-cache show libgtk-3-0t64 >/dev/null 2>&1; then nexus_gtk=libgtk-3-0t64; fi
      if apt-cache show libasound2t64 >/dev/null 2>&1; then nexus_alsa=libasound2t64; fi
      install_deps apt-get install -y \
        curl tar xz-utils "$nexus_fuse" libwebkit2gtk-4.1-0 \
        "$nexus_gtk" libnss3 libxtst6 "$nexus_alsa" desktop-file-utils || warn "Some packages failed to install; continuing."
      ;;
    fedora)
      log "Installing prerequisites with dnf (Fedora)…"
      install_deps dnf install -y \
        curl tar xz fuse \
        webkit2gtk4.1 gtk3 nss libXtst alsa-lib desktop-file-utils || warn "Some packages failed to install; continuing."
      ;;
    *)
      warn "Unknown distribution '$distro'; install these before first run:"
      warn "  curl tar xz fuse2 webkit2gtk-4.1 gtk3 nss libxtst"
      ;;
  esac
fi

# ------------------------------------------------------------------ AppImage
mkdir -p "$APP_DIR" "$BIN_DIR" "$DESKTOP_DIR"
target="$APP_DIR/Xodus-Nexus.AppImage"

if [[ -n "$LOCAL_APPIMAGE" ]]; then
  [[ -f "$LOCAL_APPIMAGE" ]] || die "XODUS_NEXUS_APPIMAGE points to a missing file: $LOCAL_APPIMAGE"
  log "Installing local AppImage: $LOCAL_APPIMAGE"
  install -m 0755 "$LOCAL_APPIMAGE" "$target"
else
  log "Finding the latest release…"
  release_json="$(curl -fsSL --max-time 30 "https://api.github.com/repos/$REPO/releases/latest" \
    || die "Could not reach GitHub. Check your connection, or download the AppImage manually from https://github.com/$REPO/releases")"
  download_url="$(printf '%s\n' "$release_json" \
    | grep -o "\"browser_download_url\": *\"[^\"]*-$APPIMAGE_ARCH\.AppImage\"" \
    | head -n1 | sed 's/.*"\(https[^"]*\)".*/\1/')"
  [[ -n "$download_url" ]] || die "No AppImage found in the latest release. Publish a release first (npm run dist), or set XODUS_NEXUS_APPIMAGE=<file>."
  log "Downloading $(basename "$download_url")…"
  curl -fSL --retry 3 --max-time 600 -o "$target.part" "$download_url"
  chmod 0755 "$target.part"
  mv "$target.part" "$target"
fi

log "Installing application files…"
if [[ -f "$APP_DIR/icon.png" ]]; then rm -f "$APP_DIR/icon.png"; fi
curl -fsSL --max-time 30 -o "$APP_DIR/icon.png" \
  "https://raw.githubusercontent.com/$REPO/main/assets/icon.png" \
  || warn "Could not download the icon; the desktop entry will use a generic icon."

ln -sf "$target" "$BIN_DIR/xodus-nexus"

cat > "$DESKTOP_DIR/xodus-nexus.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Xodus Nexus
Comment=Open-source Xbox-inspired game launcher
Exec=$BIN_DIR/xodus-nexus %U
Icon=$APP_DIR/icon.png
Terminal=false
Categories=Game;
StartupWMClass=xodus-nexus
EOF
command -v update-desktop-database >/dev/null && update-desktop-database "$DESKTOP_DIR" || true

case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) warn "Add $BIN_DIR to PATH to run 'xodus-nexus' from a terminal (usually already in ~/.profile)." ;;
esac

log "Xodus Nexus installed."
cat <<'EOF'

First run:
  1. Start Xodus Nexus from your application menu (or: xodus-nexus).
  2. In Settings -> Xodus backend, click Install backend.
     This downloads and verifies our patched, prebuilt Xodus backend; no compiler needed.
  3. In Settings -> Nexus runtime, click Install Nexus runtime.
     This downloads our prebuilt runtime from GitHub Releases - no login,
     no compilation. The upstream snapshot and local source-build options are
     under Advanced / Diagnostics and are not needed for normal installation.
  4. Sign in via Xodus, then browse the Store and install your games.
EOF
