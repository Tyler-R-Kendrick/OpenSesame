#!/usr/bin/env python3
"""Require complete actual positive screenshots and exact source/admission provenance."""
import argparse
import hashlib
import importlib.util
import json
import math
import re
import sys
import zlib
from pathlib import Path

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("native_png", Path(__file__).with_name("native-visual-png.py"))
png = importlib.util.module_from_spec(spec)
spec.loader.exec_module(png)

PASSWORD = ("security-empty", "enrollment-default", "reject-enrolled", "synthetic-enrolled",
            "reject-result", "synthetic-realm", "fresh-owner", "revoked", "revoked-rejected")
CANARY = ("canary-created", "canary-revoked")


def strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate visual metadata field")
        result[key] = value
    return result


def read(path, maximum):
    if path.is_symlink() or not path.is_file() or not 1 <= path.stat().st_size <= maximum:
        raise ValueError("Missing or unbounded visual evidence")
    return path.read_bytes()


def load(path):
    return json.loads(read(path, 65536), object_pairs_hook=strict_object)


def number(value):
    return type(value) is int or (type(value) is float and math.isfinite(value))


def admission(paths, platform, pages):
    if platform == "android":
        catalog = load(Path(__file__).with_name("native-required-cases.json"))["androidDevice"]
        expected = [{suite + "." + name for suite, names in catalog.items() for name in names}]
    else:
        spec = importlib.util.spec_from_file_location("apple_cases", Path(__file__).with_name("verify-apple-results.py"))
        apple = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(apple)
        expected = [apple.FRAMEWORK | apple.ENVELOPE | {apple.COLD}, {apple.PASSWORD}, {apple.CANARY}]
    if len(paths) != len(expected):
        raise ValueError("Missing exact admission phases")
    rows = []
    for path, names in zip(paths, expected):
        count = len(names)
        record = load(path)
        if platform == "android" and record.get("expectedPageBytes") != pages:
            raise ValueError("Admission page size does not match the actual captured device")
        if any(type(record.get(key)) is not int for key in ("passed", "failed", "skipped")):
            raise ValueError("Admission counts must be integers")
        cases = record.get("cases")
        if record["passed"] != count or record["failed"] or record["skipped"]:
            raise ValueError("Visual evidence requires the complete successful admission suite")
        if not isinstance(cases, list) or len(cases) != count or any(not isinstance(case, str) for case in cases) or set(cases) != names:
            raise ValueError("Admission identities are absent or repeated")
        rows.append({"file": path.name, "sha256": hashlib.sha256(read(path, 65536)).hexdigest(), "passed": count})
    return rows


def exported(roots, expected):
    found, visited, read_bytes = set(), 0, 0
    sizes = {size for _, size in expected}
    for root in roots:
        if root.is_symlink() or not root.is_dir():
            raise ValueError("Missing actual XCResult attachment export")
        for path in root.rglob("*"):
            visited += 1
            if visited > 4096 or path.is_symlink():
                raise ValueError("Unbounded or linked attachment export")
            if not path.is_file() or path.stat().st_size not in sizes:
                continue
            data = read(path, 24 * 1024 * 1024)
            read_bytes += len(data)
            if read_bytes > 256 * 1024 * 1024:
                raise ValueError("Attachment comparison bound exceeded")
            found.add((hashlib.sha256(data).hexdigest(), len(data)))
    if not expected <= found:
        raise ValueError("Captures are not present byte-for-byte in actual XCResult attachments")


