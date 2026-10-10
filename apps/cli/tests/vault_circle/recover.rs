//! `opensesame vault circle recover` as a person runs it, against the
//! committed fixture (test-only keys): the payload lands in an owner-only file,
//! nothing secret reaches a terminal stream, and every refusal leaves nothing
//! behind.

use std::process::Output;

use super::support::{path_str, run, run_with_env, text, Circle};

#[test]
fn the_verbs_are_listed_under_vault_circle() {
    let help = run(&["vault", "circle", "--help"], None);
    let out = text(&help.stdout);
    assert!(help.status.success());
    assert!(out.contains("recover") && out.contains("inspect"), "{out}");
    let recover = text(&run(&["vault", "circle", "recover", "--help"], None).stdout);
    assert!(
        recover.contains("visible to other users through `ps`") && recover.contains("--share-file"),
        "the help says why a share does not belong on the command line: {recover}"
    );
}

#[test]
fn recovers_from_a_share_file_into_an_owner_only_file() {
    let circle = Circle::new();
    let shares = circle.path("shares.txt");
    std::fs::write(
        &shares,
        format!("# the quorum\n\n{}", circle.shares(&circle.quorum())),
    )
    .unwrap();
    let out = circle.path("payload.json");
    let result = run(
        &[
            "vault",
            "circle",
            "recover",
            "--bundle",
            path_str(&circle.bundle()),
            "--share-file",
            path_str(&shares),
            "--out",
            path_str(&out),
        ],
        None,
    );
    let stderr = text(&result.stderr);
    assert!(result.status.success(), "{stderr}");
    assert_eq!(
        std::fs::read_to_string(&out).unwrap(),
        circle.payload_text()
    );
    assert!(result.stdout.is_empty(), "the payload is not printed");
    for name in [
        "Ada (family)",
        "Cy (family)",
        "Eli (friends)",
        "Fay (friends)",
    ] {
        assert!(stderr.contains(name), "{name} not in {stderr}");
    }
    assert!(!circle.leaks(&result), "{stderr}");
    assert!(!stderr.contains("fixture-only"), "{stderr}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&out).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "mode was {mode:o}");
    }
}

#[test]
fn reads_shares_from_stdin_and_writes_the_payload_to_stdout() {
    let circle = Circle::new();
    let result = run(
        &[
            "vault",
            "circle",
            "recover",
            "--bundle",
            path_str(&circle.bundle()),
            "--share",
            "-",
            "--out",
            "-",
        ],
        Some(&circle.shares(&["ben", "cy", "dee", "eli"])),
    );
    assert!(result.status.success(), "{}", text(&result.stderr));
    assert_eq!(text(&result.stdout), circle.payload_text());
    assert!(!circle.leaks(&Output {
        stdout: Vec::new(),
        ..result
    }));
}

#[test]
fn a_share_on_the_command_line_works_and_is_warned_about() {
    let circle = Circle::new();
    let lines = circle.shares(&circle.quorum());
    let mut args = vec![
        "vault".to_owned(),
        "circle".to_owned(),
        "recover".to_owned(),
        "--bundle".to_owned(),
        path_str(&circle.bundle()).to_owned(),
        "--out".to_owned(),
        "-".to_owned(),
    ];
    for line in lines.lines() {
        args.push("--share".to_owned());
        args.push(line.to_owned());
    }
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let result = run(&args, None);
    assert!(result.status.success(), "{}", text(&result.stderr));
    assert_eq!(text(&result.stdout), circle.payload_text());
    let stderr = text(&result.stderr);
    assert!(stderr.contains("visible to other users (ps)"), "{stderr}");
}

#[test]
fn a_refusal_leaves_no_file_and_prints_no_share() {
    let circle = Circle::new();
    let out = circle.path("payload.json");
    let cases: [(&str, String); 3] = [
        ("expected 2 groups", circle.shares(&["ada", "cy"])),
        ("exactly 2 shares", circle.shares(&["ada", "cy", "eli"])),
        (
            "share 1 is not a valid SLIP-0039 share",
            "academic acid acne acquire\n".to_owned(),
        ),
    ];
    for (needle, shares) in cases {
        let file = circle.path("some-shares.txt");
        std::fs::write(&file, &shares).unwrap();
        let result = run(
            &[
                "vault",
                "circle",
                "recover",
                "--bundle",
                path_str(&circle.bundle()),
                "--share-file",
                path_str(&file),
                "--out",
                path_str(&out),
            ],
            None,
        );
        let stderr = text(&result.stderr);
        assert!(!result.status.success(), "{needle}: {stderr}");
        assert!(stderr.contains(needle), "{needle:?} not in {stderr}");
        assert!(!out.exists(), "{needle}: nothing is written on a refusal");
        assert!(!circle.leaks(&result), "{stderr}");
    }
}

