//! A configuration refusal must precede `SQLite` creation and listener startup.
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn refuses_before_storage(
    mode: Option<&str>,
    node: Option<&str>,
    dev: Option<&str>,
    networked: bool,
    pepper: bool,
) {
    let directory =
        std::env::temp_dir().join(format!("opensesame-startup-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let database = directory.join("must-not-exist.db");
    let secret = || {
        format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        )
    };
    let mut command = Command::new(env!("CARGO_BIN_EXE_opensesame-gateway"));
    command
        .env_clear()
        .env("OPENSESAME_OPERATOR_TOKEN", secret())
        .args([
            "--listen",
            if networked {
                "0.0.0.0:0"
            } else {
                "127.0.0.1:0"
            },
        ])
        .args([
            "--resource",
            "http://127.0.0.1:8787",
            "--issuer",
            "http://127.0.0.1:8788",
        ])
        .arg("--database-url")
        .arg(format!("sqlite://{}?mode=rwc", database.display()))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(mode) = mode {
        command.env("OPENSESAME_ENV", mode);
    }
    if let Some(node) = node {
        command.env("NODE_ENV", node);
    }
    if let Some(dev) = dev {
        command.env("OPENSESAME_ALLOW_DEV_DEFAULTS", dev);
    }
    if pepper {
        command.env("OPENSESAME_CLAIM_PEPPER", secret());
    }
    let mut child = command.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("invalid configuration did not abort startup");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    assert!(!database.exists(), "configuration failure mutated SQLite");
    assert!(!String::from_utf8_lossy(&output.stdout).contains("gateway listening"));
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(
        error.contains("OPENSESAME_") || error.contains("NODE_ENV"),
        "unexpected startup failure: {error}"
    );
    std::fs::remove_dir(directory).unwrap();
}

#[test]
fn strict_mode_and_missing_pepper_refuse_before_database_mutation() {
    for mode in [
        None,
        Some(""),
        Some("prod"),
        Some("Production"),
        Some(" production "),
    ] {
        refuses_before_storage(mode, None, None, false, true);
    }
    refuses_before_storage(Some("development"), Some("production"), None, false, true);
    refuses_before_storage(Some("development"), None, Some("1"), true, true);
    refuses_before_storage(Some("production"), None, None, false, false);
    refuses_before_storage(Some("development"), None, None, true, false);
}
