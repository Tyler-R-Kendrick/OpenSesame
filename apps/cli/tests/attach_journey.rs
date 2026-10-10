//! End-to-end behaviour of `opensesame pass attach`, driven through the real
//! binary rather than the library.
//!
//! The unit and property suites cover the crypto. What they cannot show is
//! that a person can put a document in and get the same bytes back out, that
//! an agent cannot, and that the ciphertext actually reaches git — the three
//! things the feature exists to do.

use std::io::Read;
use std::os::unix::io::FromRawFd;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

const PASSPHRASE: &str = "correct horse battery staple";

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_opensesame")
}

fn command(store: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(bin());
    command
        .args(args)
        .arg("--path")
        .arg(store)
        .env("OPENSESAME_STORE_PASSWORD", PASSPHRASE)
        // Keep the store's git identity local to the temp dir.
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        .env("OPENSESAME_CLI_APP_INTEGRATION_SEAM", "approve");
    command
}

fn run(store: &Path, args: &[&str]) -> Output {
    command(store, args)
        .output()
        .expect("failed to run the opensesame binary")
}

/// A person at a terminal: stdin and stdout are both the slave side of a pty.
/// Piped `Command::output` is the agent shape, and the reveal gate refuses it.
fn run_as_person(store: &Path, args: &[&str]) -> Output {
    let mut master_fd: libc::c_int = -1;
    let mut slave_fd: libc::c_int = -1;
    let opened = unsafe {
        libc::openpty(
            &raw mut master_fd,
            &raw mut slave_fd,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    assert_eq!(opened, 0, "openpty");
    let master = unsafe { std::fs::File::from_raw_fd(master_fd) };
    let slave = unsafe { std::fs::File::from_raw_fd(slave_fd) };
    let slave_in = slave.try_clone().expect("dup slave for stdin");
    let slave_out = slave.try_clone().expect("dup slave for stdout");
    drop(slave);

    let mut child = command(store, args)
        .stdin(Stdio::from(slave_in))
        .stdout(Stdio::from(slave_out))
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to run the opensesame binary");
    let stdout_thread = std::thread::spawn(move || {
        let mut master = master;
        let mut buf = Vec::new();
        let _ = master.read_to_end(&mut buf);
        buf
    });
    let mut stderr_pipe = child.stderr.take().expect("stderr");
    let stderr_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buf);
        buf
    });
    let status = child.wait().expect("wait for opensesame");
    Output {
        status,
        stdout: stdout_thread.join().expect("stdout thread"),
        stderr: stderr_thread.join().expect("stderr thread"),
    }
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

    // ...and it comes back byte-for-byte, with a person at the terminal.
    let out = f.store.parent().unwrap().join("recovered.pdf");
    let got = run_as_person(
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
    // Off a terminal the gate names that fact before it mentions --reveal.
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
        String::from_utf8_lossy(&denied.stderr).contains("interactive terminals"),
        "the refusal should name the terminal: {}",
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
fn a_dot_named_document_survives_gc_and_reaches_a_replica() {
    let f = given_a_store_with_a_document();
    let added = run(
        &f.store,
        &[
            "pass",
            "attach",
            "add",
            "Dev/.w2",
            f.source.to_str().unwrap(),
        ],
    );
    assert!(added.status.success(), "attach add failed: {added:?}");

    // Age every chunk past the grace window, so GC would reclaim any chunk it
    // failed to account for.
    let aged = std::time::SystemTime::now() - std::time::Duration::from_secs(2 * 3600);
    let chunks: Vec<PathBuf> = walk(&f.store)
        .into_iter()
        .filter(|p| p.extension().is_some_and(|e| e == "oschunk"))
        .collect();
    assert_eq!(chunks.len(), 3, "the document spans three chunks");
    for chunk in &chunks {
        std::fs::File::options()
            .write(true)
            .open(chunk)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(aged))
            .unwrap();
    }

    let gc = run(&f.store, &["pass", "attach", "gc"]);
    assert!(gc.status.success(), "attach gc failed: {gc:?}");
    assert!(
        stdout(&gc).contains("removed 0 orphan(s)"),
        "{}",
        stdout(&gc)
    );
    assert!(
        chunks.iter().all(|c| c.exists()),
        "no referenced chunk may go"
    );

    let out = f.store.parent().unwrap().join("recovered.pdf");
    let got = run_as_person(
        &f.store,
        &[
            "pass",
            "attach",
            "get",
            "Dev/.w2",
            "--reveal",
            "--out",
            out.to_str().unwrap(),
        ],
    );
    assert!(got.status.success(), "attach get failed: {got:?}");
    assert_eq!(std::fs::read(&out).unwrap(), payload());

    let replica = f.store.parent().unwrap().join("replica");
    let synced = run(
        &f.store,
        &[
            "pass",
            "attach",
            "sync",
            "--to-dir",
            replica.to_str().unwrap(),
        ],
    );
    assert!(synced.status.success(), "attach sync failed: {synced:?}");
    let copied = walk(&replica);
    assert!(
        copied
            .iter()
            .any(|p| p.ends_with("attachments/Dev/.w2.osattach")),
        "the manifest must be replicated: {copied:?}"
    );
    assert_eq!(
        copied
            .iter()
            .filter(|p| p.extension().is_some_and(|e| e == "oschunk"))
            .count(),
        3,
        "every chunk must be replicated: {copied:?}"
    );
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
