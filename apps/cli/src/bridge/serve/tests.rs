//! The bridge is the file named or the one beside this `opensesame`, and a
//! name left to `PATH` is never a way to find it.

use super::*;
use std::os::unix::fs::PermissionsExt;

const BRIDGE: &str = "opensesame-keepassxc-bridge";

fn executable(dir: &std::path::Path, name: &str) -> PathBuf {
    let file = dir.join(name);
    std::fs::write(&file, "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
    file
}

#[test]
fn the_bridge_beside_this_opensesame_is_the_one_run() {
    let dir = tempfile::tempdir().unwrap();
    let exe = executable(dir.path(), "opensesame");
    let bridge = executable(dir.path(), BRIDGE);
    assert_eq!(binary(None, Ok(exe)).unwrap(), bridge);
}

#[test]
fn with_no_bridge_beside_it_the_bare_name_is_not_a_fallback() {
    let dir = tempfile::tempdir().unwrap();
    let exe = executable(dir.path(), "opensesame");
    let error = binary(None, Ok(exe)).unwrap_err().to_string();
    assert!(error.contains(BRIDGE) && error.contains("--bin"), "{error}");
}

#[test]
fn without_knowing_where_it_is_the_bridge_is_not_guessed() {
    let error = binary(None, Err(io::Error::other("no /proc")))
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("cannot tell where this opensesame is"),
        "{error}"
    );
    assert!(error.contains("--bin"), "{error}");
}

#[test]
fn bin_names_an_exact_executable_file() {
    let dir = tempfile::tempdir().unwrap();
    let chosen = executable(dir.path(), "my-bridge");
    assert_eq!(
        binary(Some(chosen.clone()), Err(io::Error::other("x"))).unwrap(),
        chosen
    );
    let relative = binary(Some(PathBuf::from(BRIDGE)), Err(io::Error::other("x")));
    assert!(relative
        .unwrap_err()
        .to_string()
        .starts_with("--bin must be an absolute path"));
    let missing = dir.path().join("absent");
    assert!(binary(Some(missing), Err(io::Error::other("x")))
        .unwrap_err()
        .to_string()
        .contains("--bin does not exist"));
}
