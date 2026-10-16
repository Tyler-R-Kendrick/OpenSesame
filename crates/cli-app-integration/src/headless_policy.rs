//! Headless Linux enrollment policy (D7-2 §3.3 tier B).

/// When false, `/dev/tty` enrollment is refused unless the operator opts in and
/// the daemon holds no secrets yet (weak anchor).
#[must_use]
pub fn tty_enrollment_explicitly_allowed() -> bool {
    matches!(
        std::env::var("OPENSESAME_CLI_APP_ALLOW_TTY_ENROLL").as_deref(),
        Ok("1") | Ok("true") | Ok("yes")
    )
}

/// Refuse tty bootstrap when secrets could be released without a strong anchor.
#[must_use]
pub fn refuse_tty_enrollment_without_opt_in(daemon_holds_cli_secrets: bool) -> bool {
    if !daemon_holds_cli_secrets && tty_enrollment_explicitly_allowed() {
        return false;
    }
    true
}
