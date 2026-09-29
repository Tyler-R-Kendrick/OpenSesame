//! `opensesame hooks policy get|put` — the organization's agent-hooks policy
//! on the Host (ADR 0150).
//!
//! The Host's remote interceptor decides under this policy. Reading and
//! replacing it is owner/admin or operator work, and a replacement is a
//! compare-and-set: `put` names the version it was made against
//! (`--if-version`, from `get`), and a policy someone else replaced since is
//! refused rather than silently overwritten. The file is checked with the
//! same parser before it leaves, so a malformed rule is reported by position
//! without a round trip; the Host checks it again.

use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use clap::Subcommand;
use opensesame_agent_hooks::HookPolicy;
use reqwest::{Method, StatusCode};
use serde_json::{json, Value};

/// The Host API route.
const POLICY_PATH: &str = "/api/v1/agent-hooks/policy";

#[derive(Subcommand, Debug)]
pub enum PolicyCmd {
    /// Print the organization's policy, every default filled, with its version.
    Get,
    /// Replace the organization's policy with FILE (compare-and-set).
    Put {
        /// Hook policy (JSON).
        file: PathBuf,
        /// The version this replacement was made against, as `get` printed it
        /// (0 when no policy is stored yet).
        #[arg(long)]
        if_version: u64,
    },
}

struct Reply {
    status: StatusCode,
    body: Value,
}

/// One call, trying each stored credential the way every Host command does:
/// a 401/403 moves on to the next, anything else is the answer.
async fn call(
    server: &str,
    method: Method,
    if_match: Option<u64>,
    body: Option<String>,
) -> Result<Reply> {
    let url = format!("{}{POLICY_PATH}", server.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let mut last = Reply {
        status: StatusCode::UNAUTHORIZED,
        body: json!({"error": "unauthorized"}),
    };
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
        if status != StatusCode::UNAUTHORIZED && status != StatusCode::FORBIDDEN {
            break;
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
            "the policy changed since version {read} was read; it is now version {current}. \
             Run `opensesame hooks policy get` and reapply"
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

/// `opensesame hooks policy …`.
pub async fn run(server: &str, cmd: PolicyCmd) -> Result<()> {
    match cmd {
        PolicyCmd::Get => {
            let reply = call(server, Method::GET, None, None).await?;
            if !reply.status.is_success() {
                bail!(failure(&reply, None));
            }
            print(&reply)
        }
        PolicyCmd::Put { file, if_version } => {
            let text = std::fs::read_to_string(&file)
                .with_context(|| format!("reading hook policy {}", file.display()))?;
            HookPolicy::parse(&text).with_context(|| format!("hook policy {}", file.display()))?;
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
    fn a_lost_race_says_what_changed_and_what_to_do() {
        let reply = Reply {
            status: StatusCode::PRECONDITION_FAILED,
            body: json!({"error": "precondition_failed", "current_version": 4}),
        };
        let said = failure(&reply, Some(3));
        assert!(said.contains("version 3 was read"), "{said}");
        assert!(said.contains("now version 4"), "{said}");
    }

    #[test]
    fn other_failures_carry_the_hosts_hint() {
        let reply = Reply {
            status: StatusCode::BAD_REQUEST,
            body: json!({"error": "invalid_policy", "hint": "tools[2] must set exactly one"}),
        };
        assert_eq!(
            failure(&reply, Some(0)),
            "Host API 400 Bad Request: tools[2] must set exactly one"
        );
        let bare = Reply {
            status: StatusCode::FORBIDDEN,
            body: json!({}),
        };
        assert_eq!(failure(&bare, None), "Host API 403 Forbidden: 403");
    }
}
