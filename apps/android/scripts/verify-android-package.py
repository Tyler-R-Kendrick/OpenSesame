#!/usr/bin/env python3
"""Check actual packaged 64-bit ELF segments and Android 16-KiB ZIP alignment."""
import argparse
import os
from pathlib import Path
import struct
import subprocess
import zipfile


def verify_elf(data, name):
    if data[:6] != b"\x7fELF\x02\x01":
        raise ValueError(f"Unsupported 64-bit little-endian ELF: {name}")
    offset = struct.unpack_from("<Q", data, 32)[0]
    entry_size, count = struct.unpack_from("<HH", data, 54)
    alignments = []
    for index in range(count):
        start = offset + index * entry_size
        if struct.unpack_from("<I", data, start)[0] == 1:
            alignments.append(struct.unpack_from("<Q", data, start + 48)[0])
    if not alignments or min(alignments) < 16_384:
        raise ValueError(f"Non-16-KiB LOAD alignment in {name}: {alignments}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    args = parser.parse_args()
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if not sdk:
        parser.error("ANDROID_HOME or ANDROID_SDK_ROOT is required")
    aligner = Path(sdk) / "build-tools" / "36.0.0" / "zipalign"
    subprocess.run([str(aligner), "-c", "-P", "16", "4", str(args.apk)], check=True)
    checked = 0
    with zipfile.ZipFile(args.apk) as archive:
        for abi in ("arm64-v8a", "armeabi-v7a", "x86", "x86_64"):
            archive.getinfo(f"lib/{abi}/libopensesame_authenticator_core.so")
        for name in archive.namelist():
            if name.startswith(("lib/arm64-v8a/", "lib/x86_64/")) and name.endswith(".so"):
                verify_elf(archive.read(name), name)
                checked += 1
    if not checked:
        raise ValueError("No packaged 64-bit native libraries")
    print(f"Android package: all four Rust ABIs and {checked} 16-KiB native libraries verified")


if __name__ == "__main__":
    main()
