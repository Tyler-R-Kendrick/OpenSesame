//! Source-level contracts that the type system cannot state: no
//! `Deserialize` for verified evidence anywhere in this crate, and the
//! privileged constructor referenced only where a real verifier lives.

use std::fs;
use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    const SKIP: &[&str] = &[
        "node_modules",
        "target",
        ".git",
        "dist",
        ".cache",
        "artifacts",
        ".turbo",
    ];
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        if path.is_dir() {
            if !SKIP.contains(&name.as_str()) {
                walk(&path, out);
            }
        } else if has_extension(&name, &["rs", "ts", "tsx"]) {
            out.push(path);
        }
    }
}

fn has_extension(name: &str, allowed: &[&str]) -> bool {
    name.rsplit_once('.')
        .is_some_and(|(_, ext)| allowed.contains(&ext))
}

fn sources() -> Vec<(String, String)> {
    let root = repo_root();
    let mut files = Vec::new();
    walk(&root, &mut files);
    files
        .into_iter()
        .filter_map(|p| {
            let rel = p
                .strip_prefix(&root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            fs::read_to_string(&p).ok().map(|s| (rel, s))
        })
        .collect()
}

#[test]
fn verified_peer_never_derives_or_implements_deserialize() {
    let evidence =
        fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/transport/evidence.rs"))
            .unwrap();
    let struct_at = evidence.find("pub struct VerifiedPeer").unwrap();
    let derive_block = &evidence[..struct_at];
    let last_derive = derive_block.rfind("#[derive(").unwrap();
    assert!(
        !derive_block[last_derive..].contains("Deserialize"),
        "VerifiedPeer derives Deserialize"
    );
    assert!(
        !derive_block[last_derive..].contains("Serialize"),
        "VerifiedPeer derives Serialize; use view()"
    );
    for (rel, src) in sources() {
        if !has_extension(&rel, &["rs"]) || rel.ends_with("source_contract_tests.rs") {
            continue;
        }
        assert!(
            !src.contains("Deserialize for VerifiedPeer")
                && !src.contains("Deserialize<'de> for VerifiedPeer"),
            "{rel} implements Deserialize for VerifiedPeer"
        );
        assert!(
            !src.contains("Deserialize for AttestedPeer"),
            "{rel} implements Deserialize for AttestedPeer"
        );
    }
    let attest =
        fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/transport/attest.rs"))
            .unwrap();
    assert!(
        !attest.contains("Deserialize"),
        "attest.rs must not mention Deserialize at all"
    );
}

#[test]
fn attested_peer_is_referenced_only_by_real_verifiers() {
    const ALLOWED_PREFIXES: &[&str] = &[
        "crates/domain/src/transport/",
        "crates/transport-security/",
        "crates/uds-authn/",
        "crates/ingress-evidence/",
        "crates/spiffe-source/",
        "packages/control-plane/src/transport/",
        "packages/os-domain/src/transport-security/",
        "packages/os-domain/src/__tests__/transport-security",
        "packages/contracts/src/",
        "tests/",
    ];
    let mut offenders = Vec::new();
    for (rel, src) in sources() {
        if !src.contains("AttestedPeer") {
            continue;
        }
        // Test-only code is exempt, because it is never compiled into a
        // binary. `test_support.rs` earns that exemption the same way
        // `_tests.rs` does, and `assert_test_only` below proves the file is
        // actually declared under `#[cfg(test)]` rather than merely named
        // as though it were.
        let test_only = rel.ends_with("_tests.rs")
            || rel.ends_with(".test.ts")
            || rel.contains("/tests/")
            || rel.ends_with("test_support.rs");
        if rel.ends_with("test_support.rs") {
            assert_test_only(&rel);
        }
        if !ALLOWED_PREFIXES.iter().any(|p| rel.starts_with(p)) && !test_only {
            offenders.push(rel);
        }
    }
    assert!(
        offenders.is_empty(),
        "AttestedPeer referenced outside verifier paths: {offenders:?}"
    );
}

/// A `test_support.rs` is exempt only while its sibling `mod.rs` declares it
/// under `#[cfg(test)]`. Drop the attribute and the module compiles into the
/// binary — and this assertion fails before the exemption can hide it.
fn assert_test_only(rel: &str) {
    let module = repo_root().join(rel);
    let mod_rs = module.with_file_name("mod.rs");
    let Ok(declaration) = fs::read_to_string(&mod_rs) else {
        panic!("{rel}: no sibling mod.rs to prove it is test-only");
    };
    let stem = module
        .file_stem()
        .expect("file stem")
        .to_string_lossy()
        .into_owned();
    let declared = declaration.split("#[cfg(test)]").skip(1).any(|after| {
        after
            .split(';')
            .next()
            .is_some_and(|item| item.contains(&format!("mod {stem}")))
    });
    assert!(
        declared,
        "{rel} references AttestedPeer but is not declared under #[cfg(test)] in {}",
        mod_rs.display()
    );
}

#[test]
fn browser_vault_key_injection_is_only_ever_assigned_the_helper() {
    let mut offenders = Vec::new();
    for (rel, src) in sources() {
        if !has_extension(&rel, &["rs"]) || rel.ends_with("_tests.rs") {
            continue;
        }
        for line in src.lines() {
            let trimmed = line.trim_start();
            let Some(rest) = trimmed.strip_prefix("browser_vault_key_injection:") else {
                continue;
            };
            let rest = rest.trim();
            let ok = rest.starts_with("browser_vault_key_injection()")
                || rest.starts_with("w.browser_vault_key_injection")
                || rest.starts_with("CapabilityOutcome,")
                || rest.starts_with("CapabilityOutcome ");
            if !ok {
                offenders.push(format!("{rel}: {}", line.trim()));
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "browser_vault_key_injection assigned by hand: {offenders:?}"
    );
}
