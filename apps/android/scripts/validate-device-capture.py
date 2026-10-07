#!/usr/bin/env python3
"""Separate failed adb output from candidate visual bytes; final admission stays strict."""
import importlib.util
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True


def valid(path, suffix):
    maximum = 24 * 1024 * 1024 if suffix == "png" else 65536
    if suffix not in ("png", "json") or path.is_symlink() or not path.is_file():
        return False
    if not 1 <= path.stat().st_size <= maximum:
        return False
    data = path.read_bytes()
    if suffix == "json":
        return isinstance(json.loads(data), dict)
    spec = importlib.util.spec_from_file_location(
        "native_png", Path(__file__).with_name("native-visual-png.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.dimensions(data)
    return True


try:
    if len(sys.argv) != 3 or not valid(Path(sys.argv[1]), sys.argv[2]):
        sys.exit(1)
except (OSError, ValueError, TypeError):
    sys.exit(1)
