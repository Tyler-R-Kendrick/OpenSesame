use super::*;

use std::collections::BTreeSet;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

/// The first `node` a trusted entry holds, and the ones passed over.
struct NodeSearch {
    node: Option<PathBuf>,
    rejected: Vec<(PathBuf, Skip)>,
}

fn find_node(trusted: &[PathBuf], on: &Host) -> NodeSearch {
    let found = opensesame_trusted_exec::find(on.platform.file_name("node").as_str(), trusted, on);
    NodeSearch {
        node: found.program,
        rejected: found.rejected,
    }
}

pub(super) fn dir(mode: u32) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(mode)).unwrap();
    dir
}

pub(super) fn plant(dir: &Path, mode: u32) -> PathBuf {
    let node = dir.join("node");
    std::fs::write(&node, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&node, std::fs::Permissions::from_mode(mode)).unwrap();
    node
}

pub(super) fn os(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
    pairs
        .iter()
        .map(|(n, v)| (OsString::from(n), OsString::from(v)))
        .collect()
}

pub(super) fn host(path: &OsStr, platform: Platform, cwd: Option<&Path>) -> Host {
    let mut vars = os(&[
        ("HOME", "/home/dummy"),
        ("OPENSESAME_STORE_PASSWORD", "dummy"),
    ]);
    vars.push((OsString::from("PATH"), path.to_owned()));
    Host {
        vars,
        cwd: cwd.map(Path::to_path_buf),
        platform,
        caller: Caller::current(),
    }
}

/// The owner of `path` as `stat` reports it.
fn owner_of(path: &Path) -> Owner {
    Owner::from(&std::fs::metadata(path).unwrap())
}

pub(super) fn joined(parts: &[&Path]) -> OsString {
    std::env::join_paths(parts).unwrap()
}

#[test]
fn directories_that_are_absolute_existing_and_private_are_searched_in_order() {
    let (a, b) = (dir(0o700), dir(0o755));
    let path = joined(&[a.path(), b.path()]);
    let found = search(&path, &host(&path, Platform::Unix, None));
    assert_eq!(found.trusted, [a.path(), b.path()]);
    assert!(found.skipped.is_empty());
}

#[test]
fn empty_relative_missing_and_non_directory_entries_are_skipped_with_their_reason() {
    let good = dir(0o700);
    let file = good.path().join("a-file");
    std::fs::write(&file, "x").unwrap();
    let missing = good.path().join("missing");
    let path = joined(&[
        Path::new(""),
        Path::new("."),
        Path::new("./bin"),
        Path::new("bin"),
        &missing,
        &file,
        good.path(),
    ]);
    let found = search(&path, &host(&path, Platform::Unix, None));
    assert_eq!(found.trusted, [good.path()]);
    let skipped: Vec<_> = found
        .skipped
        .iter()
        .map(|(d, s)| (d.display().to_string(), s.clone()))
        .collect();
    assert_eq!(
        skipped,
        [
            (String::new(), Skip::Empty),
            (".".into(), Skip::Relative),
            ("./bin".into(), Skip::Relative),
            ("bin".into(), Skip::Relative),
            (missing.display().to_string(), Skip::NotADirectory),
            (file.display().to_string(), Skip::NotADirectory),
        ]
    );
}

#[test]
fn a_directory_only_the_caller_and_its_groups_can_write_is_searched_on_unix() {
    // Created here, so owned by this user and group: the layouts of a package
    // manager under `umask 002` (`user:user 0775`) and of root's own (0755).
    for (mode, skipped) in [
        (0o700, None),
        (0o755, None),
        (0o775, None),
        (0o770, None),
        (0o757, Some(Skip::WritableByOthers)),
        (0o777, Some(Skip::WritableByOthers)),
        (0o1777, Some(Skip::WritableByOthers)),
    ] {
        let d = dir(mode);
        let path = joined(&[d.path()]);
        let found = search(&path, &host(&path, Platform::Unix, None));
        assert_eq!(
            found.trusted.len(),
            usize::from(skipped.is_none()),
            "{mode:o}"
        );
        assert_eq!(
            found.skipped.first().map(|(_, s)| s.clone()),
            skipped,
            "{mode:o}"
        );
    }
}

#[test]
fn the_real_stat_reaches_the_decision_for_owner_and_group() {
    let d = dir(0o775);
    let (path, owner) = (joined(&[d.path()]), owner_of(d.path()));
    // Someone else is asking: a directory this user owns is not theirs.
    if owner.uid != 0 {
        let mut other = host(&path, Platform::Unix, None);
        other.caller = Caller {
            euid: owner.uid + 1,
            groups: vec![owner.gid],
        };
        let found = search(&path, &other);
        assert_eq!(found.skipped[0].1, Skip::OwnedBy(owner.uid));
    }
    // A caller outside the directory's group, with the group able to write it.
    if owner.gid != 0 {
        let mut outsider = host(&path, Platform::Unix, None);
        outsider.caller = Caller {
            euid: owner.uid,
            groups: vec![owner.gid + 1],
        };
        let found = search(&path, &outsider);
        assert_eq!(found.skipped[0].1, Skip::GroupWritable(owner.gid));
    }
}

