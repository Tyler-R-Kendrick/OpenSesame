use super::*;

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;

use super::super::tests::{dir, host, joined, plant};
use super::super::{node_command_for, Host, Platform};

fn file(dir: &Path, name: &str, mode: u32) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
    path
}

fn refusal(value: &str) -> String {
    node(OsStr::new(value)).unwrap_err().to_string()
}

#[test]
fn an_absolute_executable_file_is_used_whatever_its_mode_or_directory() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o777)).unwrap();
    for mode in [0o700, 0o755, 0o775, 0o777, 0o757, 0o100] {
        let path = file(dir.path(), "node", mode);
        assert_eq!(node(path.as_os_str()).unwrap(), path, "{mode:o}");
    }
}

#[test]
fn a_symlink_is_followed_to_a_regular_executable_file() {
    let dir = tempfile::tempdir().unwrap();
    let real = file(dir.path(), "real", 0o755);
    let link = dir.path().join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    assert_eq!(node(link.as_os_str()).unwrap(), link);
    // To a directory, to a file nobody can run, or to nothing: refused.
    let to_dir = dir.path().join("to-dir");
    std::os::unix::fs::symlink(dir.path(), &to_dir).unwrap();
    assert!(refusal(&to_dir.display().to_string()).contains("not a regular file"));
    let plain = file(dir.path(), "plain", 0o644);
    let to_plain = dir.path().join("to-plain");
    std::os::unix::fs::symlink(&plain, &to_plain).unwrap();
    assert!(refusal(&to_plain.display().to_string()).contains("not executable"));
    let dangling = dir.path().join("dangling");
    std::os::unix::fs::symlink(dir.path().join("nowhere"), &dangling).unwrap();
    assert!(refusal(&dangling.display().to_string()).contains("does not exist"));
}

#[test]
fn every_value_that_cannot_be_used_is_refused_naming_the_variable_and_why() {
    let dir = tempfile::tempdir().unwrap();
    let plain = file(dir.path(), "plain", 0o644);
    let missing = dir.path().join("missing");
    let table = [
        ("", "is set but empty"),
        ("node", "must be an absolute path"),
        ("./node", "must be an absolute path"),
        ("../bin/node", "must be an absolute path"),
        (" /usr/bin/node", "must be an absolute path"),
        (&missing.display().to_string(), "does not exist"),
        (&dir.path().display().to_string(), "is not a regular file"),
        (&plain.display().to_string(), "is not executable"),
    ];
    for (value, why) in table {
        let said = refusal(value);
        assert!(said.starts_with("OPENSESAME_NODE "), "{value:?}: {said}");
        assert!(said.contains(why), "{value:?}: {said}");
    }
}

#[test]
fn a_relative_value_is_refused_even_when_that_file_exists_in_the_working_directory() {
    // The test's own working directory holds Cargo.toml.
    assert!(refusal("Cargo.toml").contains("must be an absolute path"));
}

fn with_operator_node(mut on: Host, value: &OsStr) -> Host {
    on.vars
        .push((OsString::from("OPENSESAME_NODE"), value.to_owned()));
    on
}

#[test]
fn the_operators_node_wins_over_a_trusted_one_and_is_not_forwarded() {
    let (trusted, chosen) = (dir(0o700), dir(0o700));
    plant(trusted.path(), 0o755);
    let want = plant(chosen.path(), 0o755);
    let path = joined(&[trusted.path()]);
    let on = with_operator_node(host(&path, Platform::Unix, None), want.as_os_str());
    let command = node_command_for(&on).unwrap();
    assert_eq!(command.get_program(), want.as_os_str());
    let names: BTreeSet<_> = command
        .get_envs()
        .map(|(n, _)| n.to_str().unwrap().to_owned())
        .collect();
    // The variable that chose the node is not among what the node is given,
    // nor is anything else named OPENSESAME_*.
    assert_eq!(
        names,
        BTreeSet::from(["HOME".to_owned(), "PATH".to_owned()])
    );
}

#[test]
fn the_operators_node_is_used_where_no_path_entry_could_supply_one() {
    // A 0777 file in a 0777 directory, and a PATH with nothing usable.
    let open = dir(0o777);
    let want = plant(open.path(), 0o777);
    let path = joined(&[Path::new(""), Path::new("."), open.path()]);
    assert!(node_command_for(&host(&path, Platform::Unix, None)).is_err());
    let on = with_operator_node(host(&path, Platform::Unix, None), want.as_os_str());
    assert_eq!(
        node_command_for(&on).unwrap().get_program(),
        want.as_os_str()
    );
}

#[test]
fn a_bad_operator_value_is_an_error_naming_it_even_with_a_trusted_node_on_path() {
    let trusted = dir(0o700);
    plant(trusted.path(), 0o755);
    let path = joined(&[trusted.path()]);
    assert!(node_command_for(&host(&path, Platform::Unix, None)).is_ok());
    for value in ["", "node", "./node", "/nonexistent/node"] {
        let on = with_operator_node(host(&path, Platform::Unix, None), OsStr::new(value));
        let err = node_command_for(&on).unwrap_err();
        assert!(
            matches!(err, EnvSpecError::NodeOverride(_)),
            "{value:?}: {err:?}"
        );
        assert!(
            err.to_string().starts_with("OPENSESAME_NODE "),
            "{value:?}: {err}"
        );
    }
}
