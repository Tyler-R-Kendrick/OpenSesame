//! Test-only approval seam; never linked in release builds without `test-seams`.

/// Test seam: `approve`, `deny`, or `unavailable`.
#[must_use]
pub fn seam_decision() -> Option<&'static str> {
    match std::env::var("OPENSESAME_CLI_APP_INTEGRATION_SEAM")
        .ok()
        .as_deref()
    {
        Some("approve") => Some("approve"),
        Some("deny") => Some("deny"),
        Some("unavailable") => Some("unavailable"),
        _ => None,
    }
}
