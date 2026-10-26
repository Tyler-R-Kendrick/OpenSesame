#!/usr/bin/env bash
# Prepare DBus development files without changing the runner's installed packages.
# Hosted Ubuntu already provides pkg-config and the dbus-daemon runtime.
set -euo pipefail
umask 077

command -v pkg-config >/dev/null
command -v dbus-daemon >/dev/null
command -v dpkg-architecture >/dev/null

dbus_root="${1:?usage: prepare-dbus.sh <owned-output-directory>}"
mkdir -p "$dbus_root"
dbus_root="$(cd "$dbus_root" && pwd -P)"
mkdir -p "$dbus_root"/{lists/partial,cache/archives/partial,conf.d,log,packages,sysroot}
printf 'Dir::Etc::parts "%s/conf.d";\n#clear APT::Update::Post-Invoke;\n#clear APT::Update::Post-Invoke-Success;\n' \
  "$dbus_root" > "$dbus_root/apt.conf"
apt_options=(
  -c "$dbus_root/apt.conf"
  -o "Dir::State::lists=$dbus_root/lists"
  -o "Dir::Cache=$dbus_root/cache"
  -o "Dir::Log=$dbus_root/log"
  -o "Dir::Etc::parts=$dbus_root/conf.d"
  -o "APT::Sandbox::User=$(id -un)"
  -o 'APT::Get::AllowUnauthenticated=false'
  -o 'Acquire::AllowInsecureRepositories=false'
)
# The runner's configured sources and trusted keyrings still authenticate
# Release metadata and package hashes. System apt hooks are not executed.
APT_CONFIG="$dbus_root/apt.conf" apt-get "${apt_options[@]}" update
(
  cd "$dbus_root/packages"
  APT_CONFIG="$dbus_root/apt.conf" apt-get "${apt_options[@]}" download libdbus-1-dev libdbus-1-3 libsystemd-dev
)
for dbus_archive in "$dbus_root/packages/"*.deb; do
  dpkg-deb --extract "$dbus_archive" "$dbus_root/sysroot"
done

dbus_triplet="$(dpkg-architecture -qDEB_HOST_MULTIARCH)"
dbus_pc_dir="$dbus_root/sysroot/usr/lib/$dbus_triplet/pkgconfig"
# Relocate this one package's metadata, rather than applying a global sysroot
# to unrelated OpenSSL/SQLite pkg-config lookups in the same Cargo build.
python3 - "$dbus_pc_dir/dbus-1.pc" "$dbus_root/sysroot/usr" "$dbus_triplet" <<'PY'
from pathlib import Path
import sys
pc, prefix, triplet = sys.argv[1:]
values = {
    "prefix": prefix,
    "includedir": "${prefix}/include",
    "libdir": "${prefix}/lib/" + triplet,
}
path = Path(pc)
lines = path.read_text().splitlines()
path.write_text("\n".join(
    f"{key}={values[key]}" if (key := line.partition("=")[0]) in values else line
    for line in lines
) + "\n")
PY
printf 'export PKG_CONFIG_PATH=%q"${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"\n' \
  "$dbus_pc_dir" > "$dbus_root/env.sh"
PKG_CONFIG_PATH="$dbus_pc_dir${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}" \
  pkg-config --cflags --libs dbus-1
printf 'DBus headers ready; source %s/env.sh for the build.\n' "$dbus_root"
