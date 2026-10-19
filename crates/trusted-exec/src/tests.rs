use super::*;

use std::collections::BTreeSet;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use crate::testkit::{Fixture, SECRET};

fn run(mut command: Command) {
    let status = command.status().expect("spawn");
    assert!(status.success(), "{status}");
}

#[test]
fn a_planted_program_ahead_of_a_trusted_one_never_runs_and_no_secret_follows() {
    for (program, var) in [
        ("git", "OPENSESAME_GIT"),
        ("gpg", "OPENSESAME_GPG"),
        ("gh", "OPENSESAME_GH"),
        ("openssl", "OPENSESAME_OPENSSL"),
    ] {
        let fixture = Fixture::new(program);
        let lookup = fixture.lookup(&[("LANG", "C.UTF-8"), ("LC_API_KEY", SECRET)]);
        let command = command_in(program, Some(var), &lookup).unwrap();
        assert_eq!(command.get_program(), fixture.trusted.join(program));
        run(command);
        let env = fixture.assert_clean();
        let names: BTreeSet<_> = env.keys().map(String::as_str).collect();
        for want in ["HOME", "LANG", "PATH"] {
            assert!(names.contains(want), "{program}: {want} missing: {names:?}");
        }
        assert!(!names.contains("LC_API_KEY"), "{program}: {names:?}");
        assert_eq!(env["PATH"], fixture.trusted.display().to_string());
    }
}

#[test]
fn the_override_names_the_exact_file_even_in_a_directory_anyone_can_write() {
    let fixture = Fixture::new("git");
    let chosen = fixture.planted.join("chosen-git");
    fixture.stub_recorder(&chosen);
    std::fs::set_permissions(&chosen, std::fs::Permissions::from_mode(0o777)).unwrap();
    let value = chosen.display().to_string();
    let lookup = fixture.lookup(&[("OPENSESAME_GIT", &value)]);
    let command = command_in("git", Some("OPENSESAME_GIT"), &lookup).unwrap();
    assert_eq!(command.get_program(), chosen.as_os_str());
    run(command);
    let env = fixture.assert_clean();
    assert!(!env.contains_key("OPENSESAME_GIT"), "{env:?}");
    // Without the variable named as this program's override it is ignored.
    let ignored = command_in("git", None, &lookup).unwrap();
    assert_eq!(ignored.get_program(), fixture.trusted.join("git"));
}

#[test]
fn a_bad_override_is_an_error_naming_it_and_path_is_not_searched_instead() {
    let fixture = Fixture::new("gh");
    for value in ["", "gh", "./gh", "/nonexistent/gh"] {
        let lookup = fixture.lookup(&[("OPENSESAME_GH", value)]);
        let err = resolve_in("gh", Some("OPENSESAME_GH"), &lookup).unwrap_err();
        assert!(
            matches!(err, ResolveError::Override(_)),
            "{value:?}: {err:?}"
        );
        assert!(err.to_string().starts_with("OPENSESAME_GH "), "{err}");
    }
    assert!(!fixture.planted_ran());
}

#[test]
fn no_trusted_program_is_an_error_that_names_it_and_every_skip() {
    let fixture = Fixture::new("gpg");
    std::fs::remove_file(fixture.trusted.join("gpg")).unwrap();
    let mut lookup = fixture.lookup(&[]);
    let err = resolve_in("gpg", Some("OPENSESAME_GPG"), &lookup)
        .unwrap_err()
        .to_string();
    let planted = format!("\"{}\" writable by others", fixture.planted.display());
    for want in ["no usable `gpg`", "holds a `gpg`", &planted] {
        assert!(err.contains(want), "{want:?} not in: {err}");
    }
    lookup.vars.retain(|(name, _)| name != "PATH");
    let err = resolve_in("gpg", None, &lookup).unwrap_err().to_string();
    assert!(err.contains("PATH is not set"), "{err}");
}

#[test]
fn an_empty_or_relative_entry_is_never_searched_even_holding_the_program() {
    let fixture = Fixture::new("ps");
    let cwd = fixture.scratch("cwd");
    fixture.stub_planted(&cwd);
    let mut lookup = fixture.lookup(&[]);
    lookup.cwd = Some(cwd);
    lookup.vars[0].1 = OsString::from(":.:./bin");
    let err = resolve_in("ps", None, &lookup).unwrap_err().to_string();
    assert!(err.contains("PATH has none"), "{err}");
    assert!(
        err.contains("\"\" empty entry") && err.contains("\".\" relative"),
        "{err}"
    );
}

