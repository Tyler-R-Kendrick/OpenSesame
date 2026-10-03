//! Named policy presets (ADR 0159, ADR 0139): `GET /api/v1/agent-hooks/presets`.
//!
//! A preset is a [`HookPolicy`] with a name and a summary, written once as a
//! file under `spec/agent-hooks/presets/` and embedded here and in the CLI
//! (`opensesame hooks policy preset`), each with a drift test. The route
//! only lists them; applying one is an ordinary `PUT …/policy` carrying the
//! preset's `policy`, so it meets the same parser, compare-and-set and
//! step-up as any other replacement, and no second way to write a policy
//! exists.
//!
//! Like the policy itself, presets are read by owner/admin or the operator
//! and never by an agent surface: the list is a catalogue of postures an
//! operator may choose between, and it is the operator's to see.

use axum::{
    extract::State,
    http::{header, HeaderMap, HeaderValue},
    response::{IntoResponse, Response},
    Json,
};
use opensesame_agent_hooks::{HookPolicy, SPEC_VERSION};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest as _, Sha256};

use super::{internal, policy_caller};
use crate::app_state::AppState;

/// The files of `spec/agent-hooks/presets/`, by name. The drift test fails
/// when this table and the directory disagree.
const SOURCES: [(&str, &str); 3] = [
    (
        "observe",
        include_str!("../../../../../spec/agent-hooks/presets/observe.json"),
    ),
    (
        "rotation-web-login",
        include_str!("../../../../../spec/agent-hooks/presets/rotation-web-login.json"),
    ),
    (
        "strict",
        include_str!("../../../../../spec/agent-hooks/presets/strict.json"),
    ),
];

/// The one shape a preset file takes.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    preset: u32,
    name: String,
    summary: String,
    policy: Value,
}

/// A preset, its policy parsed.
#[derive(Debug)]
pub(crate) struct Preset {
    pub name: String,
    pub summary: String,
    pub policy: HookPolicy,
}

/// Why an embedded preset is unusable. Never reachable from a built
/// binary the tests passed; reported, not guessed at, if it is.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct PresetFault(pub String);

fn parse(expected: &str, source: &str) -> Result<Preset, PresetFault> {
    let fault = |what: &str| PresetFault(format!("preset {expected}: {what}"));
    let envelope: Envelope =
        serde_json::from_str(source).map_err(|e| fault(&format!("not a preset file: {e}")))?;
    if envelope.preset != 1 {
        return Err(fault("unsupported preset version"));
    }
    if envelope.name != expected {
        return Err(fault("the name is not the file's name"));
    }
    let policy = HookPolicy::parse(&envelope.policy.to_string())
        .map_err(|e| fault(&format!("policy refused: {e}")))?;
    Ok(Preset {
        name: envelope.name,
        summary: envelope.summary,
        policy,
    })
}

/// Every preset, by name.
///
/// # Errors
///
/// A [`PresetFault`] when an embedded file does not parse.
pub(crate) fn all() -> Result<Vec<Preset>, PresetFault> {
    SOURCES
        .iter()
        .map(|(name, source)| parse(name, source))
        .collect()
}

fn view(preset: &Preset) -> Result<Value, PresetFault> {
    // The digest the audit of a `PUT` carries (`policy_sha256`), so a stored
    // policy can be told to be this preset, byte for byte.
    let canonical = serde_json::to_string(&preset.policy)
        .map_err(|e| PresetFault(format!("preset {}: {e}", preset.name)))?;
    Ok(json!({
        "name": preset.name,
        "summary": preset.summary,
        "policy": preset.policy,
        "policy_sha256": hex::encode(Sha256::digest(canonical.as_bytes())),
    }))
}

/// `GET /api/v1/agent-hooks/presets`.
pub async fn list(State(st): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(response) = policy_caller(&st, &headers) {
        return response;
    }
    let presets = all().and_then(|all| all.iter().map(view).collect::<Result<Vec<_>, _>>());
    match presets {
        Ok(presets) => {
            let mut response =
                Json(json!({ "spec": SPEC_VERSION, "presets": presets })).into_response();
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        Err(fault) => internal("read agent-hooks presets", &anyhow::anyhow!(fault.0)),
    }
}

#[cfg(test)]
#[path = "presets_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "presets_walk_tests.rs"]
mod walk_tests;
