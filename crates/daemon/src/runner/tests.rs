use super::*;

/// The system's own directories: a snapshot needs a trusted `PATH` entry to
/// find even `sh`.
const SYSTEM_PATH: &str = "/usr/bin:/bin";

fn runner_with(env: &[(&str, &str)]) -> ScrubbedCommandRunner {
    let mut snapshot: BTreeMap<String, String> = BTreeMap::new();
    snapshot.insert("PATH".to_string(), SYSTEM_PATH.to_string());
    snapshot.extend(
        env.iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string())),
    );
    ScrubbedCommandRunner::new(snapshot)
}

#[test]
fn contract_child_env_is_a_whitelist_projection() {
    let mut snapshot = BTreeMap::new();
    snapshot.insert("HOME".to_string(), "/home/tester".to_string());
    snapshot.insert("PATH".to_string(), "/usr/bin".to_string());
    snapshot.insert(
        "OPENSESAME_OPERATOR_TOKEN".to_string(),
        "PLANTED-OPERATOR-TOKEN".to_string(),
    );
    snapshot.insert("AWS_SECRET_ACCESS_KEY".to_string(), "PLANTED".to_string());
    let child_env = minimal_child_env(&snapshot);
    assert!(child_env.contains_key("HOME"));
    assert!(child_env.contains_key("PATH"));
    assert!(!child_env.contains_key("OPENSESAME_OPERATOR_TOKEN"));
    assert!(!child_env.contains_key("AWS_SECRET_ACCESS_KEY"));
}

#[test]
fn adversarial_child_never_sees_the_daemons_own_environment() {
    // Even a variable set on the daemon process itself must not reach the
    // child: the runner starts from env_clear, not from inheritance.
    let planted = "OPENSESAME_PLANTED_CHILD_MUST_NOT_SEE";
    std::env::set_var(planted, "PLANTED-SECRET");
    let runner = runner_with(&[("HOME", "/tmp")]);
    let status = runner
        .run_status(
            &[
                "sh",
                "-c",
                "[ -z \"$OPENSESAME_PLANTED_CHILD_MUST_NOT_SEE\" ]",
            ],
            2_000,
        )
        .expect("ran");
    assert!(status.success, "child observed the daemon's environment");
    std::env::remove_var(planted);
}

#[test]
fn child_gets_the_whitelisted_minimum() {
    let runner = runner_with(&[("HOME", "/home/tester"), ("PATH", "/usr/bin:/bin")]);
    let status = runner
        .run_status(
            &[
                "sh",
                "-c",
                "[ \"$HOME\" = /home/tester ] && [ -n \"$PATH\" ]",
            ],
            2_000,
        )
        .expect("ran");
    assert!(status.success);
}

#[test]
fn contract_a_hung_child_is_killed_at_the_timeout() {
    let runner = runner_with(&[]);
    let started = Instant::now();
    let result = runner.run_status(&["sh", "-c", "sleep 30"], 150);
    let elapsed = started.elapsed();
    assert!(result.is_err(), "timeout must surface as an error");
    assert!(
        elapsed < Duration::from_secs(5),
        "took {elapsed:?} to give up"
    );
}

#[test]
fn contract_stdout_is_reduced_to_a_non_empty_bit() {
    // `gh auth token` prints a token; the runner must prove it saw output
    // without any API that could hand the bytes back.
    let runner = runner_with(&[]);
    let status = runner
        .run_status(&["sh", "-c", "echo PLANTED-TOKEN-VALUE; exit 3"], 2_000)
        .expect("ran");
    assert!(!status.success);
    assert!(status.stdout_non_empty);
}

#[test]
fn a_chatty_child_cannot_deadlock_the_pipe() {
    // Far more than the 4 KiB observation cap and more than a pipe buffer:
    // only draining keeps this from blocking forever.
    let runner = runner_with(&[]);
    let started = Instant::now();
    let status = runner
        .run_status(
            &[
                "sh",
                "-c",
                "i=0; while [ $i -lt 5000 ]; do echo PLANTED-LINE; i=$((i+1)); done; exit 0",
            ],
            10_000,
        )
        .expect("ran");
    assert!(status.success);
    assert!(status.stdout_non_empty);
    assert!(started.elapsed() < Duration::from_secs(10));
}

