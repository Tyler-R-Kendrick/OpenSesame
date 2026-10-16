//! Conformance policy loaded from `spec/conformance/cli-app-integration.json`.

use rand_core::{OsRng, RngCore as _};
use serde::Deserialize;

pub(crate) const SOURCE: &str = include_str!("../../../spec/conformance/cli-app-integration.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Policy {
    pub(crate) idle_timeout_seconds: u64,
    pub(crate) hard_limit_seconds: u64,
    pub(crate) request_timeout_seconds: u64,
    pub(crate) daemon_pin_probe_verb: String,
    pub(crate) messages: Messages,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Messages {
    pub(crate) app_unavailable: String,
    pub(crate) denied: String,
    pub(crate) expired: String,
    pub(crate) request_timeout: String,
}

pub(crate) fn policy() -> &'static Policy {
    static POLICY: std::sync::OnceLock<Policy> = std::sync::OnceLock::new();
    POLICY.get_or_init(|| serde_json::from_str(SOURCE).expect("cli-app-integration.json"))
}

#[must_use]
pub(crate) fn daemon_pin_probe_verb() -> &'static str {
    policy().daemon_pin_probe_verb.as_str()
}

/// Random respond nonce for a pending approval row.
pub(crate) fn respond_nonce() -> String {
    let mut raw = [0u8; 16];
    OsRng.fill_bytes(&mut raw);
    hex::encode(raw)
}
