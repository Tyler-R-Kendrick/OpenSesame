//! `opensesame daemon fill approve | revoke | pairings`: the person's half of
//! the companion autofill extension's pairing ceremony (ADR 0052 §2 (b),
//! ADR 0150 §6.4). The companion's popup shows a code; a person at this
//! computer approves exactly that code here, with the operator credential.
//! Operator verbs against a loopback daemon only.
//!
//! The daemon answers these routes only while the optional `browser-autofill`
//! plugin is installed and switched on (ADR 0150 §7); otherwise it answers
//! like a path it never served, and this says which switch to look at.
use clap::Subcommand;
use serde_json::{json, Value};

#[derive(Subcommand, Debug)]
pub enum FillCmd {
    /// Approve the pairing code the companion extension's popup shows.
    Approve {
        /// The code, as shown (`ABCD-EFGH`); case and the dash do not matter.
        code: String,
    },
    /// Forget one paired extension by its origin (`chrome-extension://…`).
    Revoke { origin: String },
    /// List paired extensions and codes waiting for approval — never tokens.
    Pairings,
}

fn operator(req: reqwest::RequestBuilder, token: Option<&str>) -> reqwest::RequestBuilder {
    match token {
        Some(t) if !t.is_empty() => req.header("x-opensesame-operator", t),
        _ => req,
    }
}

/// What to tell a person about a refusal. A bare 404 is the daemon's answer
/// for a plugin that is not on: it has no fill routes to speak of.
fn refusal(what: &str, status: reqwest::StatusCode, body: &str) -> String {
    if status == reqwest::StatusCode::NOT_FOUND && body.trim().is_empty() {
        return format!(
            "{what} failed — the browser-autofill plugin is not on for this daemon \
             (`opensesame plugins enable browser-autofill`)"
        );
    }
    format!("{what} failed ({status}): {body}")
}

async fn send(req: reqwest::RequestBuilder, what: &str) -> anyhow::Result<Value> {
    let response = req
        .send()
        .await
        .map_err(|error| anyhow::anyhow!("{what} failed — daemon unreachable: {error}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    anyhow::ensure!(status.is_success(), "{}", refusal(what, status, &text));
    Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
}

/// Run one fill-pairing verb against the loopback daemon at `base`.
pub async fn run(base: &str, token: Option<&str>, cmd: FillCmd) -> anyhow::Result<()> {
    anyhow::ensure!(
        opensesame_host_core::daemon::base_url_is_local(base),
        "daemon URL `{base}` is not loopback; operator token stays on this machine"
    );
    let client = reqwest::Client::new();
    match cmd {
        FillCmd::Approve { code } => {
            let url = format!("{base}/v1/fill/pair/approve");
            let body = json!({ "code": code });
            let paired = send(operator(client.post(url).json(&body), token), "approve").await?;
            println!("paired {}", paired["origin"].as_str().unwrap_or_default());
        }
        FillCmd::Revoke { origin } => {
            let url = format!("{base}/v1/fill/pair/revoke");
            let body = json!({ "origin": origin });
            let revoked = send(operator(client.post(url).json(&body), token), "revoke").await?;
            let word = if revoked["revoked"] == Value::Bool(true) {
                "revoked"
            } else {
                "not paired"
            };
            println!("{word} {origin}");
        }
        FillCmd::Pairings => {
            let url = format!("{base}/v1/fill/pairings");
            let listed = send(operator(client.get(url), token), "list").await?;
            println!("{}", serde_json::to_string_pretty(&listed)?);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_remote_daemon_never_gets_the_operator_token() {
        for cmd in [
            FillCmd::Approve {
                code: "ABCD-EFGH".into(),
            },
            FillCmd::Pairings,
        ] {
            let error = run("https://evil.example", Some("t"), cmd)
                .await
                .unwrap_err();
            assert!(error.to_string().contains("not loopback"));
        }
    }

    #[test]
    fn a_bare_404_names_the_plugin_switch() {
        let said = refusal("approve", reqwest::StatusCode::NOT_FOUND, "");
        assert!(said.contains("opensesame plugins enable browser-autofill"));
        let said = refusal(
            "approve",
            reqwest::StatusCode::NOT_FOUND,
            r#"{"error":"unknown_code"}"#,
        );
        assert!(said.contains("unknown_code"));
        assert!(!said.contains("plugins enable"));
    }
}
