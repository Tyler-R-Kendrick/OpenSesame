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

/// Hands `path` to a group nobody in the returned caller's groups is in (the
/// caller is the current user with no supplementary group) and returns that
/// caller and the group. A file made by root is in root's group, which is
/// trusted, so it is moved to a stranger's; for anyone else its own group,
/// which is not 0, is already one the caller no longer lists.
pub(super) fn into_a_strangers_group(path: &Path) -> (Caller, u32) {
    use std::os::unix::fs::MetadataExt;
    let caller = Caller {
        euid: Caller::current().euid,
        groups: vec![],
    };
    let mut gid = std::fs::metadata(path).unwrap().gid();
    if gid == 0 {
        gid = 31337;
        std::os::unix::fs::chown(path, None, Some(gid)).expect("root can hand over a file");
    }
    (caller, gid)
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
fn the_current_directory_is_skipped_on_every_platform_even_when_named_absolutely() {
    let cwd = dir(0o700);
    let other = dir(0o700);
    let path = joined(&[cwd.path(), other.path()]);
    for platform in [Platform::Windows, Platform::Unix] {
        let found = search(&path, &host(&path, platform, Some(cwd.path())));
        assert_eq!(found.trusted, [other.path()], "{platform:?}");
        assert_eq!(found.skipped[0].1, Skip::CurrentDirectory, "{platform:?}");
    }
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
fn a_node_a_strangers_group_can_write_is_passed_over_and_recorded() {
    let dir = dir(0o700);
    let node = plant(dir.path(), 0o775);
    let (caller, gid) = into_a_strangers_group(&node);
    let mut on = host(OsStr::new(""), Platform::Unix, None);
    on.caller = caller;
    let found = find_node(&[dir.path().to_path_buf()], &on);
    assert_eq!(found.node, None);
    assert_eq!(found.rejected, [(node.clone(), Skip::GroupWritable(gid))]);
    // Not writable by that group, it is the same file and it runs.
    std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(find_node(&[dir.path().to_path_buf()], &on).node, Some(node));
}

mod environment;
