#!/bin/sh
set -eu

# dpkg preserves an existing directory's mode during an in-place upgrade.
# OpenMausBot 0.1.7 installed the application ancestors as 0775, which makes
# the bundled Cua Driver correctly reject its own executable path. A configured
# DEB also needs Electron's Chromium sandbox to be root-owned and setuid. Repair
# only the exact package-owned paths; never weaken a runtime validator and never
# ask an end user to run chmod manually.
#
# This hook replaces electron-builder's default after-install, so it must also
# carry the template behaviors the default would have provided: the /usr/bin
# link, the desktop/mime database refresh, and the AppArmor profile install.
# The AppArmor profile is load-bearing on Ubuntu 24.04: the kernel denies
# user namespaces to unconfined apps, and without the bundled profile
# Chromium falls back to the setuid sandbox helper, whose zygote launch
# splits the install path at its space (electron/electron#44414) and kills
# the renderer with "LaunchProcess: failed to execvp: /opt/Dani".
if [ -n "${OPENMAUSBOT_POSTINSTALL_TEST_ROOT:-}" ]; then
  TEST_ROOT="$(realpath -e -- "$OPENMAUSBOT_POSTINSTALL_TEST_ROOT")"
  case "$TEST_ROOT" in
    /tmp/*) APP_ROOT=$TEST_ROOT ;;
    *)
      echo "Dani Bot test install root must stay under /tmp" >&2
      exit 1
      ;;
  esac
  EXPECTED_OWNER="$(id -un):$(id -gn)"
  TEST_MODE=1
else
  APP_ROOT="/opt/Dani Bot"
  EXPECTED_OWNER=root:root
  TEST_MODE=0
fi

repair_directory() {
  target=$1
  if [ -L "$target" ] || [ ! -d "$target" ]; then
    echo "Dani Bot package directory is missing or unsafe: $target" >&2
    exit 1
  fi
  if [ "$TEST_MODE" -eq 0 ]; then chown root:root -- "$target"; fi
  chmod 0755 -- "$target"
  actual="$(stat -c '%U:%G:%a' -- "$target")"
  if [ "$actual" != "$EXPECTED_OWNER:755" ]; then
    echo "Dani Bot could not secure package directory: $target ($actual)" >&2
    exit 1
  fi
}

repair_executable() {
  target=$1
  if [ -L "$target" ] || [ ! -f "$target" ]; then
    echo "Dani Bot package executable is missing or unsafe: $target" >&2
    exit 1
  fi
  if [ "$TEST_MODE" -eq 0 ]; then chown root:root -- "$target"; fi
  chmod 0755 -- "$target"
  actual="$(stat -c '%U:%G:%a' -- "$target")"
  if [ "$actual" != "$EXPECTED_OWNER:755" ]; then
    echo "Dani Bot could not secure package executable: $target ($actual)" >&2
    exit 1
  fi
}

repair_chromium_sandbox() {
  target=$1
  if [ -L "$target" ] || [ ! -f "$target" ]; then
    echo "Dani Bot Chromium sandbox is missing or unsafe: $target" >&2
    exit 1
  fi
  if [ "$TEST_MODE" -eq 0 ]; then chown root:root -- "$target"; fi
  chmod 4755 -- "$target"
  actual="$(stat -c '%U:%G:%a' -- "$target")"
  if [ "$actual" != "$EXPECTED_OWNER:4755" ]; then
    echo "Dani Bot could not secure Chromium sandbox: $target ($actual)" >&2
    exit 1
  fi
}

CUA_ROOT="$APP_ROOT/resources/cua-linux-x64"
repair_directory "$APP_ROOT"
repair_directory "$APP_ROOT/resources"
repair_directory "$CUA_ROOT"
repair_executable "$CUA_ROOT/cua-driver"
repair_executable "$CUA_ROOT/cua-cursor-theme"
repair_chromium_sandbox "$APP_ROOT/chrome-sandbox"

# electron-builder after-install template behavior, adapted for TEST_MODE and
# this script's set -eu. Keep the command lines in sync with
# app-builder-lib/templates/linux/after-install.tpl.
if [ "$TEST_MODE" -eq 0 ]; then
  BIN_DIR=/usr/bin
  APPARMOR_DIR=/etc/apparmor.d
else
  BIN_DIR="$TEST_ROOT/usr/bin"
  APPARMOR_DIR="$TEST_ROOT/etc/apparmor.d"
fi
mkdir -p -- "$BIN_DIR" "$APPARMOR_DIR"

# Link the CLI onto PATH (template: update-alternatives with an ln fallback).
if [ "$TEST_MODE" -eq 0 ] && type update-alternatives >/dev/null 2>&1; then
  if [ -L "$BIN_DIR/danibot" ] && [ -e "$BIN_DIR/danibot" ] && [ "$(readlink "$BIN_DIR/danibot")" != "/etc/alternatives/danibot" ]; then
    rm -f "$BIN_DIR/danibot"
  fi
  update-alternatives --install "$BIN_DIR/danibot" danibot "$APP_ROOT/danibot" 100 || ln -sf "$APP_ROOT/danibot" "$BIN_DIR/danibot"
else
  ln -sf "$APP_ROOT/danibot" "$BIN_DIR/danibot"
fi

if [ "$TEST_MODE" -eq 0 ]; then
  if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
  fi
  if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
  fi
fi

# Install the bundled AppArmor profile so Ubuntu 24.04+ allows this app's user
# namespaces (Ubuntu 22.04's AppArmor rejects the abi/4.0 profile, so gate on a
# parser dry run exactly like the template; the app runs fine there without it).
if apparmor_status --enabled >/dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE="$APP_ROOT/resources/apparmor-profile"
  APPARMOR_PROFILE_TARGET="$APPARMOR_DIR/danibot"
  if [ -L "$APPARMOR_PROFILE_SOURCE" ] || [ ! -f "$APPARMOR_PROFILE_SOURCE" ]; then
    echo "Dani Bot AppArmor profile is missing or unsafe: $APPARMOR_PROFILE_SOURCE" >&2
    exit 1
  fi
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" >/dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"
    # Live reloading is meaningless in a chroot (or against a test root).
    if [ "$TEST_MODE" -eq 0 ] && ! { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      # A cache or policy-load failure must not strand the whole package
      # install; the file stays in place for the next boot or parser run.
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET" ||
        echo "Dani Bot could not reload the AppArmor profile now; it will apply at the next boot" >&2
    fi
  else
    echo "Skipping the AppArmor profile: this AppArmor does not accept the bundled profile" >&2
  fi
fi