#[test]
fn a_damaged_share_is_named_by_position_and_a_stranger_matches_no_guardian() {
    let circle = Circle::new();
    let mut shares = circle.shares(&circle.quorum());
    shares = shares.replacen('a', "b", 1);
    let file = circle.path("damaged.txt");
    std::fs::write(&file, &shares).unwrap();
    let result = run(
        &[
            "vault",
            "circle",
            "recover",
            "--bundle",
            path_str(&circle.bundle()),
            "--share-file",
            path_str(&file),
            "--out",
            path_str(&circle.path("payload.json")),
        ],
        None,
    );
    let stderr = text(&result.stderr);
    assert!(!result.status.success());
    assert!(
        stderr.contains("no guardian of this circle committed to this share"),
        "{stderr}"
    );
    assert!(
        stderr.contains("share 1 is not a valid SLIP-0039 share"),
        "{stderr}"
    );
    assert!(!circle.leaks(&result));
}

#[test]
fn will_not_replace_an_output_without_force() {
    let circle = Circle::new();
    let shares = circle.path("shares.txt");
    std::fs::write(&shares, circle.shares(&circle.quorum())).unwrap();
    let bundle = circle.bundle();
    let out = circle.path("payload.json");
    std::fs::write(&out, "keep me").unwrap();
    let args = [
        "vault",
        "circle",
        "recover",
        "--bundle",
        path_str(&bundle),
        "--share-file",
        path_str(&shares),
        "--out",
        path_str(&out),
    ];
    let refused = run(&args, None);
    assert!(!refused.status.success());
    assert!(text(&refused.stderr).contains("--force"));
    assert_eq!(std::fs::read_to_string(&out).unwrap(), "keep me");

    let mut forced = args.to_vec();
    forced.push("--force");
    assert!(run(&forced, None).status.success());
    assert_eq!(
        std::fs::read_to_string(&out).unwrap(),
        circle.payload_text()
    );
}

#[test]
fn needs_a_bundle_that_parses_and_shares_to_read() {
    let circle = Circle::new();
    let missing = run(
        &[
            "vault",
            "circle",
            "recover",
            "--bundle",
            path_str(&circle.path("nope.json")),
            "--share",
            "-",
            "--out",
            "-",
        ],
        Some(""),
    );
    assert!(text(&missing.stderr).contains("cannot read"));

    let empty = run(
        &[
            "vault",
            "circle",
            "recover",
            "--bundle",
            path_str(&circle.bundle()),
            "--share",
            "-",
            "--out",
            "-",
        ],
        Some("# nothing here\n"),
    );
    assert!(text(&empty.stderr).contains("no shares given"));

    let not_a_bundle = circle.path("not-a-bundle.json");
    std::fs::write(&not_a_bundle, "{}").unwrap();
    let refused = run(
        &[
            "vault",
            "circle",
            "inspect",
            "--bundle",
            path_str(&not_a_bundle),
        ],
        None,
    );
    assert!(!refused.status.success());
    assert!(text(&refused.stderr).contains("Not a recovery bundle"));
}

/// A person's act: the agent markers `pass` reveals refuse on refuse this too,
/// before any share is read or any file is made.
#[test]
fn is_refused_in_an_agent_context_before_anything_is_read() {
    let circle = Circle::new();
    let bundle = circle.bundle();
    let out = circle.path("payload.json");
    let args = [
        "vault",
        "circle",
        "recover",
        "--bundle",
        path_str(&bundle),
        "--share",
        "-",
        "--out",
        path_str(&out),
    ];
    for marker in [
        ("CLAUDECODE", "1"),
        ("OPENSESAME_AGENT_LAUNCH_HANDLE", "handle"),
        ("OPENSESAME_AGENT_CLIENT_ID", "client"),
    ] {
        let result = run_with_env(&args, Some(&circle.shares(&circle.quorum())), &[marker]);
        let stderr = text(&result.stderr);
        assert!(!result.status.success(), "{marker:?}");
        assert!(stderr.contains("agent context"), "{stderr}");
        assert!(!out.exists());
        assert!(!circle.leaks(&result));
    }
    // Inspecting the public shape is not a recovery.
    let inspect = run_with_env(
        &["vault", "circle", "inspect", "--bundle", path_str(&bundle)],
        None,
        &[("CLAUDECODE", "1")],
    );
    assert!(inspect.status.success());
}
