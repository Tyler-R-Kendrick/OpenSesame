#!/usr/bin/env python3
"""Verify the local source subset before trusting its upstream advisory scan."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent
SUBSET = ROOT / "third_party" / "x-crypto"
DIRECTORIES = {
    "cryptobyte", "chacha20", "chacha20poly1305", "internal/alias", "internal/poly1305"
}


def verify(upstream_metadata=None, imports=None):
    manifest = json.loads((SUBSET / "UPSTREAM.json").read_text())
    if manifest["module"] != "golang.org/x/crypto":
        raise ValueError("upstream module identity changed")
    if set(manifest["directories"]) != DIRECTORIES:
        raise ValueError("source subset package boundary changed")
    files = manifest["files"]
    if not files or any(
        name not in {"LICENSE", "PATENTS"} and not any(
            name.startswith(directory + "/") for directory in DIRECTORIES
        ) for name in files
    ):
        raise ValueError("unexpected upstream source path")
    expected = set(files) | {"UPSTREAM.json", "go.mod", "go.sum"}
    actual = set()
    if SUBSET.is_symlink():
        raise ValueError("source subset is a symlink")
    for path in SUBSET.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"source subset contains symlink: {path}")
        if path.is_file():
            actual.add(path.relative_to(SUBSET).as_posix())
    if actual != expected:
        raise ValueError(f"source files differ: missing={expected - actual}, extra={actual - expected}")
    for name, digest in files.items():
        if hashlib.sha256((SUBSET / name).read_bytes()).hexdigest() != digest:
            raise ValueError(f"upstream source drift: {name}")
    expected_mod = "module golang.org/x/crypto\n\ngo 1.26.10\n\nrequire golang.org/x/sys v0.49.0\n"
    if (SUBSET / "go.mod").read_text() != expected_mod:
        raise ValueError("subset module metadata changed")
    project = (ROOT / "go.mod").read_text()
    version = re.escape(manifest["version"])
    if not re.search(r"^\s*golang\.org/x/crypto " + version + r"(?:\s|$)", project, re.M):
        raise ValueError("project and subset upstream versions disagree")
    if "replace golang.org/x/crypto => ./third_party/x-crypto" not in project:
        raise ValueError("project source replacement changed")
    if upstream_metadata:
        upstream = json.loads(Path(upstream_metadata).read_text())
        if upstream.get("Error"):
            raise ValueError(upstream["Error"])
        if (upstream["Path"], upstream["Version"], upstream["Sum"]) != (
            manifest["module"], manifest["version"], manifest["sum"]
        ):
            raise ValueError("downloaded upstream identity/integrity differs")
        if upstream.get("Origin", {}).get("Hash") != manifest["commit"]:
            raise ValueError("downloaded upstream commit differs")
        source = Path(upstream["Dir"])
        upstream_files = {"LICENSE", "PATENTS"}
        for directory in DIRECTORIES:
            upstream_files.update(
                path.relative_to(source).as_posix()
                for path in (source / directory).rglob("*") if path.is_file()
            )
        if upstream_files != set(files):
            raise ValueError("upstream package files were omitted or added")
        for name in upstream_files:
            if (SUBSET / name).read_bytes() != (source / name).read_bytes():
                raise ValueError(f"source differs from canonical upstream: {name}")
    if imports:
        packages = {
            manifest["module"] + "/" + str(Path(name).parent)
            for name in files if name.endswith(".go")
        }
        analyzed = set(Path(imports).read_text().splitlines())
        if packages - analyzed:
            raise ValueError(f"source packages omitted from advisory analysis: {packages - analyzed}")
    print(f"Verified x/crypto {manifest['version']}: {len(files)} unchanged upstream files; OpenPGP absent")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream-metadata")
    parser.add_argument("--imports")
    args = parser.parse_args()
    try:
        verify(args.upstream_metadata, args.imports)
    except (OSError, ValueError, KeyError) as error:
        print(f"crypto subset verification failed: {error}", file=sys.stderr)
        sys.exit(1)
