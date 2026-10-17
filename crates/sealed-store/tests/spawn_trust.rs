//! The store's `git` is found by the trusted rule and handed only what it
//! needs, through the crate's public functions. These tests point this
//! process's own environment at a planted `PATH`, so each holds `ENV`.
#![cfg(unix)]

use std::ffi::OsString;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use opensesame_trusted_exec::testkit::Fixture;

static ENV: Mutex<()> = Mutex::new(());

/// This process's environment set to `fixture`'s lookup plus `extra`, put
/// back as it was when dropped.
struct Entered<'a> {
    saved: Vec<(OsString, Option<OsString>)>,
    _lock: MutexGuard<'a, ()>,
}

fn enter<'a>(fixture: &Fixture, extra: &[(&str, &str)]) -> Entered<'a> {
    let lock = ENV
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut saved = Vec::new();
    for (name, value) in fixture.lookup(extra).vars {
        saved.push((name.clone(), std::env::var_os(&name)));
        std::env::set_var(&name, value);
    }
    Entered { saved, _lock: lock }
}

impl Drop for Entered<'_> {
    fn drop(&mut self) {
        for (name, value) in self.saved.drain(..).rev() {
            match value {
                Some(value) => std::env::set_var(&name, value),
                None => std::env::remove_var(&name),
            }
        }
    }
}

const TOKEN: &str = "vtok_dummy_push_0123456789abcdef";
const URL: &str = "https://forge.invalid/store.git";

fn store(fixture: &Fixture) -> std::path::PathBuf {
    fixture.scratch("store")
}

#[test]
fn a_backup_push_runs_the_trusted_git_with_its_token_its_proxy_and_nothing_else() {
    let fixture = Fixture::new("git");
    fixture.stub_recorder_saying(&fixture.trusted.join("git"), URL);
    let root = store(&fixture);
    let configured = [
        ("HTTPS_PROXY", "http://proxy.invalid:3128"),
        ("GIT_SSH_COMMAND", "/planted/ssh"),
    ];
    let pushed = {
        let _env = enter(&fixture, &configured);
        opensesame_sealed_store::push_backup(&root, Some(TOKEN))
    };
    let env = fixture.assert_clean();
    pushed.unwrap();
    let token_env = opensesame_sealed_store::GIT_TOKEN_ENV;
    assert_eq!(env.get(token_env).map(String::as_str), Some(TOKEN));
    assert_eq!(
        env.get("HTTPS_PROXY").map(String::as_str),
        Some("http://proxy.invalid:3128")
    );
    assert!(!env.contains_key("GIT_SSH_COMMAND"), "{env:?}");
    let args = fixture.args().unwrap();
    assert!(
        args.iter().any(|a| a.starts_with("credential.helper=")),
        "{args:?}"
    );
    assert_eq!(args[args.len() - 4..], ["push", "-u", "origin", "HEAD"]);
}

#[test]
fn every_store_git_command_is_the_trusted_one() {
    let fixture = Fixture::new("git");
    fixture.stub_recorder_saying(&fixture.trusted.join("git"), URL);
    let root = store(&fixture);
    let (status, url) = {
        let _env = enter(&fixture, &[]);
        let status = opensesame_sealed_store::git_passthrough(&root, &["status".into()]);
        (status, opensesame_sealed_store::remote_url(&root))
    };
    let _ = fixture.assert_clean();
    assert_eq!(status.unwrap(), 0);
    assert_eq!(url.as_deref(), Some(URL));
    assert_eq!(fixture.args().unwrap(), ["remote", "get-url", "origin"]);
}

#[test]
fn opensesame_git_names_the_exact_git_even_where_anyone_can_write() {
    let fixture = Fixture::new("git");
    let chosen = fixture.planted.join("chosen-git");
    fixture.stub_recorder_saying(&chosen, URL);
    let root = store(&fixture);
    let value = chosen.display().to_string();
    let url = {
        let _env = enter(&fixture, &[("OPENSESAME_GIT", &value)]);
        opensesame_sealed_store::remote_url(&root)
    };
    let env = fixture.assert_clean();
    assert_eq!(url.as_deref(), Some(URL));
    assert!(!env.contains_key("OPENSESAME_GIT"));
    assert!(Path::new(&value).exists());
}

#[test]
fn the_parents_secrets_and_git_redirections_never_reach_git() {
    // Nothing planted: the only `git` is the trusted one, so what is under
    // test is what it is handed.
    let fixture = Fixture::new("git");
    std::fs::remove_file(fixture.planted.join("git")).unwrap();
    fixture.stub_recorder_saying(&fixture.trusted.join("git"), URL);
    let root = store(&fixture);
    let url = {
        let _env = enter(&fixture, &[("LC_ALL", "C")]);
        opensesame_sealed_store::remote_url(&root)
    };
    let env = fixture.assert_clean();
    assert_eq!(url.as_deref(), Some(URL));
    assert_eq!(env.get("LC_ALL").map(String::as_str), Some("C"));
}
