#!/usr/bin/env python3
"""Require exact native case identities and successful, non-skipped execution."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

CATALOG = json.loads((Path(__file__).parent / "native-required-cases.json").read_text())
LIMIT = 32 * 1024 * 1024


def require(condition, label):
    if not condition:
        raise ValueError(label)


def read(path):
    data = Path(path).read_bytes()
    require(len(data) <= LIMIT, "Oversized native result")
    return data.decode("utf-8-sig")


def exact(actual, expected):
    require(len(expected) > 0 and len(set(expected)) == len(expected), "Invalid mandatory catalog")
    require(Counter(actual) == Counter(expected), "Missing, unexpected or repeated native case")


def rust(text, group):
    text = text.replace("\r\n", "\n")
    expected = CATALOG["rust"][group]
    statuses = re.findall(r"^test ([\w:]+) \.\.\. (ok|FAILED|ignored)(?:[ \t].*)?$", text, re.M)
    require(all(status == "ok" for _, status in statuses), "Failed or ignored native Rust case")
    exact([name for name, _ in statuses], expected)
    summaries = re.findall(r"test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;", text)
    require(bool(summaries), "Missing Rust summaries")
    require(all(state == "ok" and int(failed) == int(ignored) == 0 for state, _, failed, ignored in summaries), "Failed or ignored Rust summary")
    require([int(passed) for _, passed, _, _ in summaries if int(passed)] == [len(expected)], "Inconsistent Rust execution count")
    return {"group": group, "passed": len(expected), "failed": 0, "ignored": 0, "cases": expected}


def jvm(directory):
    files = sorted(Path(directory).glob("TEST-*.xml"))
    require(bool(files) and len(files) <= 64, "Missing or unbounded JVM reports")
    actual = []
    size = 0
    for path in files:
        size += path.stat().st_size
        require(size <= LIMIT, "Oversized JVM reports")
        text = read(path)
        require("<!DOCTYPE" not in text.upper() and "<!ENTITY" not in text.upper(), "Unsupported XML declaration")
        suite = ET.fromstring(text)
        require(suite.tag == "testsuite", "Unsupported JVM report")
        for key in ("failures", "errors", "skipped"):
            require(key in suite.attrib and int(suite.attrib[key]) == 0, "Failed, errored or skipped JVM suite")
        cases = suite.findall("testcase")
        require(int(suite.attrib["tests"]) == len(cases), "Inconsistent JVM count")
        for case in cases:
            require(not any(case.find(key) is not None for key in ("failure", "error", "skipped")), "Failed, errored or skipped JVM case")
            actual.append(case.attrib["classname"] + "." + case.attrib["name"])
    expected = [suite + "." + name for suite, names in CATALOG["jvm"].items() for name in names]
    exact(actual, expected)
    return {"passed": len(actual), "failed": 0, "errors": 0, "skipped": 0, "cases": sorted(actual)}


def android(text, pages):
    require(pages in (4096, 16384), "Unsupported Android page size")
    expected = [(suite, name) for suite, names in CATALOG["androidDevice"].items() for name in names]
    starts, passed, current = [], [], {}
    for line in text.splitlines():
        item = re.fullmatch(r"INSTRUMENTATION_STATUS: (\w+)=(.*)", line)
        if item:
            require(item[1] not in current, "Duplicate instrumentation field")
            current[item[1]] = item[2]
        code = re.fullmatch(r"INSTRUMENTATION_STATUS_CODE: (-?\d+)", line)
        if code:
            status = int(code[1])
            require(status in (0, 1), "Failed, skipped or assumed instrumentation case")
            identity = (current.get("class"), current.get("test"))
            require(identity in expected, "Unknown instrumentation case")
            (passed if status == 0 else starts).append(identity)
            current = {}
    require(not current, "Incomplete instrumentation status")
    exact(starts, expected)
    exact(passed, expected)
    require(re.findall(r"^OK \((\d+) tests?\)\s*$", text, re.M) == [str(len(expected))], "Missing or inconsistent instrumentation summary")
    require(re.findall(r"^INSTRUMENTATION_CODE: (-?\d+)\s*$", text, re.M) == ["-1"], "Missing successful instrumentation exit")
    require("FAILURES!!!" not in text, "Instrumentation failure summary")
    return {"passed": len(passed), "failed": 0, "skipped": 0, "expectedPageBytes": pages, "cases": [suite + "." + name for suite, name in passed]}


def swift(directory):
    programs = CATALOG["swiftPrograms"]
    for name, marker in programs.items():
        require(read(Path(directory) / (name + ".log")).splitlines() == [marker], "Missing or repeated Swift program completion")
    return {"passedPrograms": len(programs), "programs": list(programs), "scope": "Actual Linux Swift behavior; not Apple SDK or named XCTest results"}


def swift_envelope(text):
    expected = CATALOG["swiftEnvelope"]
    statuses = re.findall(r"^Test Case '(?:WalletEnvelopeCoreTests\.)?EnvelopeTests\.(test\w+)' (passed|failed|skipped)(?: .*|\.)$", text, re.M)
    require(all(status == "passed" for _, status in statuses), "Failed or skipped envelope case")
    exact([name for name, _ in statuses], expected)
    summaries = re.findall(r"Executed (\d+) tests?, with (\d+) failures(?: \((\d+) unexpected\))?", text)
    require(bool(summaries), "Missing envelope XCTest summary")
    require(all(int(count) == len(expected) and int(failed) == 0 and (not unexpected or int(unexpected) == 0) for count, failed, unexpected in summaries), "Inconsistent envelope XCTest summary")
    return {"passed": len(expected), "failed": 0, "skipped": 0, "cases": expected, "scope": "Portable envelope XCTest; not Apple Keychain or SDK execution"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=("rust", "jvm", "android", "swift", "swift-envelope"))
    parser.add_argument("input", type=Path)
    parser.add_argument("--group", choices=tuple(CATALOG["rust"]))
    parser.add_argument("--pages", type=int)
    args = parser.parse_args()
    if args.kind == "swift":
        result = swift(args.input)
    elif args.kind == "jvm":
        result = jvm(args.input)
        result["reportSha256"] = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(args.input.glob("TEST-*.xml"))}
    else:
        text = read(args.input)
        result = rust(text, args.group) if args.kind == "rust" else swift_envelope(text) if args.kind == "swift-envelope" else android(text, args.pages)
        result["inputSha256"] = hashlib.sha256(args.input.read_bytes()).hexdigest()
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, ET.ParseError):
        sys.exit("Native result verification failed; input withheld")