#[test]
fn a_file_another_user_could_replace_is_passed_over_and_said() {
    let fixture = Fixture::new("tailscale");
    let open = fixture.trusted.join("tailscale");
    std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o757)).unwrap();
    let err = resolve_in("tailscale", None, &fixture.lookup(&[]))
        .unwrap_err()
        .to_string();
    let said = format!("tailscale \"{}\" writable by others", open.display());
    assert!(err.contains(&said), "{said} not in: {err}");
}

#[test]
fn windows_appends_exe_unless_the_name_has_one_and_adds_its_own_variables() {
    assert_eq!(Platform::Windows.file_name("git"), "git.exe");
    assert_eq!(Platform::Windows.file_name("explorer.exe"), "explorer.exe");
    assert_eq!(Platform::Unix.file_name("git"), "git");
    let fixture = Fixture::new("unused");
    let dir = fixture.scratch("win");
    std::fs::write(dir.join("git.exe"), "").unwrap();
    std::fs::set_permissions(dir.join("git.exe"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let lookup = Lookup {
        vars: vec![
            (OsString::from("Path"), dir.clone().into_os_string()),
            (OsString::from("systemroot"), OsString::from("C:\\Windows")),
            (
                OsString::from("UserProfile"),
                OsString::from("C:\\Users\\d"),
            ),
            (
                OsString::from("OPENSESAME_CONNECTION_KEY"),
                OsString::from(SECRET),
            ),
        ],
        cwd: None,
        platform: Platform::Windows,
        caller: Caller::default(),
    };
    let command = command_in("git", None, &lookup).unwrap();
    assert_eq!(command.get_program(), dir.join("git.exe"));
    let names: BTreeSet<_> = command
        .get_envs()
        .map(|(n, _)| n.to_str().unwrap().to_ascii_uppercase())
        .collect();
    assert_eq!(
        names,
        BTreeSet::from(["PATH", "SYSTEMROOT", "USERPROFILE"].map(String::from))
    );
}

#[test]
fn resolve_and_command_read_this_process() {
    // This process's own PATH: whatever it holds, the answer is a trusted
    // absolute file or an error that says why, never a bare name.
    match resolve_on_path("sh") {
        Ok(found) => assert!(Path::new(&found).is_absolute(), "{}", found.display()),
        Err(err) => assert!(err.to_string().contains("no usable `sh`"), "{err}"),
    }
    if let Ok(command) = command_on_path("sh") {
        let names: Vec<_> = command.get_envs().map(|(n, _)| n.to_owned()).collect();
        assert!(names.iter().all(|n| n != "OPENSESAME_CONNECTION_KEY"));
    }
}

#[test]
fn a_fixed_file_the_code_chose_gets_the_same_built_environment() {
    let fixture = Fixture::new("curl.exe");
    let fixed = fixture.scratch("fixed").join("curl.exe");
    fixture.stub_recorder(&fixed);
    run(command_at(&fixed, &fixture.lookup(&[])).unwrap());
    let env = fixture.assert_clean();
    assert_eq!(env["PATH"], fixture.trusted.display().to_string());
    let err = command_at(Path::new("curl.exe"), &fixture.lookup(&[])).unwrap_err();
    assert!(err.to_string().contains("not an absolute path"), "{err}");
}

/// The planted-swap the review's r1a and r1b ran: if the rule hands back a
/// command at all, swapping the program after resolution must not run.
fn swap_and_run(command: Result<Command, ResolveError>, swap: impl FnOnce()) -> String {
    let Ok(mut command) = command else {
        return String::new();
    };
    swap();
    let out = command.output().expect("spawn");
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn script(path: &Path, body: &str) {
    std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn path_lookup(fixture: &Fixture, dirs: &[&Path]) -> Lookup {
    let mut lookup = fixture.lookup(&[]);
    lookup.vars[0].1 = std::env::join_paths(dirs).unwrap();
    lookup
}

#[test]
fn a_program_under_a_directory_anyone_can_write_is_refused_and_a_swap_never_runs() {
    let fixture = Fixture::new("unused");
    let shared = fixture.scratch("shared");
    std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o777)).unwrap();
    let bin = shared.join("bin");
    std::fs::create_dir(&bin).unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    script(&bin.join("git"), "echo trusted-git");
    let lookup = path_lookup(&fixture, &[&bin]);
    let said = match resolve_in("git", Some("OPENSESAME_GIT"), &lookup) {
        Ok(found) => format!("accepted {}", found.program.display()),
        Err(err) => err.to_string(),
    };
    let ran = swap_and_run(command_in("git", Some("OPENSESAME_GIT"), &lookup), || {
        std::fs::rename(&bin, shared.join("bin.orig")).unwrap();
        std::fs::create_dir(&bin).unwrap();
        script(&bin.join("git"), "echo PLANTED-SWAP");
    });
    assert!(!ran.contains("PLANTED"), "the swapped-in git ran: {ran}");
    let under = format!("is under \"{}\", writable by others", shared.display());
    assert!(said.contains(&under), "{under} not in: {said}");
}

#[test]
fn a_link_to_a_program_in_a_directory_anyone_can_write_is_refused() {
    let fixture = Fixture::new("unused");
    let (trusted, open) = (fixture.scratch("trusted-dir"), fixture.scratch("open"));
    std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o777)).unwrap();
    script(&open.join("gpg-real"), "echo trusted-gpg");
    std::os::unix::fs::symlink(open.join("gpg-real"), trusted.join("gpg")).unwrap();
    let lookup = path_lookup(&fixture, &[&trusted]);
    let ran = swap_and_run(command_in("gpg", Some("OPENSESAME_GPG"), &lookup), || {
        std::fs::remove_file(open.join("gpg-real")).unwrap();
        script(&open.join("gpg-real"), "echo PLANTED-GPG");
    });
    assert!(!ran.contains("PLANTED"), "the swapped-in gpg ran: {ran}");
    assert!(resolve_in("gpg", None, &lookup).is_err());
}

