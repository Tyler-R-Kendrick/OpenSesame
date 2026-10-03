//! The plugin's control protocol: one JSON line in (the run spec), one JSON
//! line out (the reply), over the plugin's own stdin and stdout.
//!
//! ```text
//! parent → plugin  {"run_id","ttl_secs","entries":[{"env_var","provider_id",
//!                   "connection_ref","site","methods","path_prefixes"}],
//!                   "passthrough_hosts":[],"notices_path"}
//! plugin → parent  {"proxy_url","ca_pem_path","env":{…},"unserved":[…]}
//!              or  {"error":"<class>"}
//! ```
//!
//! `site` is `"authorization"` or `"header:<name>"`. An entry whose provider
//! this build cannot broker (no egress rule, or no local credential source)
//! is listed in `unserved` and issued nothing, so the parent keeps whatever it
//! would have delivered without the plugin. Unknown fields are refused: a
//! misspelt field silently ignored is a scope nobody asked for.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use opensesame_invoke_through::{rule_for, source_tool, SurrogateSite, EGRESS_RULES};
use serde::{Deserialize, Serialize};

use crate::runs::{RunSpec, SurrogateGrant};

/// The longest spec line the plugin reads. Far above any real run; a parent
/// that sends more is not a parent this plugin serves.
pub const MAX_SPEC_BYTES: usize = 256 * 1024;

/// The longest run the plugin serves before it revokes and exits by itself.
pub const MAX_TTL_SECS: u64 = 24 * 60 * 60;

/// Longest run id. It names a directory, so it is short and plain.
const MAX_RUN_ID_CHARS: usize = 96;

/// One surrogate the parent asks for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EntrySpec {
    pub env_var: String,
    pub provider_id: String,
    pub connection_ref: String,
    pub site: String,
    pub methods: Vec<String>,
    pub path_prefixes: Vec<String>,
}

/// The one line the parent writes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunRequest {
    pub run_id: String,
    pub ttl_secs: u64,
    pub entries: Vec<EntrySpec>,
    #[serde(default)]
    pub passthrough_hosts: Vec<String>,
    pub notices_path: PathBuf,
}

/// The one line the plugin writes on success. It carries the run's proxy
/// credential and surrogates, so it has no `Debug` and goes nowhere but the
/// parent's pipe.
#[derive(Serialize, Deserialize)]
pub struct RunReply {
    pub proxy_url: String,
    pub ca_pem_path: PathBuf,
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub unserved: Vec<String>,
}

/// The one line the plugin writes on failure: a class, never a value.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ErrorReply {
    pub error: String,
}

/// Why a spec was refused. Names no value the parent sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum SpecError {
    #[error("spec_too_large")]
    TooLarge,
    #[error("spec_malformed")]
    Malformed,
    #[error("spec_run_id")]
    RunId,
    #[error("spec_ttl")]
    Ttl,
    #[error("spec_site")]
    Site,
    #[error("spec_notices_path")]
    NoticesPath,
}

impl SpecError {
    /// The wire class.
    #[must_use]
    pub fn class(self) -> String {
        self.to_string()
    }
}

/// Parse one spec line.
///
/// # Errors
///
/// `TooLarge`, `Malformed`, `RunId` (empty, too long, or not
/// `[A-Za-z0-9._-]`), `Ttl` (zero or beyond [`MAX_TTL_SECS`]), or
/// `NoticesPath` (relative).
pub fn parse_request(line: &[u8]) -> Result<RunRequest, SpecError> {
    if line.len() > MAX_SPEC_BYTES {
        return Err(SpecError::TooLarge);
    }
    let request: RunRequest = serde_json::from_slice(line).map_err(|_| SpecError::Malformed)?;
    if !is_run_id(&request.run_id) {
        return Err(SpecError::RunId);
    }
    if request.ttl_secs == 0 || request.ttl_secs > MAX_TTL_SECS {
        return Err(SpecError::Ttl);
    }
    if !request.notices_path.is_absolute() {
        return Err(SpecError::NoticesPath);
    }
    Ok(request)
}

/// A run id is a path component, so it is plain.
#[must_use]
pub fn is_run_id(run_id: &str) -> bool {
    !run_id.is_empty()
        && run_id.len() <= MAX_RUN_ID_CHARS
        && !run_id.starts_with('.')
        && run_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// `"authorization"` or `"header:<name>"`.
///
/// # Errors
///
/// `Site` for anything else, or a header name that is not a token.
pub fn parse_site(site: &str) -> Result<SurrogateSite, SpecError> {
    if site.eq_ignore_ascii_case("authorization") {
        return Ok(SurrogateSite::Authorization);
    }
    let name = site.strip_prefix("header:").ok_or(SpecError::Site)?;
    let token = !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'));
    if !token || name.eq_ignore_ascii_case("authorization") {
        return Err(SpecError::Site);
    }
    Ok(SurrogateSite::Header(name.to_ascii_lowercase()))
}

/// Whether this build can broker `provider_id`: an egress rule to admit
/// against and a local tool to draw the credential from.
#[must_use]
pub fn is_served(provider_id: &str) -> bool {
    rule_for(EGRESS_RULES, provider_id).is_some() && source_tool(provider_id).is_some()
}

/// The run spec for the served entries, and the env vars of the rest.
///
/// # Errors
///
/// `Site` when a served entry names a site that does not parse.
pub fn to_run_spec(request: &RunRequest) -> Result<(RunSpec, Vec<String>), SpecError> {
    let ttl = Duration::from_secs(request.ttl_secs);
    let mut grants = Vec::new();
    let mut unserved = Vec::new();
    for entry in &request.entries {
        if !is_served(&entry.provider_id) {
            unserved.push(entry.env_var.clone());
            continue;
        }
        grants.push(SurrogateGrant {
            env_var: entry.env_var.clone(),
            provider_id: entry.provider_id.clone(),
            connection_ref: entry.connection_ref.clone(),
            site: parse_site(&entry.site)?,
            methods: entry.methods.clone(),
            path_prefixes: entry.path_prefixes.clone(),
            ttl,
        });
    }
    let spec = RunSpec {
        grants,
        passthrough_hosts: request.passthrough_hosts.clone(),
    };
    Ok((spec, unserved))
}

#[cfg(test)]
#[path = "wire_tests.rs"]
mod tests;