#[test]
fn the_current_directory_is_skipped_on_windows_even_when_named_absolutely() {
    let cwd = dir(0o700);
    let other = dir(0o700);
    let path = joined(&[cwd.path(), other.path()]);
    let on_windows = search(&path, &host(&path, Platform::Windows, Some(cwd.path())));
    assert_eq!(on_windows.trusted, [other.path()]);
    assert_eq!(on_windows.skipped[0].1, Skip::CurrentDirectory);
    // On Unix an absolute entry is a deliberate choice, so it is kept.
    let on_unix = search(&path, &host(&path, Platform::Unix, Some(cwd.path())));
    assert_eq!(on_unix.trusted, [cwd.path(), other.path()]);
}

#[test]
fn the_first_executable_file_called_node_wins() {
    let (no_node, not_executable, first, second) = (dir(0o700), dir(0o700), dir(0o700), dir(0o700));
    std::fs::create_dir(no_node.path().join("node")).unwrap(); // a directory by that name
    plant(not_executable.path(), 0o644);
    let want = plant(first.path(), 0o755);
    plant(second.path(), 0o755);
    let trusted: Vec<PathBuf> = [&no_node, &not_executable, &first, &second]
        .iter()
        .map(|d| d.path().to_path_buf())
        .collect();
    let on = host(OsStr::new(""), Platform::Unix, None);
    assert_eq!(find_node(&trusted, &on).node, Some(want));
    assert_eq!(find_node(&trusted[..2], &on).node, None);
    assert_eq!(find_node(&[], &on).node, None);
}

#[test]
fn a_node_anyone_can_write_is_passed_over_and_recorded() {
    let (world, group, fine) = (dir(0o700), dir(0o700), dir(0o700));
    let rejected_world = plant(world.path(), 0o777);
    let accepted_group = plant(group.path(), 0o775); // `user:user 0775` is fine
    plant(fine.path(), 0o755);
    let on = host(OsStr::new(""), Platform::Unix, None);
    let found = find_node(
        &[world.path().to_path_buf(), group.path().to_path_buf()],
        &on,
    );
    assert_eq!(found.node, Some(accepted_group));
    assert_eq!(found.rejected, [(rejected_world, Skip::WritableByOthers)]);
    // A caller that is not the file's owner does not run it, and it is said.
    let owner = owner_of(&group.path().join("node"));
    if owner.uid != 0 {
        let mut other = host(OsStr::new(""), Platform::Unix, None);
        other.caller = Caller {
            euid: owner.uid + 1,
            groups: vec![],
        };
        let found = find_node(&[group.path().to_path_buf()], &other);
        assert_eq!(found.node, None);
        assert_eq!(found.rejected[0].1, Skip::OwnedBy(owner.uid));
    }
}

#[test]
fn only_the_listed_variables_reach_the_bridge_and_path_is_rebuilt() {
    let trusted = [PathBuf::from("/opt/node/bin"), PathBuf::from("/usr/bin")];
    let vars = os(&[
        ("HOME", "/home/dummy"),
        ("TMPDIR", "/tmp"),
        ("LANG", "C.UTF-8"),
        ("LC_ALL", "C"),
        ("LC_API_KEY", "dummy"),
        ("PATH", ".:/tmp/evil"),
        ("OPENSESAME_STORE_PASSWORD", "dummy"),
        ("OPENSESAME_ENV_PARSE", "/x"),
        ("NODE_OPTIONS", "--require /x"),
        ("NODE_PATH", "/x"),
        ("npm_config_registry", "https://registry.invalid"),
        ("GITHUB_TOKEN", "dummy"),
        ("DB_PASSWORD", "dummy"),
        ("HTTPS_PROXY", "http://u:p@proxy.invalid"),
        ("SystemRoot", "C:\\Windows"),
        ("home", "lower-case"),
    ]);
    let got = bridge_environment(&vars, &trusted, Platform::Unix).unwrap();
    let names: BTreeSet<_> = got.iter().map(|(n, _)| n.to_str().unwrap()).collect();
    assert_eq!(
        names,
        BTreeSet::from(["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"])
    );
    let path = got.iter().find(|(n, _)| n == "PATH").unwrap();
    assert_eq!(
        path.1,
        joined(&[Path::new("/opt/node/bin"), Path::new("/usr/bin")])
    );
}

