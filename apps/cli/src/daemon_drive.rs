//! `opensesame daemon drive create | ls | rm`: open, list and close the slots
//! of this machine's tailnet vault drive (ADR 0143) — Enpass's Wi-Fi Sync
//! Server setup, over Tailscale. Operator verbs against a loopback daemon only.
use clap::Subcommand;
use serde_json::{json, Value};

/// Where the pairing link opens when a phone scans it.
const DEFAULT_PAGES_URL: &str = "https://tyler-r-kendrick.github.io/OpenSesame/";

#[derive(Subcommand, Debug)]
pub enum DriveCmd {
    /// Open a slot for one vault and print its pairing code, link and QR.
    Create {
        /// What to call the slot, shown to the device that pairs.
        #[arg(long, default_value = "OpenSesame vault")]
        label: String,
        /// Where devices reach this daemon. Defaults to its Tailscale Serve URL.
        #[arg(long)]
        url: Option<String>,
        /// The OpenSesame app the pairing link opens.
        #[arg(long, env = "OPENSESAME_PAGES_URL", default_value = DEFAULT_PAGES_URL)]
        pages_url: String,
        /// Print the code and link only, no QR.
        #[arg(long)]
        no_qr: bool,
    },
    /// List slots: label, generation and size — never keys or contents.
    Ls,
    /// Close a slot and discard its snapshot. Devices paired with it stop syncing.
    Rm { slot: String },
}

/// The link a phone camera can open, at Settings › Vaults where the pairing
/// panel reads it: the code rides in the fragment, which a browser never sends
/// to the server hosting the app.
pub fn pairing_link(pages_url: &str, code: &str) -> String {
    let base = pages_url.split('#').next().unwrap_or(pages_url);
    format!(
        "{}/settings/vaults#pair-drive={code}",
        base.trim_end_matches('/')
    )
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
    if status == reqwest::StatusCode::NO_CONTENT {
        return Ok(Value::Null);
    }
    let body: Value = response.json().await.unwrap_or(Value::Null);
    anyhow::ensure!(status.is_success(), "{what} failed ({status}): {body}");
    Ok(body)
}

/// Run one drive verb against the loopback daemon at `base`.
pub async fn run(base: &str, token: Option<&str>, cmd: DriveCmd) -> anyhow::Result<()> {
    anyhow::ensure!(
        opensesame_host_core::daemon::base_url_is_local(base),
        "daemon URL `{base}` is not loopback; operator token stays on this machine"
    );
    let client = reqwest::Client::new();
    let slots = format!("{base}/v1/vault-drive/slots");
    match cmd {
        DriveCmd::Create {
            label,
            url,
            pages_url,
            no_qr,
        } => {
            let body = json!({ "label": label, "url": url });
            let created = send(operator(client.post(&slots).json(&body), token), "create").await?;
            let code = created["pairing_code"].as_str().unwrap_or_default();
            let link = pairing_link(&pages_url, code);
            println!(
                "slot   {}",
                created["slot"]["slot"].as_str().unwrap_or_default()
            );
            println!("drive  {}", created["url"].as_str().unwrap_or_default());
            println!("code   {code}");
            println!("link   {link}");
            if !no_qr {
                qr2term::print_qr(&link)?;
            }
            eprintln!("The code is the slot's only key; it is not shown again.");
        }
        DriveCmd::Ls => {
            let listed = send(operator(client.get(&slots), token), "list").await?;
            println!("{}", serde_json::to_string_pretty(&listed["slots"])?);
        }
        DriveCmd::Rm { slot } => {
            let url = format!("{slots}/{slot}");
            send(operator(client.delete(url), token), "remove").await?;
            println!("closed {slot}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pairing_code_rides_in_the_fragment() {
        let link = pairing_link("https://example.test/app/", "opensesame-drive:v1:abc");
        assert_eq!(
            link,
            "https://example.test/app/settings/vaults#pair-drive=opensesame-drive:v1:abc"
        );
        assert_eq!(
            pairing_link("https://example.test/app#old", "c"),
            "https://example.test/app/settings/vaults#pair-drive=c"
        );
    }

    #[tokio::test]
    async fn a_remote_daemon_never_gets_the_operator_token() {
        let error = run("https://evil.example", Some("t"), DriveCmd::Ls)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("not loopback"));
    }
}
