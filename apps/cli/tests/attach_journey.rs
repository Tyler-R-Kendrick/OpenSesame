//! End-to-end behaviour of `opensesame pass attach`, driven through the real
//! binary rather than the library.
//!
//! The unit and property suites cover the crypto. What they cannot show is
//! that a person can put a document in and get the same bytes back out, that
//! an agent cannot, and that the ciphertext actually reaches git — the three
//! things the feature exists to do.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const PASSPHRASE: &str = "correct horse battery staple";

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_opensesame")
}

fn run(store: &Path, args: &[&str]) -> Output {
    Command::new(bin())
        .args(args)
        .arg("--path")
        .arg(store)
        .env("OPENSESAME_STORE_PASSWORD", PASSPHRASE)
        // Keep the store's git identity local to the temp dir.
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        .output()
        .expect("failed to run the opensesame binary")
}

fn stdout(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// A deterministic payload spanning three chunks, so the journey exercises
/// real chunk boundaries rather than a single-chunk special case.
fn payload() -> Vec<u8> {
    (0..2_621_440usize).map(fixture_byte).collect()
}

fn fixture_byte(index: usize) -> u8 {
    u8::try_from(index % 251).expect("modulo 251 always fits in u8")
}

struct Fixture {
    _dir: tempfile::TempDir,
    store: PathBuf,
    source: PathBuf,
}

fn given_a_store_with_a_document() -> Fixture {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = dir.path().join("store");
    std::fs::create_dir_all(&store).unwrap();
    let init = run(&store, &["pass", "init"]);
    assert!(init.status.success(), "pass init failed: {init:?}");

    let source = dir.path().join("w2.pdf");
    std::fs::write(&source, payload()).unwrap();

    Fixture {
        _dir: dir,
        store,
        source,
    }
}

#[test]
fn a_person_can_seal_a_document_and_get_the_same_bytes_back() {
    let f = given_a_store_with_a_document();

    // When they attach it...
    let added = run(
        &f.store,
        &[
            "pass",
            "attach",
            "add",
            "Taxes/w2",
            f.source.to_str().unwrap(),
        ],
    );
    assert!(added.status.success(), "attach add failed: {added:?}");
    assert!(stdout(&added).contains("3 chunk(s)"), "{}", stdout(&added));

    // ...it shows up as metadata, with no bytes leaked into the listing.
    let listed = run(&f.store, &["pass", "attach", "ls"]);
    let listing = stdout(&listed);
    assert!(listing.contains("Taxes/w2"), "{listing}");
    assert!(listing.contains("w2.pdf"), "{listing}");
    assert!(listing.contains("application/pdf"), "{listing}");

    // ...and it comes back byte-for-byte.
    let out = f.store.parent().unwrap().join("recovered.pdf");
    let got = run(
        &f.store,
        &[
            "pass",
            "attach",
            "get",
            "Taxes/w2",
            "--reveal",
            "--out",
            out.to_str().unwrap(),
        ],
    );
    assert!(got.status.success(), "attach get failed: {got:?}");
    assert_eq!(
        std::fs::read(&out).unwrap(),
        payload(),
        "the recovered document must be identical to the original"
    );
}

#[test]
fn an_agent_cannot_read_a_document_out_of_the_store() {
    let f = given_a_store_with_a_document();
    run(
        &f.store,
        &[
            "pass",
            "attach",
            "add",
            "Taxes/w2",
            f.source.to_str().unwrap(),
        ],
    );

    // No TTY and no --reveal is exactly the shape of an agent invocation.
    let out = f.store.parent().unwrap().join("stolen.pdf");
    let denied = run(
        &f.store,
        &[
            "pass",
            "attach",
            "get",
            "Taxes/w2",
            "--out",
            out.to_str().unwrap(),
        ],
    );
    assert!(!denied.status.success(), "reveal gate must refuse");
    assert!(
        String::from_utf8_lossy(&denied.stderr).contains("--reveal"),
        "the refusal should name the flag: {}",
        String::from_utf8_lossy(&denied.stderr)
    );
    assert!(!out.exists(), "a refused read must not leave a file behind");
}

#[test]
fn sealed_bytes_reach_git_and_local_state_does_not() {
    let f = given_a_store_with_a_document();
    run(
        &f.store,
        &[
            "pass",
            "attach",
            "add",
            "Taxes/w2",
            f.source.to_str().unwrap(),
        ],
    );

    let tracked = Command::new("git")
        .args(["ls-files"])
        .current_dir(&f.store)
        .output()
        .expect("git ls-files");
    let tracked = String::from_utf8_lossy(&tracked.stdout);

    assert!(
        tracked.contains("Taxes/w2.osattach"),
        "the manifest must be committed: {tracked}"
    );
    assert_eq!(
        tracked.matches(".oschunk").count(),
        3,
        "every chunk must be committed: {tracked}"
    );
    assert!(
        !tracked.contains("attachment-revisions"),
        "anti-rollback state is local-only and must never be committed: {tracked}"
    );
}

#[test]
fn nothing_in_the_store_reveals_the_document() {
    let f = given_a_store_with_a_document();
    run(
        &f.store,
        &[
            "pass",
            "attach",
            "add",
            "Taxes/w2",
            f.source.to_str().unwrap(),
        ],
    );

    // The plaintext has a long, highly distinctive run; if any of it survived
    // into the store unencrypted, this finds it.
    let needle: Vec<u8> = (0..64usize).map(fixture_byte).collect();
    let mut checked = 0usize;
    for entry in walk(&f.store) {
        let bytes = std::fs::read(&entry).unwrap_or_default();
        checked += 1;
        assert!(
            !bytes.windows(needle.len()).any(|w| w == needle.as_slice()),
            "plaintext found in {}",
            entry.display()
        );
    }
    assert!(checked > 3, "expected to have scanned real files");
}

#[test]
fn fixture_byte_conversion_covers_modulus_boundary() {
    assert_eq!(fixture_byte(250), 250);
    assert_eq!(fixture_byte(251), 0);
    assert_eq!(
        fixture_byte(usize::MAX),
        u8::try_from(usize::MAX % 251).unwrap()
    );
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // Skip .git: it holds the same ciphertext, just packed.
        if path.file_name().is_some_and(|n| n == ".git") {
            continue;
        }
        if path.is_dir() {
            out.extend(walk(&path));
        } else {
            out.push(path);
        }
    }
    out
}
