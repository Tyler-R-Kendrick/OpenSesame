//! The Host calls behind `rotate recipe` and `rotate signer`: one request
//! that tries each stored credential the way every Host command does, and the
//! honest sentence for each way it can fail.

use std::fmt::Write as _;

use anyhow::{Context, Result};
use opensesame_rotation_web::recipe_doc::canonical_origin;
use reqwest::{Method, StatusCode};
use serde_json::{json, Value};

/// The Host's stable code for a change that needs a step-up (ADR 0146).
const STEP_UP_REQUIRED: &str = "step_up_required";

pub(super) const RECIPES: &str = "/api/v1/web-login/recipes";
pub(super) const SIGNERS: &str = "/api/v1/web-login/signers";

pub(super) struct Reply {
    pub status: StatusCode,
    pub body: Value,
}

fn is_step_up_refusal(reply: &Reply) -> bool {
    reply.status == StatusCode::FORBIDDEN && reply.body["error"].as_str() == Some(STEP_UP_REQUIRED)
}

/// `origin` as a canonical origin in a path segment: percent-encoded, so the
/// slashes of `https://host` do not become path.
///
/// # Errors
///
/// When it is not an https origin (no path, query or credentials).
pub(super) fn origin_path(origin: &str) -> Result<String> {
    let canonical = canonical_origin(origin).with_context(|| {
        format!("`{origin}` is not an https origin: no path, query, fragment or credentials")
    })?;
    let mut encoded = String::new();
    for byte in canonical.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    Ok(format!("{RECIPES}/{encoded}"))
}

/// One call. A 401/403 moves on to the next credential and anything else is
/// the answer; a step-up refusal is remembered so a later credential's plain
/// 401 cannot hide it.
pub(super) async fn call(
    server: &str,
    method: Method,
    path: &str,
    if_match: Option<u64>,
    body: Option<String>,
) -> Result<Reply> {
    let url = format!("{}{path}", server.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let mut last = Reply {
        status: StatusCode::UNAUTHORIZED,
        body: json!({"error": "unauthorized"}),
    };
    let mut step_up: Option<Reply> = None;
    for auth in crate::connect::authorization_headers() {
        let mut request = client
            .request(method.clone(), &url)
            .header("authorization", &auth);
        if let Some(version) = if_match {
            request = request.header("if-match", format!("\"{version}\""));
        }
        if let Some(text) = &body {
            request = request
                .header("content-type", "application/json")
                .body(text.clone());
        }
        let response = request.send().await.context("calling Host API")?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        last = Reply {
            status,
            body: serde_json::from_str(&text).unwrap_or_else(|_| json!({})),
        };
        if is_step_up_refusal(&last) {
            step_up = Some(Reply {
                status: last.status,
                body: last.body.clone(),
            });
        }
        if status != StatusCode::UNAUTHORIZED && status != StatusCode::FORBIDDEN {
            break;
        }
    }
    if last.status == StatusCode::UNAUTHORIZED || last.status == StatusCode::FORBIDDEN {
        if let Some(refusal) = step_up {
            return Ok(refusal);
        }
    }
    Ok(last)
}

/// Why a call failed, from the Host's own error shape. `what` names the thing
/// ("the recipe"), `reread` the command that reads it again.
pub(super) fn failure(reply: &Reply, what: &str, reread: &str, if_version: Option<u64>) -> String {
    if reply.status == StatusCode::PRECONDITION_FAILED {
        let current = reply.body["current_version"].as_i64().unwrap_or_default();
        let read = if_version.unwrap_or_default();
        return format!(
            "{what} changed since version {read} was read; it is now version {current}. \
             Run `{reread}` and reapply"
        );
    }
    if is_step_up_refusal(reply) {
        let hint = reply.body["hint"].as_str().unwrap_or_default();
        return format!(
            "Host API 403 step_up_required: {what} needs the operator token or a fresh passkey \
             step-up, not a session alone. Export OPENSESAME_OPERATOR_TOKEN and run this again, \
             or use a session that carries a passkey step-up from the last five minutes. {hint}"
        );
    }
    let hint = reply
        .body
        .get("hint")
        .or_else(|| reply.body.get("error"))
        .and_then(Value::as_str)
        .unwrap_or(reply.status.as_str());
    format!("Host API {}: {hint}", reply.status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_origin_is_one_encoded_path_segment() {
        assert_eq!(
            origin_path("https://login.example").unwrap(),
            "/api/v1/web-login/recipes/https%3A%2F%2Flogin.example"
        );
        assert_eq!(
            origin_path("https://LOGIN.example:443/").unwrap(),
            "/api/v1/web-login/recipes/https%3A%2F%2Flogin.example"
        );
        assert_eq!(
            origin_path("https://login.example:8443").unwrap(),
            "/api/v1/web-login/recipes/https%3A%2F%2Flogin.example%3A8443"
        );
        for bad in [
            "login.example",
            "http://login.example",
            "https://u:p@login.example",
            "https://login.example/x",
        ] {
            assert!(origin_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_lost_race_names_what_changed_and_how_to_read_it() {
        let reply = Reply {
            status: StatusCode::PRECONDITION_FAILED,
            body: json!({"error": "precondition_failed", "current_version": 4}),
        };
        let said = failure(
            &reply,
            "the recipe",
            "opensesame access connectors rotate recipe get ORIGIN",
            Some(3),
        );
        assert!(
            said.contains("version 3 was read") && said.contains("now version 4"),
            "{said}"
        );
        assert!(
            said.contains("opensesame access connectors rotate recipe get ORIGIN"),
            "{said}"
        );
    }

    #[test]
    fn a_missing_step_up_names_the_remedy_and_other_failures_the_hosts_hint() {
        let step_up = Reply {
            status: StatusCode::FORBIDDEN,
            body: json!({"error": "step_up_required", "hint": "to pin it this session needs a step-up"}),
        };
        let said = failure(&step_up, "pinning a recipe signer", "x", None);
        assert!(
            said.contains("OPENSESAME_OPERATOR_TOKEN") && said.contains("passkey"),
            "{said}"
        );
        assert!(said.contains("needs a step-up"), "{said}");
        let refused = Reply {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            body: json!({"error": "unknown_signer", "hint": "pin it first"}),
        };
        assert_eq!(
            failure(&refused, "the recipe", "x", Some(0)),
            "Host API 422 Unprocessable Entity: pin it first"
        );
        let role = Reply {
            status: StatusCode::FORBIDDEN,
            body: json!({"error": "forbidden", "hint": "owner or admin role required"}),
        };
        assert_eq!(
            failure(&role, "the recipe", "x", None),
            "Host API 403 Forbidden: owner or admin role required"
        );
    }
}
