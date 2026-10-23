//! `OPENSESAME_NODE` makes the chosen `node` the one `opensesame-id` finds,
//! and opens no directory to do it.

use super::*;
use opensesame_trusted_exec::testkit::Fixture;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

const ID: &str = "opensesame-id";

/// A `node` where anyone can write, which no `PATH` search would accept.
fn node_in_the_open(fixture: &Fixture) -> PathBuf {
    let node = fixture.planted.join("node");
    std::fs::write(&node, "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
    node
}

fn run(
    fixture: &Fixture,
    extra: &[(&str, &str)],
) -> (anyhow::Result<Option<TempDir>>, Option<Vec<PathBuf>>) {
    let lookup = fixture.lookup(extra);
    let mut command = crate::vault_file::id_cli_in(&lookup).unwrap();
    let guard = provide(&mut command, &lookup);
    if guard.is_ok() {
        // A just-written helper can briefly report ETXTBSY on Linux when a
        // sibling test forks while the write descriptor is still closing.
        let mut attempts = 0;
        let status = loop {
            match command.status() {
                Ok(status) => break status,
                Err(error) if error.raw_os_error() == Some(26) && attempts < 20 => {
                    attempts += 1;
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(error) => panic!("helper failed to start: {error}"),
            }
        };
        assert!(status.success());
    }
    let path = fixture.env().and_then(|env| {
        env.get("PATH")
            .map(|path| std::env::split_paths(path).collect())
    });
    (guard, path)
}

#[test]
fn without_opensesame_node_the_path_is_the_trusted_entries_alone() {
    let fixture = Fixture::new(ID);
    let (guard, path) = run(&fixture, &[]);
    assert!(guard.unwrap().is_none());
    assert_eq!(path.unwrap(), [fixture.trusted.clone()]);
}

#[test]
fn the_node_it_names_comes_first_through_one_private_link_and_its_directory_stays_closed() {
    let fixture = Fixture::new(ID);
    let node = node_in_the_open(&fixture);
    let (guard, path) = run(&fixture, &[(NODE_OVERRIDE, node.to_str().unwrap())]);
    let guard = guard.unwrap().expect("a link directory");
    let path = path.unwrap();
    assert_eq!(path, [guard.path().to_path_buf(), fixture.trusted.clone()]);
    assert!(
        !path.contains(&fixture.planted),
        "the open directory is on PATH"
    );
    assert_eq!(std::fs::read_link(guard.path().join("node")).unwrap(), node);
    let mode = std::fs::metadata(guard.path())
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o077, 0, "the link directory is private: {mode:o}");
    let env = fixture.env().unwrap();
    assert!(
        !env.contains_key(NODE_OVERRIDE),
        "the variable was handed on"
    );
}

#[test]
fn the_link_is_gone_when_the_child_is_done() {
    let fixture = Fixture::new(ID);
    let node = node_in_the_open(&fixture);
    let (guard, _) = run(&fixture, &[(NODE_OVERRIDE, node.to_str().unwrap())]);
    let dir = guard.unwrap().unwrap();
    let at = dir.path().to_path_buf();
    drop(dir);
    assert!(!at.exists());
}

#[test]
fn an_unusable_node_is_an_error_naming_the_variable_and_the_child_does_not_start() {
    let fixture = Fixture::new(ID);
    let (guard, path) = run(&fixture, &[(NODE_OVERRIDE, "node")]);
    let error = guard.unwrap_err().to_string();
    assert!(
        error.starts_with("OPENSESAME_NODE must be an absolute path"),
        "{error}"
    );
    assert!(path.is_none() && !fixture.planted_ran());
}
