#!/usr/bin/env python3
"""Real native eight-way partitions; complete tool inventories and outcomes retained."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import shlex
import subprocess
import sys

SPEC = importlib.util.spec_from_file_location("native_platform", Path(__file__).with_name("credential-adapter-platform.py"))
platform_gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(platform_gate)
NATIVE_SHARDS = 8


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def source_snapshot(files, packages):
    names = {"Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "package.json", "tools/mutation/credential-rust-depth.json"}
    names.update(files)
    names.update({"scripts/quality/rust-mutation-shard.py", "scripts/quality/credential-adapter-platform.py", "tools/mutation/credential-adapter-applicability.json"})
    for package in packages:
        names.add("crates/" + package.removeprefix("opensesame-") + "/Cargo.toml")
    if 'opensesame-authenticator-core' in packages:
        proof_root = Path('scripts/quality/credential-equivalence')
        manifest = json.loads((proof_root/'verifier-inputs.json').read_text())
        pins = json.loads((proof_root/'repository-code-pins.json').read_text())
        names.update(str(proof_root/name) for name in (*manifest['files'],'verifier-inputs.json'))
        names.update(pins['files'])
    return {name: platform_gate.sha(name) for name in sorted(names)}


def canonical_scope():
    script = json.loads(Path("package.json").read_text())["scripts"]["test:mutation:rust"]
    command = shlex.split(script)
    if command[:5] != ["cargo", "+1.88.0", "mutants", "--gitignore", "true"]:
        raise ValueError("Unknown canonical mutation command")
    packages, files, offset = [], [], 5
    while offset < len(command) and command[offset] in ("-p", "--file"):
        option, value = command[offset:offset + 2]
        (packages if option == "-p" else files).append(value)
        offset += 2
    expected_packages = ["opensesame-redaction", "opensesame-task-bus", "opensesame-relay", "opensesame-connection-detect", "opensesame-human-vault", "opensesame-sealed-store", "opensesame-gateway", "opensesame-pki-core", "opensesame-storage"]
    expected_files = ["crates/pki-core/src/policy.rs", "crates/pki-core/src/revocation.rs", "crates/pki-core/src/bundle.rs", "crates/storage/src/lib.rs", "crates/redaction/src/lib.rs", "crates/task-bus/src/validate.rs", "crates/relay/src/lib.rs", "crates/connection-detect/src/lib.rs", "crates/human-vault/src/lib.rs", "crates/sealed-store/src/attachment.rs", "crates/gateway/src/cert_issuers/model.rs"]
    if packages != expected_packages or files != expected_files or command[offset:] != ["-j", "2", "-o", "artifacts/mutation/rust"]:
        raise ValueError("Canonical original scope or flags changed; explicit review required")
    return packages, files, command[:offset], script


def full_scope(group):
    if group == "canonical":
        return canonical_scope()
    scope = json.loads(Path("tools/mutation/credential-rust-depth.json").read_text())[group]
    packages, files = scope["packages"], scope["files"]
    if len(set(files)) != len(files) or len(files) != (10 if group == "core" else 12):
        raise ValueError("Original declared feature inventory changed")
    command = ["cargo", "+1.88.0", "mutants", "--gitignore", "true"]
    for package in packages:
        command.extend(["-p", package])
    for file in files:
        command.extend(["--file", file])
    return packages, files, command, None


def actual_context(evidence, platform):
    for key in os.environ:
        if (key in {"RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "CARGO_BUILD_TARGET"} or (key.startswith("CARGO_TARGET_") and key.endswith("_RUSTFLAGS"))) and os.environ[key]:
            raise ValueError("Unreviewed native compiler context: " + key)
    rust = platform_gate.command(["rustc", "+1.88.0", "-vV"], evidence / "rustc.txt")
    if not rust.startswith("rustc 1.88.0 "):
        raise ValueError("Unexpected real compiler")
    tool = platform_gate.command(["cargo", "+1.88.0", "mutants", "--version"], evidence / "mutants-version.txt")
    if tool.strip() != "cargo-mutants 27.1.0":
        raise ValueError("Unexpected real mutation tool")
    cfg = platform_gate.command(["rustc", "+1.88.0", "--print", "cfg"], evidence / "native.cfg")
    if 'target_os="' + platform + '"' not in cfg.splitlines():
        raise ValueError("Job is not executing on requested native platform")
    return {"rustc": rust, "tool": tool.strip(), "cfg": cfg.splitlines()}


def fixed_partition(active, shard):
    if type(shard) is not int or shard not in range(NATIVE_SHARDS):
        raise ValueError("Unknown declared shard")
    assigned = active[shard::NATIVE_SHARDS]
    if not assigned:
        raise ValueError("Empty shard cannot establish execution")
    return assigned


def native_tool_path(path, platform, host_os):
    value = str(path)
    if platform == "windows":
        if host_os != "nt" or not PureWindowsPath(value).is_absolute():
            raise ValueError("Native Windows Python and absolute Windows tool path required")
    elif host_os != "posix" or not PurePosixPath(value).is_absolute():
        raise ValueError("Native POSIX Python and absolute POSIX tool path required")
    return value


def adapter_campaign(evidence,result,before,files,packages,context,platform,assigned):
    group = 'adapters'
    failure = None
    capture = None
    exit_code,returned,exception = None,False,None
    report_complete,admitted,errors = False,False,[]
    if group == 'adapters':
        bundle = Path(__file__).with_name('credential-equivalence').resolve()
        sys.path.insert(0,str(bundle))
        from capture import BaselineCapture
        from failure_contract import provenance
        capture = BaselineCapture(Path.cwd().resolve(),evidence,bundle,context,platform)
    try:
        platform_gate.command(result["command"], evidence / "campaign.log", combined=True)
        returned = True
    except Exception as error:
        failure = error
        exception = {'class':type(error).__name__,'message':str(error)}
    if capture is not None:
        try:
            result['semanticCapture'] = capture.finish()
        except Exception as error:
            result['semanticCapture'] = {'status':'failure','error':str(error),'rawAdmissionUnchanged':True}
    try:
        exit_code = int((evidence/'campaign.log.exit').read_text().strip())
    except Exception as error:
        errors.append('missing-command-exit')
        failure = failure or error
    try:
        report = evidence / "mutants/mutants.out/outcomes.json"
        outcomes = json.loads(report.read_text())
        admission = platform_gate.outcomes_analyze(outcomes, [{"mutant": value} for value in assigned])
        report_complete,admitted = True,admission['admitted']
        result.update({"outcomesSHA256": platform_gate.sha(report), "admission": admission,
                       "status": "success" if admitted and failure is None else "failure"})
        if not admitted:
            failure = failure or ValueError("Actual applicable mutants survived/timed out")
    except Exception as error:
        errors.append('report-error')
        failure = failure or error
        result.update({"status": "failure", "reportError": str(error)})
    finally:
        after = source_snapshot(files, packages)
        platform_gate.save(evidence / "source.after.json", after)
        if after != before:
            failure = failure or ValueError("Original scope inputs changed")
            result["status"] = "failure"
        if group == 'adapters':
            result['rawFailureProvenance'] = provenance(exit_code,returned,exception,
                evidence/'campaign.log',report_complete,after==before,admitted,errors)
        platform_gate.save(evidence / "shard-receipt.json", result)
    if failure:
        raise failure


def run(group, platform, shard, evidence):
    evidence = Path(evidence).resolve()
    native_tool_path(evidence, platform, os.name)
    evidence.mkdir(exist_ok=False)
    if group != "adapters" and platform != "linux":
        raise ValueError("Unreviewed core/canonical platform expansion")
    packages, files, base, canonical = full_scope(group)
    variants = None
    if group == "adapters":
        config_path = Path("tools/mutation/credential-adapter-applicability.json")
        config = json.loads(config_path.read_text())
        if set(config["files"]) != set(files):
            raise ValueError("Cfg inventory omits original adapter files")
        variants = platform_gate.pins_match(Path.cwd(), config)
    before = source_snapshot(files, packages)
    platform_gate.save(evidence / "source.before.json", before)
    context = actual_context(evidence, platform)
    source = platform_gate.command(["git", "rev-parse", "HEAD", "HEAD^{tree}"], evidence / "source.txt").splitlines()
    if len(source) != 2 or source[0] != os.environ.get("GITHUB_SHA"):
        raise ValueError("Workflow source does not match authenticated job source")
    full = json.loads(platform_gate.command(base + ["--list", "--json"], evidence / "all-generated.json"))
    if not isinstance(full, list) or not full or {row["file"] for row in full} != set(files) or len({row["name"] for row in full}) != len(full):
        raise ValueError("Vacuous, duplicate or incomplete original tool scope")
    extra = []
    if group == "adapters":
        compiler = platform_gate.compiler_context(Path.cwd(), evidence, platform)
        rows = platform_gate.classify(full, variants, compiler)
        context["packageCfg"] = compiler
        context["cfgInventorySHA256"] = platform_gate.sha(config_path)
        selector = evidence / "exact-selection.toml"
        platform_gate.write_selector(selector, [row for row in rows if row["active"]])
        extra = ["--config", native_tool_path(selector, platform, os.name)]
    else:
        if Path(".cargo/mutants.toml").exists():
            raise ValueError("Unknown canonical/default mutant configuration")
        rows = [{"mutant": value, "condition": "original_unfiltered_scope", "active": True} for value in full]
    active = [row["mutant"] for row in rows if row["active"]]
    selected = json.loads(platform_gate.command(base + extra + ["--list", "--json"], evidence / "active.json"))
    platform_gate.inventory_equal(selected, active)
    assigned = fixed_partition(active, shard)
    shard_args = ["--shard", str(shard) + "/8", "--sharding", "round-robin"]
    listed = json.loads(platform_gate.command(base + extra + shard_args + ["--list", "--json"], evidence / "assigned.json"))
    platform_gate.inventory_equal(listed, assigned)
    result = {"v": 1, "group": group, "platform": platform, "shard": shard, "shards": 8,
              "source": source, "wholeSourceBeforeSHA256": platform_gate.sha(evidence.parent / "inputs.before.json"), "sourcePins": before, "compiler": context, "canonicalCommand": canonical,
              "fullInventorySHA256": digest(full), "activeInventorySHA256": digest(active),
              "full": full, "applicability": rows, "active": active, "assigned": assigned,
              "command": base + extra + shard_args + ["-j", "2", "-o", native_tool_path(evidence / "mutants", platform, os.name)],
              "status": "not_started"}
    platform_gate.save(evidence / "shard-receipt.json", result)
    if group == 'adapters':
        return adapter_campaign(evidence,result,before,files,packages,context,platform,assigned)
    failure = None
    try:
        platform_gate.command(result["command"], evidence / "campaign.log", combined=True)
    except Exception as error:
        failure = error
    try:
        report = evidence / "mutants/mutants.out/outcomes.json"
        outcomes = json.loads(report.read_text())
        admission = platform_gate.outcomes_analyze(outcomes, [{"mutant": value} for value in assigned])
        result.update({"outcomesSHA256": platform_gate.sha(report), "admission": admission,
                       "status": "success" if admission["admitted"] and failure is None else "failure"})
        if not admission["admitted"]:
            failure = failure or ValueError("Actual applicable mutants survived/timed out")
    except Exception as error:
        failure = failure or error
        result.update({"status": "failure", "reportError": str(error)})
    finally:
        after = source_snapshot(files, packages)
        platform_gate.save(evidence / "source.after.json", after)
        if after != before:
            failure = failure or ValueError("Original scope inputs changed")
            result["status"] = "failure"
        platform_gate.save(evidence / "shard-receipt.json", result)
    if failure:
        raise failure


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("group", choices=("canonical", "core", "adapters"))
    parser.add_argument("platform", choices=("linux", "windows", "macos"))
    parser.add_argument("shard", type=int, choices=range(NATIVE_SHARDS))
    parser.add_argument("evidence")
    arguments = parser.parse_args()
    run(arguments.group, arguments.platform, arguments.shard, arguments.evidence)