#[test]
fn a_link_within_trusted_directories_runs_its_real_path() {
    let fixture = Fixture::new("unused");
    let (front, real) = (fixture.scratch("front"), fixture.scratch("real"));
    fixture.stub_recorder(&real.join("gh-real"));
    std::os::unix::fs::symlink(real.join("gh-real"), front.join("gh")).unwrap();
    let command = command_in("gh", None, &path_lookup(&fixture, &[&front])).unwrap();
    assert_eq!(command.get_program(), real.join("gh-real"));
}

#[test]
fn with_no_trusted_path_entry_the_child_has_no_path_at_all() {
    let fixture = Fixture::new("unused");
    let (chosen, checkout) = (fixture.scratch("chosen"), fixture.scratch("checkout"));
    std::fs::write(chosen.join("opensesame-id"), "#!/usr/bin/env node\n").unwrap();
    std::fs::set_permissions(
        chosen.join("opensesame-id"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    script(&checkout.join("node"), "echo PLANTED-NODE-FROM-CWD");
    let value = chosen.join("opensesame-id");
    let lookup = Lookup {
        vars: vec![("OPENSESAME_ID_BIN".into(), value.into_os_string())],
        cwd: None,
        platform: Platform::Unix,
        caller: Caller::current(),
    };
    let mut command = command_in("opensesame-id", Some("OPENSESAME_ID_BIN"), &lookup).unwrap();
    let has_path = command.get_envs().any(|(name, _)| name == "PATH");
    let out = command.current_dir(&checkout).output().unwrap();
    let ran = String::from_utf8_lossy(&out.stdout);
    assert!(
        !ran.contains("PLANTED"),
        "a node in the working directory ran"
    );
    assert!(!has_path, "the child was given a PATH");
}

#[test]
fn not_finding_a_program_says_which_variable_names_it() {
    let fixture = Fixture::new("git");
    std::fs::remove_file(fixture.trusted.join("git")).unwrap();
    let err = resolve_in("git", Some("OPENSESAME_GIT"), &fixture.lookup(&[]))
        .unwrap_err()
        .to_string();
    let want = "or set OPENSESAME_GIT to the absolute path of the `git` to run";
    assert!(err.ends_with(want), "{want} not at the end of: {err}");
    let plain = resolve_in("hostname", None, &fixture.lookup(&[]))
        .unwrap_err()
        .to_string();
    assert!(!plain.contains("or set"), "{plain}");
}

#[test]
fn windows_programs_keep_the_folders_they_find_their_state_in() {
    let lookup = Lookup {
        vars: [
            ("APPDATA", "C:\\Users\\d\\AppData\\Roaming"),
            ("LOCALAPPDATA", "C:\\Users\\d\\AppData\\Local"),
            ("ProgramData", "C:\\ProgramData"),
            ("SystemDrive", "C:"),
            ("windir", "C:\\Windows"),
            ("OPENSESAME_CONNECTION_KEY", SECRET),
        ]
        .iter()
        .map(|(n, v)| (OsString::from(n), OsString::from(v)))
        .collect(),
        cwd: None,
        platform: Platform::Windows,
        caller: Caller::default(),
    };
    let mut command = Command::new("x");
    command.env_clear();
    pass_in(&mut command, &COMMON_ON_WINDOWS, &lookup);
    let names: BTreeSet<_> = command
        .get_envs()
        .map(|(n, _)| n.to_str().unwrap().to_ascii_uppercase())
        .collect();
    let want = [
        "APPDATA",
        "LOCALAPPDATA",
        "PROGRAMDATA",
        "SYSTEMDRIVE",
        "WINDIR",
    ];
    assert_eq!(names, BTreeSet::from(want.map(String::from)));
}
