#!/usr/bin/env python3
"""Inventory the Go standard library compiled into the native WASM assets."""

import json
import re
import sys
from pathlib import Path


def main():
    plan = json.loads(Path(sys.argv[1]).read_text())
    version = plan["compiler"]["version"]
    if not isinstance(version, str) or not re.fullmatch(r"go[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("native compiler must declare a released Go version")
    version = version.removeprefix("go")
    inventory = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "version": 1,
        "components": [{
            "type": "framework",
            "name": "stdlib",
            "version": version,
            "purl": f"pkg:golang/stdlib@{version}",
        }],
    }
    Path(sys.argv[2]).write_text(json.dumps(inventory))


if __name__ == "__main__":
    main()
