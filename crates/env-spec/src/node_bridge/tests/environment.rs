use super::*;

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
