//! `opensesame hooks policy get|put` — the organization's agent-hooks policy
//! on the Host (ADR 0159).
//!
//! The Host's remote interceptor decides under this policy. Reading and
//! replacing it is owner/admin or operator work, and a replacement is a
//! compare-and-set: `put` names the version it was made against
//! (`--if-version`, from `get`), and a policy someone else replaced since is
//! refused rather than silently overwritten. The file is checked with the
//! same parser before it leaves, so a malformed rule is reported by position
//! without a round trip; the Host checks it again.
//!
//! Replacing the policy also takes a **step-up** the Host asks for: the
//! operator token, or a human session's fresh passkey evidence. A native
//! session on its own, an admin's included, is refused as `step_up_required`
//! and `put` says what to present instead ([`failure`]). A named starting
//! point is `put --preset NAME` (`preset ls|show` list them, offline).

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use clap::Subcommand;
use opensesame_agent_hooks::HookPolicy;
use reqwest::{Method, StatusCode};
use serde_json::{json, Value};

/// The Host API route.
const POLICY_PATH: &str = "/api/v1/agent-hooks/policy";

/// The Host's stable code for a replacement that needs a step-up (ADR 0146).
const STEP_UP_REQUIRED: &str = "step_up_required";

#[path = "hooks_presets.rs"]
mod presets;

#[derive(Subcommand, Debug)]
pub enum PolicyCmd {
    /// Print the organization's policy, every default filled, with its version.
    Get,
    /// The named policies (`rotation-web-login`, `strict`, `observe`),
    /// compiled in: no Host needed.
    Preset {
        #[command(subcommand)]
        cmd: presets::PresetCmd,
    },
    /// Replace the organization's policy with FILE or a preset
    /// (compare-and-set). Needs the operator token or a fresh passkey
    /// step-up; a plain admin session is refused.
    Put {
        /// Hook policy (JSON).
        #[arg(required_unless_present = "preset")]
        file: Option<PathBuf>,
        /// A named policy from `preset ls`, instead of a file.
        #[arg(long, conflicts_with = "file")]
        preset: Option<String>,
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
    // A session the Host judged too weak says what would do; a later
    // credential's plain 401 must not hide that.
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
    // version the operator token earned (412) is the answer, not the
    // session's earlier refusal.
    if last.status == StatusCode::UNAUTHORIZED || last.status == StatusCode::FORBIDDEN {
        if let Some(refusal) = step_up {
            return Ok(refusal);
        }
    }
    Ok(last)
}

fn is_step_up_refusal(reply: &Reply) -> bool {
    reply.status == StatusCode::FORBIDDEN && reply.body["error"].as_str() == Some(STEP_UP_REQUIRED)
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
    if is_step_up_refusal(reply) {
        // The Host's hint names what to present; never the credential.
        let hint = reply.body["hint"].as_str().unwrap_or_default();
        return format!(
            "Host API 403 step_up_required: replacing the agent-hooks policy needs the operator \
             token or a fresh passkey step-up, not a session alone. Export \
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

/// The document to send: a file read and checked, or a preset's policy.
fn replacement(file: Option<&Path>, preset: Option<&str>) -> Result<String> {
    match (file, preset) {
        (Some(file), None) => {
            let text = std::fs::read_to_string(file)
                .with_context(|| format!("reading hook policy {}", file.display()))?;
            HookPolicy::parse(&text).with_context(|| format!("hook policy {}", file.display()))?;
            Ok(text)
        }
        (None, Some(name)) => Ok(serde_json::to_string(&presets::get(name)?.policy)?),
        // clap makes exactly one of them required.
        _ => bail!("name a policy FILE or --preset NAME, not both"),
    }
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
        PolicyCmd::Preset { cmd } => presets::run(&cmd),
        PolicyCmd::Put {
            file,
            preset,
            if_version,
        } => {
            let text = replacement(file.as_deref(), preset.as_deref())?;
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

    #[test]
    fn a_missing_step_up_names_the_remedy() {
        let reply = Reply {
            status: StatusCode::FORBIDDEN,
            body: json!({
                "error": "step_up_required",
                "reason": "no_step_up",
                "hint": "to replace the agent-hooks policy this session needs a step-up",
            }),
        };
        let said = failure(&reply, Some(0));
        assert!(said.contains("step_up_required"), "{said}");
        assert!(said.contains("OPENSESAME_OPERATOR_TOKEN"), "{said}");
        assert!(said.contains("passkey"), "{said}");
        assert!(
            said.contains("needs a step-up"),
            "the Host's own hint rides along: {said}"
        );
        // A plain role refusal is not a step-up.
        let role = Reply {
            status: StatusCode::FORBIDDEN,
            body: json!({"error": "forbidden", "hint": "owner or admin role required"}),
        };
        assert_eq!(
            failure(&role, None),
            "Host API 403 Forbidden: owner or admin role required"
        );
    }

    #[test]
    fn a_preset_is_what_put_sends_and_a_file_is_checked_first() {
        let sent = replacement(None, Some("strict")).unwrap();
        let policy = HookPolicy::parse(&sent).unwrap();
        assert_eq!(policy, presets::get("strict").unwrap().policy);
        assert!(replacement(None, Some("no-such")).is_err());
        assert!(replacement(None, None).is_err());
        assert!(replacement(Some(Path::new("p.json")), Some("strict")).is_err());
        let missing = replacement(Some(Path::new("/nonexistent/policy.json")), None);
        assert!(missing.is_err());
    }
}