#[test]
fn a_missing_binary_is_an_error_not_a_panic() {
    let runner = runner_with(&[]);
    let result = runner.run_status(&["definitely-not-a-real-binary-xyz"], 1_000);
    assert!(result.is_err());
}

// ——— run_capture: the invoke-through acquisition path ————————————

#[test]
fn capture_returns_stdout_trimmed() {
    use secrecy::ExposeSecret;
    let runner = runner_with(&[]);
    let token = runner
        .run_capture(&["sh", "-c", "printf 'gho_abc123\\n'"], 2_000)
        .expect("captured");
    assert_eq!(token.expose_secret(), "gho_abc123");
}

#[test]
fn capture_error_never_carries_the_secret() {
    // A failing child that printed a credential-shaped string: the error
    // must name the failure class (exit status), not the output.
    let runner = runner_with(&[]);
    let error = runner
        .run_capture(&["sh", "-c", "echo PLANTED-TOKEN-IN-OUTPUT; exit 3"], 2_000)
        .expect_err("non-zero exit");
    let rendered = format!("{error} / {error:?}");
    assert!(!rendered.contains("PLANTED-TOKEN-IN-OUTPUT"), "{rendered}");
}

#[test]
fn capture_fails_closed_on_empty_output() {
    let runner = runner_with(&[]);
    let error = runner
        .run_capture(&["sh", "-c", "true"], 2_000)
        .expect_err("no credential printed");
    assert!(format!("{error}").contains("no credential"));
}

#[test]
fn capture_is_capped() {
    let runner = runner_with(&[]);
    let error = runner
        .run_capture(
            &[
                "sh",
                "-c",
                "i=0; while [ $i -lt 5000 ]; do echo PLANTED-LINE; i=$((i+1)); done",
            ],
            10_000,
        )
        .expect_err("oversized capture");
    assert!(format!("{error}").contains("cap"));
}

#[test]
fn capture_honors_the_timeout() {
    let runner = runner_with(&[]);
    let result = runner.run_capture(&["sh", "-c", "sleep 30"], 150);
    assert!(result.is_err());
}

#[test]
fn capture_child_env_is_still_scrubbed() {
    let runner = runner_with(&[("HOME", "/tmp")]);
    // The daemon's own variables must not reach the capturing child
    // either; print the planted variable — empty proves the scrub.
    let planted = "OPENSESAME_PLANTED_CAPTURE_MUST_NOT_SEE";
    std::env::set_var(planted, "PLANTED-SECRET");
    let result = runner.run_capture(
        &[
            "sh",
            "-c",
            "printf '%s' \"$OPENSESAME_PLANTED_CAPTURE_MUST_NOT_SEE\"",
        ],
        2_000,
    );
    std::env::remove_var(planted);
    // Empty stdout fails closed with "no credential" — the scrub held.
    let error = result.expect_err("scrubbed env prints nothing");
    assert!(format!("{error}").contains("no credential"));
}

// ——— Windows spells PATH `Path` ———————————————————————————————————————

#[test]
fn a_windows_snapshot_keeps_its_path_under_the_name_windows_gives_it() {
    let snapshot: BTreeMap<String, String> = [
        ("Path", "C:\\Program Files\\GitHub CLI"),
        ("USERPROFILE", "C:\\Users\\dummy"),
        ("OPENSESAME_OPERATOR_TOKEN", "PLANTED-OPERATOR-TOKEN"),
    ]
    .into_iter()
    .map(|(name, value)| (name.to_string(), value.to_string()))
    .collect();
    let kept = minimal_child_env_on(Platform::Windows, &snapshot);
    assert!(kept.contains_key("Path"), "Path was dropped: {kept:?}");
    assert!(kept.contains_key("USERPROFILE"));
    assert!(!kept.contains_key("OPENSESAME_OPERATOR_TOKEN"));
    // What the resolver reads is that same entry, so a probe finds a CLI.
    let lookup = programs::lookup_on(Platform::Windows, &kept);
    assert!(lookup.var("PATH").is_some(), "the resolver saw no PATH");
}

