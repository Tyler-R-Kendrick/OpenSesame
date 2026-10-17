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