def verify(directory, platform, source, application, reports, pages=None, attachments=()):
    if not re.fullmatch(r"[0-9a-f]{40}", source) or not re.fullmatch(r"[0-9a-f]{64}", application):
        raise ValueError("Invalid source or actual application digest")
    expected = PASSWORD + (CANARY if platform == "apple" else ())
    names = {name + suffix for name in expected for suffix in (".png", ".json")}
    if directory.is_symlink() or not directory.is_dir() or {path.name for path in directory.iterdir()} != names:
        raise ValueError("Missing, repeated or unexpected positive checkpoints")
    rows, common, hashes = [], None, set()
    for name in expected:
        metadata_path, image_path = directory / (name + ".json"), directory / (name + ".png")
        metadata = load(metadata_path)
        keys = {"v", "platform", "checkpoint", "sourceSha", "imageSha256", "viewport", "density", "bounds"}
        if platform == "android":
            keys |= {"applicationSha256", "pages"}
        if not isinstance(metadata, dict) or set(metadata) != keys:
            raise ValueError("Visual metadata must contain only closed non-secret fields")
        if type(metadata["v"]) is not int or metadata["v"] != 1 or metadata["platform"] != platform or metadata["checkpoint"] != name or metadata["sourceSha"] != source:
            raise ValueError("Visual checkpoint or source mismatch")
        if platform == "android" and (metadata["applicationSha256"] != application or type(metadata["pages"]) is not int or metadata["pages"] != pages or pages not in (4096, 16384)):
            raise ValueError("Installed APK or actual page-size mismatch")
        image = read(image_path, 24 * 1024 * 1024)
        width, height = png.dimensions(image)
        viewport = metadata["viewport"]
        if not isinstance(viewport, dict) or set(viewport) != {"width", "height"} or any(type(viewport[key]) is not int for key in viewport) or viewport != {"width": width, "height": height}:
            raise ValueError("Screenshot and actual viewport mismatch")
        density = metadata["density"]
        if not number(density) or not 0.5 <= density <= 8:
            raise ValueError("Invalid actual density")
        bounds = metadata["bounds"]
        if not isinstance(bounds, list) or len(bounds) != 1:
            raise ValueError("Missing actual asserted-state bounds")
        box = bounds[0]
        if not isinstance(box, dict) or set(box) != {"name", "x", "y", "width", "height"} or box["name"] != "asserted-state" or not all(number(box[key]) for key in ("x", "y", "width", "height")):
            raise ValueError("Malformed measured bounds")
        if not (0 <= box["x"] < width and 0 <= box["y"] < height and box["width"] > 0 and box["height"] > 0 and box["x"] + box["width"] <= width and box["y"] + box["height"] <= height):
            raise ValueError("Measured state falls outside captured viewport")
        identity = (width, height, density)
        if common is not None and common != identity:
            raise ValueError("Native checkpoints use inconsistent viewports")
        common = identity
        digest = hashlib.sha256(image).hexdigest()
        if metadata["imageSha256"] != digest:
            raise ValueError("Captured PNG digest mismatch")
        raw_json = read(metadata_path, 65536)
        json_digest = hashlib.sha256(raw_json).hexdigest()
        hashes.update(((digest, len(image)), (json_digest, len(raw_json))))
        rows.append({"checkpoint": name, "imageSha256": digest, "metadataSha256": json_digest, "viewport": viewport, "density": density, "bounds": bounds})
    reports = admission(reports, platform, pages)
    if platform == "apple":
        exported(attachments, hashes)
    return {"v": 1, "platform": platform, "sourceSha": source, "applicationSha256": application,
            "applicationDigestScope": "installed APK" if platform == "android" else "postbuild simulator application executable",
            "applicationBeforeDigest": "not measured", "pages": pages, "admission": reports, "checkpoints": rows,
            "scope": "Actual local native UI captures; not production backend, release signing or physical hardware proof"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("platform", choices=("android", "apple"))
    parser.add_argument("directory", type=Path)
    parser.add_argument("--source", required=True)
    parser.add_argument("--application", required=True)
    parser.add_argument("--admission", action="append", type=Path, required=True)
    parser.add_argument("--pages", type=int)
    parser.add_argument("--attachments", action="append", type=Path, default=[])
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.directory, args.platform, args.source, args.application, args.admission, args.pages, args.attachments), indent=2))
    except (ValueError, KeyError, TypeError, OSError, zlib.error):
        sys.exit("Native visual evidence verification failed; metadata withheld")
