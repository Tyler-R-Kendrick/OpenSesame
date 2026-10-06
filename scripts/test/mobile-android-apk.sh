#!/usr/bin/env bash
# Inspect the actual assembled artifact, including each native architecture.
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
python3 - "${1:-$repo_root/apps/android/android/app/build/outputs/apk/debug/app-debug.apk}" <<'PY'
import sys, zipfile
expected = {"armeabi-v7a": (1, 40), "arm64-v8a": (2, 183), "x86": (1, 3), "x86_64": (2, 62)}
with zipfile.ZipFile(sys.argv[1]) as apk:
    for abi, (elf_class, machine) in expected.items():
        path = f"lib/{abi}/libopensesame_authenticator_core.so"
        data = apk.read(path)
        if len(data) < 4096 or data[:4] != b"\x7fELF" or data[4] != elf_class or data[5] != 1:
            raise SystemExit(f"invalid packaged native library: {path}")
        if int.from_bytes(data[18:20], "little") != machine:
            raise SystemExit(f"wrong packaged native architecture: {path}")
        print(f"APK native library verified: {abi}")
PY
