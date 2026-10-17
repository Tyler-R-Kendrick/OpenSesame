use super::*;

use std::ffi::OsString;
use std::os::unix::fs::{symlink, PermissionsExt};

use super::super::trust::Caller;

fn host(vars: &[(&str, &Path)]) -> Host {
    Host {
        vars: vars
            .iter()
            .map(|(n, v)| (OsString::from(n), v.as_os_str().to_owned()))
            .collect(),
        cwd: None,
        platform: Platform::Unix,
        caller: Caller::current(),
    }
}

fn chmod(path: &Path, mode: u32) {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

/// A directory of `mode` holding a stand-in `opensesame`, and the
/// executable's path.
fn kit(root: &Path, name: &str, mode: u32) -> PathBuf {
    let dir = root.join(name);
    std::fs::create_dir(&dir).unwrap();
    chmod(&dir, mode);
    let exe = dir.join("opensesame");
    std::fs::write(&exe, "stand-in").unwrap();
    chmod(&exe, 0o755);
    exe
}

fn bridge(dir: &Path, mode: u32) -> PathBuf {
    let path = dir.join(BESIDE);
    std::fs::write(&path, "// stand-in\n").unwrap();
    chmod(&path, mode);
    path.canonicalize().unwrap()
}

fn refusal(exe: &Path) -> String {
    match script_for(&host(&[]), Some(exe)) {
        Err(e @ EnvSpecError::BridgeScript(_)) => e.to_string(),
        other => panic!("not refused: {other:?}"),
    }
}

#[test]
fn a_bridge_beside_the_executable_that_only_root_or_the_caller_could_write_is_used() {
    let root = tempfile::tempdir().unwrap();
    for (name, dir_mode, file_mode) in [
        ("a", 0o755, 0o644),
        ("b", 0o700, 0o600),
        ("c", 0o775, 0o664),
        ("d", 0o755, 0o755),
    ] {
        let exe = kit(root.path(), name, dir_mode);
        let found = bridge(exe.parent().unwrap(), file_mode);
        assert_eq!(script_for(&host(&[]), Some(&exe)).unwrap(), found, "{name}");
    }
}

#[test]
fn with_nothing_beside_the_executable_the_checkouts_copy_is_run() {
    let root = tempfile::tempdir().unwrap();
    let exe = kit(root.path(), "kit", 0o755);
    let chosen = script_for(&host(&[]), Some(&exe)).unwrap();
    assert!(
        chosen.ends_with("packages/env-spec-bridge/bin/opensesame-env-parse.mjs"),
        "{}",
        chosen.display()
    );
    // And with no executable to look beside.
    assert_eq!(script_for(&host(&[]), None).unwrap(), chosen);
}

#[test]
fn the_override_wins_over_a_trusted_bridge_beside_the_executable() {
    let root = tempfile::tempdir().unwrap();
    let exe = kit(root.path(), "kit", 0o755);
    bridge(exe.parent().unwrap(), 0o644);
    let named = Path::new("/elsewhere/parse.mjs");
    let chosen = script_for(&host(&[(OVERRIDE, named)]), Some(&exe)).unwrap();
    assert_eq!(chosen, named);
    // It wins over one that would be refused, too: the operator named a file.
    chmod(&exe.parent().unwrap().join(BESIDE), 0o666);
    let chosen = script_for(&host(&[(OVERRIDE, named)]), Some(&exe)).unwrap();
    assert_eq!(chosen, named);
}

#[test]
fn a_bridge_anyone_can_write_is_refused_and_the_error_says_why() {
    let root = tempfile::tempdir().unwrap();
    let exe = kit(root.path(), "kit", 0o755);
    let file = bridge(exe.parent().unwrap(), 0o666);
    let said = refusal(&exe);
    assert!(
        said.contains(&format!("\"{}\" writable by others", file.display())),
        "{said}"
    );
    assert!(said.contains(OVERRIDE), "{said}");
}

#[test]
fn a_bridge_in_a_directory_anyone_can_write_is_refused() {
    let root = tempfile::tempdir().unwrap();
    for mode in [0o777, 0o1777, 0o757] {
        let exe = kit(root.path(), &format!("kit-{mode:o}"), mode);
        bridge(exe.parent().unwrap(), 0o644);
        let dir = exe.parent().unwrap().canonicalize().unwrap();
        let said = refusal(&exe);
        assert!(
            said.contains(&format!("\"{}\" writable by others", dir.display())),
            "{mode:o}: {said}"
        );
    }
}

#[test]
fn a_symlink_beside_the_executable_is_judged_where_it_leads_as_well() {
    let root = tempfile::tempdir().unwrap();
    let exe = kit(root.path(), "kit", 0o755);
    let shared = root.path().join("shared");
    std::fs::create_dir(&shared).unwrap();
    chmod(&shared, 0o777);
    let target = bridge(&shared, 0o644);
    symlink(&target, exe.parent().unwrap().join(BESIDE)).unwrap();
    let said = refusal(&exe);
    assert!(
        said.contains(&format!(
            "\"{}\" writable by others",
            shared.canonicalize().unwrap().display()
        )),
        "{said}"
    );
    // Into a directory only the caller can write, it is used, as the file it names.
    chmod(&shared, 0o755);
    assert_eq!(script_for(&host(&[]), Some(&exe)).unwrap(), target);
}

#[test]
fn a_link_to_nothing_or_a_directory_of_that_name_is_refused_not_skipped() {
    let root = tempfile::tempdir().unwrap();
    let exe = kit(root.path(), "dangling", 0o755);
    symlink(
        root.path().join("gone.mjs"),
        exe.parent().unwrap().join(BESIDE),
    )
    .unwrap();
    assert!(refusal(&exe).contains("cannot be resolved"));
    let exe = kit(root.path(), "directory", 0o755);
    std::fs::create_dir(exe.parent().unwrap().join(BESIDE)).unwrap();
    assert!(refusal(&exe).contains("is not a regular file"));
}

#[test]
fn the_executable_is_resolved_before_its_directory_is_read() {
    // `~/.local/bin/opensesame -> /opt/kit/opensesame`: the bridge is looked
    // for in the kit, not in the directory of the link.
    let root = tempfile::tempdir().unwrap();
    let exe = kit(root.path(), "kit", 0o755);
    let found = bridge(exe.parent().unwrap(), 0o644);
    let bin = root.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let link = bin.join("opensesame");
    symlink(&exe, &link).unwrap();
    assert_eq!(script_for(&host(&[]), Some(&link)).unwrap(), found);
}
