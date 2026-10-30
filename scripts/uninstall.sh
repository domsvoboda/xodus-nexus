#!/usr/bin/env bash
# Remove the application-menu installation made by scripts/install.sh.
# Games, saves, settings, downloaded runtimes and wallet credentials are kept.
set -euo pipefail

nexus_dry_run=0
case "${1:-}" in
  --dry-run) nexus_dry_run=1 ;;
  -h|--help)
    cat <<'EOF'
Usage: uninstall.sh [--dry-run]

Close Nexus and its games before uninstalling. No sudo is needed.
Removes the installer-managed AppImage, its updater backups, icon, command
symlink and application-menu entry. All user data and system packages are kept.
For a custom installation, use the same XODUS_NEXUS_PREFIX and XDG_DATA_HOME
values that were used with install.sh. --dry-run only lists matching files.
EOF
    exit 0 ;;
  '') ;;
  *) printf 'Unknown option: %s\n' "$1" >&2; exit 1 ;;
esac
[[ $# -le 1 ]] || { printf 'Expected at most one option.\n' >&2; exit 1; }

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
warn() { printf 'Kept: %s\n' "$*" >&2; }
[[ -n "${HOME:-}" ]] || die 'HOME must be set.'
nexus_prefix="${XODUS_NEXUS_PREFIX:-$HOME/.local}"
nexus_data="${XDG_DATA_HOME:-$HOME/.local/share}"
[[ "$nexus_prefix" == /* && "$nexus_data" == /* ]] || die 'Installation paths must be absolute.'
nexus_prefix="$(realpath -m -- "$nexus_prefix")"
nexus_data="$(realpath -m -- "$nexus_data")"
nexus_app="$nexus_prefix/opt/xodus-nexus"
nexus_image="$nexus_app/Xodus-Nexus.AppImage"
nexus_command="$nexus_prefix/bin/xodus-nexus"
nexus_desktop_dir="$nexus_data/applications"
nexus_desktop="$nexus_desktop_dir/xodus-nexus.desktop"
[[ ! -L "$nexus_app" ]] || die "The application directory is a symlink: $nexus_app"

# Do not race an in-app update, and never terminate a running process.
nexus_lock="$nexus_image.nexus-update.lock"
if [[ -e "$nexus_lock" || -L "$nexus_lock" ]]; then
  [[ -f "$nexus_lock" && ! -L "$nexus_lock" && -O "$nexus_lock" ]] || die 'Unsafe launcher update lock.'
  nexus_pid=''
  IFS= read -r nexus_pid < "$nexus_lock" || true
  [[ "$nexus_pid" =~ ^[1-9][0-9]*$ ]] || die 'Invalid launcher update lock.'
  if kill -0 "$nexus_pid" 2>/dev/null; then die 'A launcher update is active. Close Nexus and retry.'; fi
fi

nexus_removed=0
remove_file() {
  local file="$1"
  [[ -e "$file" || -L "$file" ]] || return 0
  if [[ -d "$file" && ! -L "$file" ]]; then warn "directory $file"; return 0; fi
  if [[ "$(stat -c '%u' -- "$file")" != "$EUID" ]]; then warn "file owned by another user: $file"; return 0; fi
  if [[ "$nexus_dry_run" -eq 1 ]]; then
    printf 'Would remove: %s\n' "$file"
  else
    rm -f -- "$file"
    printf 'Removed: %s\n' "$file"
  fi
  nexus_removed=$((nexus_removed + 1))
}

if [[ -L "$nexus_command" ]]; then
  if [[ "$(realpath -m -- "$nexus_command")" == "$nexus_image" ]]; then remove_file "$nexus_command"
  else warn "unrelated command link $nexus_command"; fi
elif [[ -e "$nexus_command" ]]; then
  warn "command not created by the installer: $nexus_command"
fi
if [[ -f "$nexus_desktop" && ! -L "$nexus_desktop" ]]; then
  if grep -Fxq -- 'Name=Xodus Nexus' "$nexus_desktop" &&
     grep -Fxq -- "Exec=$nexus_prefix/bin/xodus-nexus %U" "$nexus_desktop" &&
     grep -Fxq -- "Icon=$nexus_app/icon.png" "$nexus_desktop"; then
    remove_file "$nexus_desktop"
  else warn "application entry not matching this installation: $nexus_desktop"; fi
elif [[ -e "$nexus_desktop" || -L "$nexus_desktop" ]]; then
  warn "application entry not created by the installer: $nexus_desktop"
fi

remove_file "$nexus_image"
remove_file "$nexus_image.part"
remove_file "$nexus_app/icon.png"
remove_file "$nexus_lock"
shopt -s nullglob
for nexus_file in "$nexus_image".nexus-backup-* "$nexus_image".nexus-update-*; do
  # Only the UUID filenames written by the updater belong to this installation.
  if [[ "${nexus_file##*/}" =~ ^Xodus-Nexus\.AppImage\.nexus-(backup|update)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]]; then
    remove_file "$nexus_file"
  fi
done
if [[ "$nexus_dry_run" -eq 0 ]]; then
  if [[ -d "$nexus_app" ]]; then rmdir -- "$nexus_app" 2>/dev/null || warn "additional files in $nexus_app"; fi
  if [[ -d "$nexus_desktop_dir" ]] && command -v update-desktop-database >/dev/null; then
    update-desktop-database "$nexus_desktop_dir" || true
  fi
fi
if [[ "$nexus_removed" -eq 0 ]]; then printf 'No installer-managed application files found.\n'; fi
printf 'Games, saves, settings, runtimes, wallet credentials and system packages were kept.\n'
