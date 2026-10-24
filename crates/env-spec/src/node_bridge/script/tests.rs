use super::*;

use std::ffi::OsString;
use std::os::unix::fs::{symlink, PermissionsExt};

use super::super::tests::into_a_strangers_group;
use super::super::Caller;

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

#[test]
fn a_bridge_a_strangers_group_can_write_is_refused_as_its_directory_would_be() {
    let root = tempfile::tempdir().unwrap();
    let exe = kit(root.path(), "kit", 0o755);
    let file = bridge(exe.parent().unwrap(), 0o664);
    let (caller, gid) = into_a_strangers_group(&file);
    let mut on = host(&[]);
    on.caller = caller;
    let said = match script_for(&on, Some(&exe)) {
        Err(e @ EnvSpecError::BridgeScript(_)) => e.to_string(),
        other => panic!("not refused: {other:?}"),
    };
    assert!(
        said.contains(&format!(
            "\"{}\" group-writable by group {gid} which is not one of yours",
            file.display()
        )),
        "{said}"
    );
    // The same file that the group cannot write is the one that runs.
    chmod(&file, 0o644);
    assert_eq!(script_for(&on, Some(&exe)).unwrap(), file);
}

fn lookup_error(exe: Option<&Path>, checkout: &Path) -> String {
    match resolve(&host(&[]), exe, checkout) {
        Err(e @ EnvSpecError::BridgeScript(_)) => e.to_string(),
        other => panic!("not refused: {other:?}"),
    }
}

#[test]
fn with_nothing_beside_and_no_checkout_copy_the_error_says_where_it_looked() {
    let root = tempfile::tempdir().unwrap();
    let exe = kit(root.path(), "kit", 0o755);
    let gone = root.path().join("not-a-checkout").join(BESIDE);
    let said = lookup_error(Some(&exe), &gone);
    for part in [
        BESIDE,
        OVERRIDE,
        &exe.display().to_string(),
        &gone.display().to_string(),
    ] {
        assert!(said.contains(part), "{part}: {said}");
    }
    // A directory of that name is no more a script than a missing file is.
    std::fs::create_dir_all(&gone).unwrap();
    assert!(lookup_error(Some(&exe), &gone).contains("missing or not a file"));
}

#[test]
fn an_executable_that_cannot_be_found_is_said_not_silently_skipped() {
    let root = tempfile::tempdir().unwrap();
    let gone = root.path().join("not-a-checkout").join(BESIDE);
    let said = lookup_error(None, &gone);
    assert!(
        said.contains("running executable could not be determined"),
        "{said}"
    );
    assert!(said.contains(&gone.display().to_string()), "{said}");
}

#[test]
fn the_checkouts_copy_runs_only_while_it_is_there_and_the_other_places_still_win() {
    let root = tempfile::tempdir().unwrap();
    let exe = kit(root.path(), "kit", 0o755);
    let copy = root.path().join("checkout.mjs");
    std::fs::write(&copy, "// stand-in\n").unwrap();
    let copy = copy.canonicalize().unwrap();
    assert_eq!(resolve(&host(&[]), Some(&exe), &copy).unwrap(), copy);
    assert_eq!(resolve(&host(&[]), None, &copy).unwrap(), copy);
    // Neither a bridge beside the executable nor the operator's file needs it.
    let gone = root.path().join("gone.mjs");
    let found = bridge(exe.parent().unwrap(), 0o644);
    assert_eq!(resolve(&host(&[]), Some(&exe), &gone).unwrap(), found);
    let named = Path::new("/elsewhere/parse.mjs");
    let chosen = resolve(&host(&[(OVERRIDE, named)]), None, &gone).unwrap();
    assert_eq!(chosen, named);
}

/// `<root>/<name>/opensesame-env-parse.mjs`, in a directory of `dir_mode`.
fn checkout_copy(root: &Path, name: &str, dir_mode: u32, file_mode: u32) -> PathBuf {
    let dir = root.join(name);
    std::fs::create_dir(&dir).unwrap();
    chmod(&dir, dir_mode);
    let file = dir.join(BESIDE);
    std::fs::write(&file, "// stand-in\n").unwrap();
    chmod(&file, file_mode);
    file
}

fn checkout_refusal(copy: &Path) -> String {
    let root = tempfile::tempdir().unwrap();
    let exe = kit(root.path(), "kit", 0o755);
    let said = lookup_error(Some(&exe), copy);
    assert!(
        said.contains("in the checkout this binary was built from"),
        "{said}"
    );
    assert!(said.contains(OVERRIDE), "{said}");
    said
}

#[test]
fn a_checkout_copy_a_stranger_could_write_is_refused_as_the_one_beside_the_executable_is() {
    let root = tempfile::tempdir().unwrap();
    // The baked path of a release binary, where a local user could have put a file.
    let world_file = checkout_copy(root.path(), "a", 0o755, 0o666);
    let said = checkout_refusal(&world_file);
    assert!(
        said.contains(&format!(
            "\"{}\" writable by others",
            world_file.canonicalize().unwrap().display()
        )),
        "{said}"
    );
    let world_dir = checkout_copy(root.path(), "b", 0o777, 0o644);
    let said = checkout_refusal(&world_dir);
    assert!(said.contains("writable by others"), "{said}");
    assert!(
        said.contains(&world_dir.parent().unwrap().display().to_string()),
        "{said}"
    );
    // Not run, and not skipped for the next place either.
    let group_file = checkout_copy(root.path(), "c", 0o755, 0o664);
    let (caller, gid) = into_a_strangers_group(&group_file);
    let mut on = host(&[]);
    on.caller = caller;
    match resolve(&on, None, &group_file) {
        Err(e @ EnvSpecError::BridgeScript(_)) => assert!(
            e.to_string()
                .contains(&format!("group-writable by group {gid}")),
            "{e}"
        ),
        other => panic!("not refused: {other:?}"),
    }
}

#[test]
fn a_checkout_copy_only_its_owner_and_root_could_write_is_run_as_the_file_it_resolves_to() {
    let root = tempfile::tempdir().unwrap();
    for (name, dir_mode, file_mode) in [
        ("a", 0o755, 0o644),
        ("b", 0o775, 0o664),
        ("c", 0o700, 0o600),
    ] {
        let copy = checkout_copy(root.path(), name, dir_mode, file_mode);
        let found = copy.canonicalize().unwrap();
        assert_eq!(resolve(&host(&[]), None, &copy).unwrap(), found, "{name}");
        // Named the way `CARGO_MANIFEST_DIR/../../packages/...` names it.
        let dotted = root.path().join(name).join("..").join(name).join(BESIDE);
        assert_eq!(resolve(&host(&[]), None, &dotted).unwrap(), found, "{name}");
    }
}

#[test]
fn the_override_and_a_bridge_beside_the_executable_never_reach_a_refused_checkout_copy() {
    let root = tempfile::tempdir().unwrap();
    let exe = kit(root.path(), "kit", 0o755);
    let refused = checkout_copy(root.path(), "refused", 0o777, 0o666);
    let named = Path::new("/elsewhere/parse.mjs");
    assert_eq!(
        resolve(&host(&[(OVERRIDE, named)]), Some(&exe), &refused).unwrap(),
        named
    );
    let found = bridge(exe.parent().unwrap(), 0o644);
    assert_eq!(resolve(&host(&[]), Some(&exe), &refused).unwrap(), found);
}
