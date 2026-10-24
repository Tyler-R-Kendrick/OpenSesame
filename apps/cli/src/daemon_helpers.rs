//! `opensesame daemon helpers allow | revoke | list`: which connections the
//! credential helpers may mint on the daemon's Unix socket with no operator
//! token (ADR 0138 §2, as amended). The list starts empty; every verb here
//! needs the operator token, against a loopback daemon only.
use clap::Subcommand;
use serde_json::Value;

#[derive(Subcommand, Debug)]
pub enum HelpersCmd {
    /// Let the credential helpers mint this connection on the daemon's socket.
    /// Any process running as an allowed user can then mint it there.
    Allow { connection: String },
    /// Stop the credential helpers minting this connection.
    Revoke { connection: String },
    /// List the connections the credential helpers may mint.
    List,
}

fn operator(req: reqwest::RequestBuilder, token: Option<&str>) -> reqwest::RequestBuilder {
    match token {
        Some(t) if !t.is_empty() => req.header("x-opensesame-operator", t),
        _ => req,
    }
}

async fn send(req: reqwest::RequestBuilder, what: &str) -> anyhow::Result<Value> {
    let response = req
        .send()
        .await
        .map_err(|error| anyhow::anyhow!("{what} failed — daemon unreachable: {error}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    anyhow::ensure!(status.is_success(), "{what} failed ({status}): {text}");
    Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
}

/// Run one allowlist verb against the loopback daemon at `base`.
pub async fn run(base: &str, token: Option<&str>, cmd: HelpersCmd) -> anyhow::Result<()> {
    anyhow::ensure!(
        opensesame_host_core::daemon::base_url_is_local(base),
        "daemon URL `{base}` is not loopback; operator token stays on this machine"
    );
    let client = reqwest::Client::new();
    match cmd {
        HelpersCmd::Allow { connection } => {
            let url = format!("{base}/v1/helper-mints/{connection}");
            send(operator(client.put(url), token), "allow").await?;
            println!("helpers may mint {connection}");
        }
        HelpersCmd::Revoke { connection } => {
            let url = format!("{base}/v1/helper-mints/{connection}");
            send(operator(client.delete(url), token), "revoke").await?;
            println!("helpers may no longer mint {connection}");
        }
        HelpersCmd::List => {
            let url = format!("{base}/v1/helper-mints");
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
            HelpersCmd::Allow {
                connection: "conn_stub".into(),
            },
            HelpersCmd::List,
        ] {
            let error = run("https://evil.example", Some("t"), cmd)
                .await
                .unwrap_err();
            assert!(error.to_string().contains("not loopback"));
        }
    }
}