#[test]
fn windows_folds_the_case_of_names_and_adds_its_three() {
    let vars = os(&[
        ("systemroot", "C:\\Windows"),
        ("Pathext", ".EXE"),
        ("ComSpec", "cmd.exe"),
        ("Home", "C:\\Users\\dummy"),
        ("OPENSESAME_STORE_PASSWORD", "dummy"),
    ]);
    let got = bridge_environment(&vars, &[PathBuf::from("/node")], Platform::Windows).unwrap();
    let names: BTreeSet<_> = got
        .iter()
        .map(|(n, _)| n.to_str().unwrap().to_ascii_uppercase())
        .collect();
    assert_eq!(
        names,
        BTreeSet::from(["COMSPEC", "HOME", "PATH", "PATHEXT", "SYSTEMROOT"].map(String::from))
    );
    // And not on Unix, where names are exact and SystemRoot means nothing.
    assert!(!is_passed(OsStr::new("SystemRoot"), Platform::Unix));
    assert!(!is_passed(OsStr::new("home"), Platform::Unix));
}

#[test]
fn nothing_on_the_allowance_looks_like_a_secret_or_a_loader() {
    for name in PASSED.iter().chain(&LOCALE).chain(&PASSED_ON_WINDOWS) {
        let upper = name.to_ascii_uppercase();
        for bad in ["OPENSESAME_", "NODE_", "NPM_"] {
            assert!(!upper.starts_with(bad), "{name}");
        }
        for bad in ["TOKEN", "SECRET", "PASSWORD", "KEY", "PASSPHRASE", "PROXY"] {
            assert!(!upper.ends_with(bad), "{name}");
        }
    }
}

#[test]
fn the_command_runs_the_node_it_found_by_absolute_path_with_nothing_inherited() {
    let bin = dir(0o700);
    let want = plant(bin.path(), 0o755);
    let path = joined(&[Path::new(""), Path::new("./bin"), bin.path()]);
    let command = node_command_for(&host(&path, Platform::Unix, None)).unwrap();
    assert_eq!(command.get_program(), want.as_os_str());
    assert!(Path::new(command.get_program()).is_absolute());
    let set: BTreeSet<_> = command
        .get_envs()
        .map(|(n, v)| {
            (
                n.to_str().unwrap(),
                v.map(|v| v.to_str().unwrap().to_owned()),
            )
        })
        .collect();
    let expected = BTreeSet::from([
        ("HOME", Some("/home/dummy".to_owned())),
        ("PATH", Some(bin.path().display().to_string())),
    ]);
    assert_eq!(set, expected);
}

#[test]
fn no_node_is_an_error_that_says_what_was_skipped_and_never_falls_back() {
    let planted = dir(0o700);
    plant(planted.path(), 0o755);
    let writable = dir(0o777);
    plant(writable.path(), 0o755);
    let path = joined(&[Path::new(""), Path::new("."), writable.path()]);
    let err = node_command_for(&host(&path, Platform::Unix, Some(planted.path())))
        .unwrap_err()
        .to_string();
    for want in [
        "no usable `node`",
        "PATH has none",
        "\"\" empty entry",
        "\".\" relative",
        "writable by others",
    ] {
        assert!(err.contains(want), "{want:?} not in: {err}");
    }
    // The directory holding a `node` and no other entry: still named.
    let lone = dir(0o700);
    let path = joined(&[lone.path()]);
    let err = node_command_for(&host(&path, Platform::Unix, None))
        .unwrap_err()
        .to_string();
    assert!(err.contains("holds a `node`"), "{err}");
    // A directory that is fine holding a `node` that is not: both are named.
    let bad = dir(0o700);
    let node = plant(bad.path(), 0o757);
    let path = joined(&[bad.path()]);
    let err = node_command_for(&host(&path, Platform::Unix, None))
        .unwrap_err()
        .to_string();
    let said = format!("node \"{}\" writable by others", node.display());
    assert!(err.contains(&said), "{said} not in: {err}");
    // No PATH at all.
    let unset = Host {
        vars: os(&[("HOME", "/home/dummy")]),
        cwd: None,
        platform: Platform::Unix,
        caller: Caller::current(),
    };
    let err = node_command_for(&unset).unwrap_err().to_string();
    assert!(err.contains("PATH is not set"), "{err}");
}

#[test]
fn path_is_found_whatever_its_case_on_windows_only() {
    let bin = dir(0o700);
    plant(bin.path(), 0o755);
    let mut host = host(OsStr::new(""), Platform::Windows, None);
    host.vars.retain(|(n, _)| n != "PATH");
    host.vars
        .push((OsString::from("Path"), joined(&[bin.path()])));
    // Windows looks for `node.exe`, which the fixture is not; the case of
    // `Path` is what is under test: it is read, and the error is about the
    // directory, not about PATH being unset.
    let err = node_command_for(&host).unwrap_err().to_string();
    assert!(err.contains("holds a `node`"), "{err}");
    host.platform = Platform::Unix;
    assert!(node_command_for(&host)
        .unwrap_err()
        .to_string()
        .contains("PATH is not set"));
}