#[test]
fn a_unix_snapshot_keeps_only_the_variable_named_path() {
    let snapshot: BTreeMap<String, String> = [("Path", "/tmp/planted"), ("PATH", "/usr/bin")]
        .into_iter()
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect();
    let kept = minimal_child_env_on(Platform::Unix, &snapshot);
    assert!(kept.contains_key("PATH"));
    assert!(!kept.contains_key("Path"), "a different variable was kept");
}

// ——— which CLI runs, and what each is handed ——————————————————————————

#[cfg(unix)]
mod trusted {
    use super::*;
    use opensesame_trusted_exec::testkit::Fixture;
    use secrecy::ExposeSecret;

    /// The fixture's hostile parent environment as the snapshot discovery
    /// takes, projected the way discovery projects it.
    fn runner_over(fixture: &Fixture, extra: &[(&str, &str)]) -> ScrubbedCommandRunner {
        let snapshot: BTreeMap<String, String> = fixture
            .lookup(extra)
            .vars
            .into_iter()
            .map(|(n, v)| (n.into_string().unwrap(), v.into_string().unwrap()))
            .collect();
        ScrubbedCommandRunner::new(minimal_child_env(&snapshot))
    }

    #[test]
    fn a_planted_cli_ahead_of_the_trusted_one_is_never_run_or_asked_for_a_token() {
        let fixture = Fixture::new("gh");
        fixture.stub_recorder_saying(&fixture.trusted.join("gh"), "gho_dummy_0123456789");
        let runner = runner_over(&fixture, &[]);
        let status = runner.run_status(&["gh", "auth", "token"], 2_000);
        let token = runner.run_capture(&["gh", "auth", "token"], 2_000);
        let _ = fixture.assert_clean();
        let status = status.unwrap();
        assert!(status.success && status.stdout_non_empty);
        assert_eq!(token.unwrap().expose_secret(), "gho_dummy_0123456789");
    }

    #[test]
    fn each_cli_is_handed_its_own_configuration_and_no_other() {
        let configured = [
            ("GH_CONFIG_DIR", "/home/dummy/.config/gh"),
            ("KUBECONFIG", "/home/dummy/.kube/config"),
            ("AWS_PROFILE", "dummy"),
        ];
        for (cli, own, others) in [
            ("gh", "GH_CONFIG_DIR", ["KUBECONFIG", "AWS_PROFILE"]),
            ("kubectl", "KUBECONFIG", ["GH_CONFIG_DIR", "AWS_PROFILE"]),
            ("aws", "AWS_PROFILE", ["GH_CONFIG_DIR", "KUBECONFIG"]),
        ] {
            let fixture = Fixture::new(cli);
            let runner = runner_over(&fixture, &configured);
            assert!(runner.run_status(&[cli, "probe"], 2_000).unwrap().success);
            let env = fixture.assert_clean();
            assert!(env.contains_key(own), "{cli} lacks {own}: {env:?}");
            for other in others {
                assert!(!env.contains_key(other), "{other} reached {cli}");
            }
        }
    }

    #[test]
    fn opensesame_gh_names_the_exact_cli_and_is_not_handed_on() {
        let fixture = Fixture::new("gh");
        let chosen = fixture.scratch("chosen").join("gh");
        fixture.stub_recorder(&chosen);
        let value = chosen.display().to_string();
        let runner = runner_over(&fixture, &[("OPENSESAME_GH", &value)]);
        assert!(
            runner
                .run_status(&["gh", "auth", "token"], 2_000)
                .unwrap()
                .success
        );
        let env = fixture.assert_clean();
        assert!(!env.contains_key("OPENSESAME_GH"));
    }

    #[test]
    fn a_snapshot_without_a_trusted_path_entry_runs_nothing() {
        let error = ScrubbedCommandRunner::new(BTreeMap::new())
            .run_status(&["sh", "-c", "true"], 2_000)
            .expect_err("no PATH, no program");
        assert!(format!("{error}").contains("PATH is not set"), "{error}");
    }
}
