//! `opensesame hooks approver get|put` — who the Host puts the organization's
//! escalated agent actions to (ADR 0159).
//!
//! The policy (`hooks policy`) says whether an action needs a person; this
//! says which one. `put` names the inbox handle (`--ref`, from the approver's
//! own `GET /v1/authorization-requests/inbox-ref`) or `--clear` to ask nobody,
//! and the version it was made against (`--if-version`, from `get`): a
//! setting someone else replaced since is refused, never overwritten.
//!
//! Like the policy, it takes a step-up the Host asks for: the operator token
//! (`OPENSESAME_OPERATOR_TOKEN`), or a human session's fresh passkey evidence.
//! The Host also needs an Identity API and a requester bearer of its own
//! (`OPENSESAME_AGENT_HOOKS_APPROVER_*`, docs/operators/agent-hooks.md); `get`
//! says whether it has them (`transport_configured`).

use anyhow::{bail, Context, Result};
use clap::Subcommand;
use reqwest::{Method, StatusCode};
use serde_json::{json, Value};

const APPROVER_PATH: &str = "/api/v1/agent-hooks/approver";

/// The Host's stable code for a change that needs a step-up (ADR 0146).
const STEP_UP_REQUIRED: &str = "step_up_required";

#[derive(Subcommand, Debug)]
pub enum ApproverCmd {
    /// Print who is asked, with the setting's version.
    Get,
    /// Replace the approver (compare-and-set). Needs the operator token or a
    /// fresh passkey step-up; a plain admin session is refused.
    Put {
        /// The approver's inbox handle (`inbox_…`).
        #[arg(
            long = "ref",
            value_name = "INBOX_HANDLE",
            required_unless_present = "clear"
        )]
        approver_ref: Option<String>,
        /// Ask nobody: every escalation of the organization is a denial.
        #[arg(long, conflicts_with = "approver_ref")]
        clear: bool,
        /// The version this replacement was made against, as `get` printed it
        /// (0 when none is stored yet).
        #[arg(long)]
        if_version: u64,
    },
}

struct Reply {
    status: StatusCode,
    body: Value,
}

fn is_step_up_refusal(reply: &Reply) -> bool {
    reply.status == StatusCode::FORBIDDEN && reply.body["error"].as_str() == Some(STEP_UP_REQUIRED)
}

/// One call, trying each stored credential the way every Host command does:
/// a 401/403 moves on to the next, anything else is the answer. A step-up
/// refusal is remembered so a later credential's plain 401 cannot hide it.
async fn call(
    server: &str,
    method: Method,
    if_match: Option<u64>,
    body: Option<String>,
) -> Result<Reply> {
    let url = format!("{}{APPROVER_PATH}", server.trim_end_matches('/'));
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
    // Only when the credentials ran out without a real answer: a stale
    // version the operator token earned is the answer, not the session's
    // earlier refusal.
    if last.status == StatusCode::UNAUTHORIZED || last.status == StatusCode::FORBIDDEN {
        if let Some(refusal) = step_up {
            return Ok(refusal);
        }
    }
    Ok(last)
}

/// Why a call failed, from the Host's own error shape.
fn failure(reply: &Reply, if_version: Option<u64>) -> String {
    if reply.status == StatusCode::PRECONDITION_FAILED {
        let current = reply.body["current_version"].as_i64().unwrap_or_default();
        let read = if_version.unwrap_or_default();
        return format!(
            "the approver changed since version {read} was read; it is now version {current}. \
             Run `opensesame hooks approver get` and reapply"
        );
    }
    if is_step_up_refusal(reply) {
        let hint = reply.body["hint"].as_str().unwrap_or_default();
        return format!(
            "Host API 403 step_up_required: changing who approves agent actions needs the \
             operator token or a fresh passkey step-up, not a session alone. Export \
             OPENSESAME_OPERATOR_TOKEN and run this again, or use a session that carries a passkey \
             step-up from the last five minutes. {hint}"
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

fn print(reply: &Reply) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(&reply.body)?);
    Ok(())
}

/// The body to send. The handle is checked for shape before it leaves; the
/// Host checks it again.
fn replacement(approver_ref: Option<&str>, clear: bool) -> Result<String> {
    let value = match (approver_ref, clear) {
        (Some(handle), false) => {
            let plausible = handle.starts_with("inbox_")
                && (8..=256).contains(&handle.len())
                && handle
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'));
            if !plausible {
                bail!(
                    "--ref is the approver's inbox handle (inbox_…), as their `inbox-ref` shows it"
                );
            }
            json!(handle)
        }
        (None, true) => Value::Null,
        // clap makes exactly one of them required.
        _ => bail!("name --ref HANDLE or --clear, not both"),
    };
    Ok(json!({ "approver_ref": value }).to_string())
}

/// `opensesame hooks approver …`.
pub async fn run(server: &str, cmd: ApproverCmd) -> Result<()> {
    match cmd {
        ApproverCmd::Get => {
            let reply = call(server, Method::GET, None, None).await?;
            if !reply.status.is_success() {
                bail!(failure(&reply, None));
            }
            print(&reply)
        }
        ApproverCmd::Put {
            approver_ref,
            clear,
            if_version,
        } => {
            let text = replacement(approver_ref.as_deref(), clear)?;
            let reply = call(server, Method::PUT, Some(if_version), Some(text)).await?;
            if !reply.status.is_success() {
                bail!(failure(&reply, Some(if_version)));
            }
            print(&reply)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_replacement_is_one_handle_or_an_explicit_clear() {
        assert_eq!(
            replacement(Some("inbox_YXBwcm92ZXI.tag"), false).unwrap(),
            r#"{"approver_ref":"inbox_YXBwcm92ZXI.tag"}"#
        );
        assert_eq!(replacement(None, true).unwrap(), r#"{"approver_ref":null}"#);
        for bad in [
            "",
            "inbox_",
            "https://x/inbox_abcdefgh",
            "inbox_a b",
            "nope_abcdefgh",
        ] {
            assert!(replacement(Some(bad), false).is_err(), "{bad:?}");
        }
        assert!(replacement(None, false).is_err());
        assert!(replacement(Some("inbox_abcdefgh"), true).is_err());
    }

    #[test]
    fn the_failures_say_what_to_do() {
        let stale = Reply {
            status: StatusCode::PRECONDITION_FAILED,
            body: json!({"current_version": 4}),
        };
        let text = failure(&stale, Some(2));
        assert!(
            text.contains("version 2") && text.contains("version 4"),
            "{text}"
        );
        let step_up = Reply {
            status: StatusCode::FORBIDDEN,
            body: json!({"error": "step_up_required", "hint": "present the operator token"}),
        };
        let text = failure(&step_up, Some(0));
        assert!(text.contains("OPENSESAME_OPERATOR_TOKEN"), "{text}");
        assert!(text.contains("present the operator token"), "{text}");
    }
}
