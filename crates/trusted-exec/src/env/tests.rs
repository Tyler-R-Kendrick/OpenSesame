use super::*;

use std::collections::BTreeMap;
use std::ffi::OsString;

fn lookup(platform: Platform, vars: &[(&str, &str)]) -> Lookup {
    Lookup {
        vars: vars
            .iter()
            .map(|(n, v)| (OsString::from(n), OsString::from(v)))
            .collect(),
        cwd: None,
        platform,
        caller: crate::Caller::default(),
    }
}

fn passed(allow: &[Pass], on: &Lookup) -> BTreeMap<String, String> {
    let mut command = Command::new("/nonexistent");
    command.env_clear();
    pass_in(&mut command, allow, on);
    command
        .get_envs()
        .map(|(n, v)| {
            (
                n.to_str().unwrap().to_owned(),
                v.unwrap().to_str().unwrap().to_owned(),
            )
        })
        .collect()
}

#[test]
fn a_name_is_exact_on_unix_and_a_prefix_admits_what_begins_with_it() {
    let on = lookup(
        Platform::Unix,
        &[
            ("GNUPGHOME", "/g"),
            ("gnupghome", "/lower"),
            ("XDG_RUNTIME_DIR", "/run/user/1"),
            ("XDG_CONFIG_HOME", "/c"),
            ("XDGX", "no"),
            ("PATH", "/planted"),
            ("OPENSESAME_CONNECTION_KEY", "dummy"),
        ],
    );
    let got = passed(
        &[
            Pass::Name("GNUPGHOME"),
            Pass::Prefix("XDG_"),
            Pass::Name("PATH"),
        ],
        &on,
    );
    let names: Vec<_> = got.keys().map(String::as_str).collect();
    assert_eq!(names, ["GNUPGHOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR"]);
}

#[test]
fn windows_compares_names_and_prefixes_without_case() {
    let on = lookup(
        Platform::Windows,
        &[
            ("AppData", "C:\\a"),
            ("xdg_x", "1"),
            ("Path", "C:\\planted"),
        ],
    );
    let got = passed(&[Pass::Name("APPDATA"), Pass::Prefix("XDG_")], &on);
    let names: Vec<_> = got.keys().map(String::as_str).collect();
    assert_eq!(names, ["AppData", "xdg_x"]);
}

#[test]
fn the_common_allowance_is_home_scratch_and_locale_and_nothing_secret() {
    let on = lookup(
        Platform::Unix,
        &[
            ("HOME", "/h"),
            ("TMPDIR", "/t"),
            ("LANG", "C"),
            ("LC_ALL", "C"),
            ("LC_API_KEY", "dummy"),
            ("SHELL", "/bin/sh"),
        ],
    );
    let names: Vec<_> = passed(&COMMON, &on).into_keys().collect();
    assert_eq!(names, ["HOME", "LANG", "LC_ALL", "TMPDIR"]);
    let every = COMMON
        .iter()
        .chain(&COMMON_ON_WINDOWS)
        .chain(&PROXY)
        .chain(&CA_BUNDLE);
    for pass in every {
        let (Pass::Name(name) | Pass::Prefix(name)) = *pass;
        let upper = name.to_ascii_uppercase();
        for bad in ["OPENSESAME_", "GIT_", "NODE_", "AWS_", "GITHUB_"] {
            assert!(!upper.starts_with(bad), "{name}");
        }
        for bad in ["TOKEN", "SECRET", "PASSWORD", "KEY", "PASSPHRASE"] {
            assert!(!upper.ends_with(bad), "{name}");
        }
    }
}

#[test]
fn pass_reads_this_process() {
    let mut command = Command::new("/nonexistent");
    command.env_clear();
    pass(&mut command, &[Pass::Name("PATH")]);
    assert_eq!(command.get_envs().count(), 0, "PATH is never copied");
}
