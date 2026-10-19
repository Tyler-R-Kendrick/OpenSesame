use super::*;

use std::os::unix::fs::PermissionsExt;

fn file(dir: &Path, name: &str, mode: u32) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
    path
}

fn scratch() -> (crate::testkit::Fixture, PathBuf) {
    let fixture = crate::testkit::Fixture::new("unused");
    let dir = fixture.scratch("op");
    (fixture, dir)
}

fn refusal(variable: &str, value: &str) -> String {
    named(variable, OsStr::new(value)).unwrap_err().to_string()
}

#[test]
fn an_absolute_executable_file_is_used_whatever_its_mode_or_directory() {
    let (_fixture, dir) = scratch();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).unwrap();
    for mode in [0o700, 0o755, 0o775, 0o777, 0o757, 0o100] {
        let path = file(&dir, "git", mode);
        assert_eq!(named("OPENSESAME_GIT", path.as_os_str()).unwrap(), path);
    }
}

#[test]
fn a_symlink_is_followed_to_a_regular_executable_file() {
    let (_fixture, dir) = scratch();
    let real = file(&dir, "real", 0o755);
    let link = dir.join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    assert_eq!(named("OPENSESAME_GPG", link.as_os_str()).unwrap(), link);
    let to_dir = dir.join("to-dir");
    std::os::unix::fs::symlink(&dir, &to_dir).unwrap();
    let said = refusal("OPENSESAME_GPG", &to_dir.display().to_string());
    assert!(said.contains("not a regular file"), "{said}");
    let plain = file(&dir, "plain", 0o644);
    let said = refusal("OPENSESAME_GPG", &plain.display().to_string());
    assert!(said.contains("not executable"), "{said}");
    let dangling = dir.join("dangling");
    std::os::unix::fs::symlink(dir.join("nowhere"), &dangling).unwrap();
    let said = refusal("OPENSESAME_GPG", &dangling.display().to_string());
    assert!(said.contains("does not exist"), "{said}");
}

#[test]
fn every_value_that_cannot_be_used_is_refused_naming_its_own_variable() {
    let (_fixture, dir) = scratch();
    let plain = file(&dir, "plain", 0o644);
    let missing = dir.join("missing");
    let table = [
        ("", "is set but empty"),
        ("gh", "must be an absolute path"),
        ("./gh", "must be an absolute path"),
        ("../bin/gh", "must be an absolute path"),
        (" /usr/bin/gh", "must be an absolute path"),
        (&missing.display().to_string(), "does not exist"),
        (&dir.display().to_string(), "is not a regular file"),
        (&plain.display().to_string(), "is not executable"),
    ];
    for variable in ["OPENSESAME_GH", "OPENSESAME_SOPS_BIN"] {
        for (value, why) in &table {
            let said = refusal(variable, value);
            assert!(
                said.starts_with(&format!("{variable} ")),
                "{value:?}: {said}"
            );
            assert!(said.contains(why), "{value:?}: {said}");
        }
    }
}
