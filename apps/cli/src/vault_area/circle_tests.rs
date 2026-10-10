//! Unit tests of `vault circle`: reading shares, redaction and the inspect
//! rendering. The verbs as a person runs them are in `tests/vault_circle/`.

use super::render::{inspect_json, render_inspect};
use super::{check_destination, collect_shares, shares_in, CircleCmd};
use opensesame_quorum_recovery::RecoveryBundle;
use std::path::{Path, PathBuf};

const FIXTURE: &str = include_str!("../../../../spec/conformance/quorum-recovery-fixture.json");

fn fixture_bundle() -> RecoveryBundle {
    let fixture: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
    RecoveryBundle::from_value(&fixture["bundle"], None).unwrap()
}

#[test]
fn a_list_of_shares_is_one_per_line_without_comments_or_blanks() {
    let text = "# the family\n\n  alpha beta gamma  \r\n#another\nsecond share here\n";
    let shares = shares_in(text);
    let lines: Vec<&str> = shares.iter().map(|s| s.as_str()).collect();
    assert_eq!(lines, ["alpha beta gamma", "second share here"]);
}

#[test]
fn a_debug_print_of_the_command_never_shows_a_share() {
    let cmd = CircleCmd::Recover {
        bundle: PathBuf::from("bundle.json"),
        share: vec!["word1 word2 word3".to_owned()],
        share_file: vec![],
        out: PathBuf::from("-"),
        owner_key: None,
        force: false,
    };
    let printed = format!("{cmd:?}");
    assert!(!printed.contains("word1"), "{printed}");
    assert!(printed.contains("REDACTED"));
}

#[test]
fn no_shares_is_a_usage_error_and_stdin_is_read_once() {
    let none = collect_shares(&[], &[]).unwrap_err().to_string();
    assert!(none.contains("no shares given"), "{none}");
    let twice = collect_shares(&["-".to_owned(), "-".to_owned()], &[])
        .unwrap_err()
        .to_string();
    assert!(twice.contains("reads stdin once"), "{twice}");
}

#[test]
fn a_missing_share_file_names_the_path_and_nothing_else() {
    let error = collect_shares(&[], &[PathBuf::from("/nonexistent/shares.txt")])
        .unwrap_err()
        .to_string();
    assert!(error.contains("/nonexistent/shares.txt"), "{error}");
}

#[test]
fn an_existing_output_needs_force_and_stdout_is_not_a_terminal_here() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("out.json");
    assert!(check_destination(&file, false).is_ok());
    std::fs::write(&file, b"x").unwrap();
    let error = check_destination(&file, false).unwrap_err().to_string();
    assert!(error.contains("--force"), "{error}");
    assert!(check_destination(&file, true).is_ok());
    // Under `cargo test` stdout is captured, never a terminal.
    assert!(check_destination(Path::new("-"), false).is_ok());
}

#[test]
fn inspect_prints_the_public_shape_and_no_secret() {
    let bundle = fixture_bundle();
    let shape = inspect_json(&bundle);
    assert_eq!(shape["epoch"], 1);
    assert_eq!(shape["groupThreshold"], 2);
    assert_eq!(shape["signatureVerified"], true);
    let names: Vec<&str> = shape["groups"][0]["guardians"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Ada", "Ben", "Cy"]);

    let json = render_inspect(&bundle, "json");
    assert!(json.contains("\"circleId\""));
    let text = render_inspect(&bundle, "text");
    assert!(
        text.starts_with("OK -- the owner's signature verifies"),
        "{text}"
    );
    assert!(text.contains("family: 2 of 3: Ada, Ben, Cy"), "{text}");
    for forbidden in ["nonce", "ciphertext", "hpkePublicKey", "credentialId"] {
        assert!(!json.contains(forbidden) && !text.contains(forbidden));
    }
}
