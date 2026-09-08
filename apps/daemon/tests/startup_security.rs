//! Negative startup cases use isolated environments, never mutate process env.
use std::process::Command;

#[test]
fn invalid_modes_and_missing_secrets_exit_before_listening() {
    for mode in [
        None,
        Some("prod"),
        Some("Production"),
        Some(""),
        Some("production"),
    ] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_opensesame-daemon"));
        command.env_clear().arg("--listen").arg("127.0.0.1:0");
        if let Some(mode) = mode {
            command.env("OPENSESAME_ENV", mode);
        }
        let output = command.output().unwrap();
        assert!(!output.status.success(), "{mode:?}");
        let text = String::from_utf8_lossy(&output.stderr);
        assert!(text.contains("OPENSESAME_ENV") || text.contains("OPENSESAME_OPERATOR_TOKEN"));
    }
}

#[test]
fn conflicting_modes_and_networked_dev_defaults_fail_before_listening() {
    for networked in [false, true] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_opensesame-daemon"));
        command.env_clear().env("OPENSESAME_ENV", "development");
        if networked {
            command
                .env("OPENSESAME_ALLOW_DEV_DEFAULTS", "1")
                .arg("--listen")
                .arg("0.0.0.0:0");
        } else {
            command.env("NODE_ENV", "production");
        }
        assert!(!command.output().unwrap().status.success());
    }
}
