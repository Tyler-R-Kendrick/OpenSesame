//! The plugin's control protocol: one JSON line in (the run spec), one JSON
//! line out (the reply), over the plugin's own stdin and stdout.
//!
//! ```text
//! parent → plugin  {"run_id","ttl_secs","entries":[{"env_var","provider_id",
//!                   "connection_ref","site","methods","path_prefixes"}],
//!                   "logins":[{"env_var","origin","action","field","secret",
//!                   "ca_pem"?}],"passthrough_hosts":[],"watched"?,"notices_path"}
//! plugin → parent  {"proxy_url","ca_pem_path","env":{…},"unserved":[…]}
//!              or  {"error":"<class>"}
//! plugin → parent  {"event":"tripwire",…} | {"event":"login",…}  (while it runs)
//! ```
//!
//! A login's `secret` is the credential itself, read by the parent from the
//! person's sealed store (ADR 0150 §6.3). It travels only in this line, over
//! this pipe — never argv, never a file — and nothing the plugin writes
//! repeats it: the spec types have no `Serialize` and a `Debug` that names
//! no value. `watched` defaults to true: the parent that spawned the run is
//! reading its stdout, so a misdirected surrogate revokes the run at once
//! (ADR 0150 §6.2) unless the parent says nobody is watching.
//!
//! `methods` and `path_prefixes` are the narrowest operation the child needs
//! (ADR 0150 section 8) and are required to be bounded for a served entry:
//! at least one method, and at least one absolute path prefix, none of them
//! the root. The root, an empty list, a relative prefix, a dot or empty
//! segment, a query or a fragment is refused as `spec_path_scope:<env_var>`
//! before anything is issued; the run does not start.
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
use secrecy::SecretString;
use serde::{Deserialize, Serialize};

use crate::login::{LoginGrant, LoginTrust};
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

/// One login form the parent asks for, with the credential it signs in
/// with. `Debug` names the site, never the secret.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoginSpec {
    pub env_var: String,
    /// `https://host[:port]`, exact.
    pub origin: String,
    /// The form's action path, exact.
    pub action: String,
    /// The one field the credential goes into.
    pub field: String,
    pub secret: SecretString,
    /// A private origin's trust anchor, replacing webpki for it alone.
    #[serde(default)]
    pub ca_pem: Option<String>,
}

impl std::fmt::Debug for LoginSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoginSpec")
            .field("env_var", &self.env_var)
            .field("origin", &self.origin)
            .field("action", &self.action)
            .field("field", &self.field)
            .field("ca_pem", &self.ca_pem.is_some())
            .finish_non_exhaustive()
    }
}

/// The one line the parent writes.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunRequest {
    pub run_id: String,
    pub ttl_secs: u64,
    pub entries: Vec<EntrySpec>,
    #[serde(default)]
    pub logins: Vec<LoginSpec>,
    #[serde(default)]
    pub passthrough_hosts: Vec<String>,
    #[serde(default = "watched_by_default")]
    pub watched: bool,
    pub notices_path: PathBuf,
}

const fn watched_by_default() -> bool {
    true
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
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
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
    /// A served entry whose methods or path prefixes are not a bounded scope.
    /// Names the entry's environment variable, never a value.
    #[error("spec_path_scope:{0}")]
    PathScope(String),
}

impl SpecError {
    /// The wire class.
    #[must_use]
    pub fn class(&self) -> String {
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

/// Whether `prefix` bounds a path: absolute, with at least one named
/// segment and no empty, `.` or `..` segment, query, fragment, backslash,
/// whitespace or control character. The root bounds nothing.
#[must_use]
pub fn is_bounded_prefix(prefix: &str) -> bool {
    let Some(rest) = prefix.strip_prefix('/') else {
        return false;
    };
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    !rest.is_empty()
        && rest
            .split('/')
            .all(|segment| !matches!(segment, "" | "." | ".."))
        && !prefix
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || matches!(c, '?' | '#' | '\\'))
}

/// The run spec for the served entries, and the env vars of the rest.
///
/// # Errors
///
/// `Site` when a served entry names a site that does not parse, `PathScope`
/// when a served entry has no method or a path prefix that is not bounded.
pub fn to_run_spec(request: &RunRequest) -> Result<(RunSpec, Vec<String>), SpecError> {
    let ttl = Duration::from_secs(request.ttl_secs);
    let mut grants = Vec::new();
    let mut unserved = Vec::new();
    for entry in &request.entries {
        if !is_served(&entry.provider_id) {
            unserved.push(entry.env_var.clone());
            continue;
        }
        if entry.methods.is_empty()
            || entry.path_prefixes.is_empty()
            || !entry.path_prefixes.iter().all(|p| is_bounded_prefix(p))
        {
            return Err(SpecError::PathScope(entry.env_var.clone()));
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
    let logins = request
        .logins
        .iter()
        .map(|login| LoginGrant {
            env_var: login.env_var.clone(),
            origin: login.origin.clone(),
            action_path: login.action.clone(),
            field: login.field.clone(),
            credential: login.secret.clone(),
            trust: login
                .ca_pem
                .clone()
                .map_or(LoginTrust::Webpki, LoginTrust::Anchor),
        })
        .collect();
    let spec = RunSpec {
        grants,
        logins,
        passthrough_hosts: request.passthrough_hosts.clone(),
        watched: request.watched,
    };
    Ok((spec, unserved))
}

#[cfg(test)]
#[path = "wire_tests.rs"]
mod tests;
