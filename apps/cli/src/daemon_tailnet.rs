//! `opensesame daemon tailnet …`: the terminal side of tailnet device
//! management (ADR 0169).
//!
//! `connect` records which tailnet the daemon manages and the credential that
//! manages it, read from a file or stdin, never the command line. `pair`
//! prints a one-time code (and a link and QR) a page at one origin trades for
//! a bearer with one role. The device verbs do from a terminal what the page
//! does, through the same operations and the same audit trail. Nothing here
//! talks to a running daemon: it shares the daemon's state directory, so a
//! change takes effect whether or not the daemon is up.

use std::io::Read as _;
use std::path::PathBuf;

use clap::Subcommand;
use opensesame_plugin_settings::{is_pairable_origin, unix_now};
use opensesame_tailnet_admin::{
    default_admin_dir, format_pairing_code, AdminError, AdminStore, Credential, CredentialKind,
    Role,
};
use secrecy::SecretString;
use serde_json::{json, Value};

use crate::plugins::plugins_pair::{is_daemon_url, DEFAULT_DAEMON_URL};

#[path = "daemon_tailnet_devices.rs"]
mod devices;
pub use devices::DeviceCmd;

const DEFAULT_PAGES_URL: &str = "https://tyler-r-kendrick.github.io/OpenSesame/";

#[derive(Subcommand, Debug)]
pub enum TailnetCmd {
    /// Record which tailnet this daemon manages and the credential it uses.
    /// The secret is read from `--secret-file`, else one line of stdin.
    Connect {
        /// The tailnet id; `-` is the credential's own tailnet.
        #[arg(long, default_value = "-")]
        tailnet: String,
        /// An OAuth client id (`tskey-client-…` secret). Preferred: scoped,
        /// never expires on its own.
        #[arg(long, required_unless_present = "api_token")]
        oauth_client_id: Option<String>,
        /// Use an API access token (`tskey-api-…`) instead of an OAuth client.
        #[arg(long, conflicts_with = "oauth_client_id")]
        api_token: bool,
        #[arg(long)]
        secret_file: Option<PathBuf>,
    },
    /// Forget the tailnet and delete the credential.
    Disconnect,
    /// Which tailnet, which kind of credential, and the pages paired.
    Status,
    /// Let one browser origin manage devices: prints a one-time code, good for
    /// five minutes, that the page at that origin trades for a bearer.
    Pair {
        /// The page's exact origin: `https://host[:port]`.
        #[arg(long)]
        origin: String,
        /// `read` (devices, keys, audit) or `manage` (every change too).
        #[arg(long, value_parser = ["read", "manage"])]
        role: String,
        /// Where that page reaches this daemon: its Tailscale Serve URL.
        #[arg(long, default_value = DEFAULT_DAEMON_URL)]
        url: String,
        /// What the page calls this daemon.
        #[arg(long, default_value = "OpenSesame daemon")]
        label: String,
        /// The web app the pairing link opens.
        #[arg(long, env = "OPENSESAME_PAGES_URL", default_value = DEFAULT_PAGES_URL)]
        pages_url: String,
        /// Print the code and link only, no QR.
        #[arg(long)]
        no_qr: bool,
    },
    /// Revoke what pages hold: one pairing, one origin's, or all.
    Unpair {
        #[arg(long, conflicts_with_all = ["id", "all"])]
        origin: Option<String>,
        #[arg(long, conflicts_with = "all")]
        id: Option<String>,
        #[arg(long, required_unless_present_any = ["origin", "id"])]
        all: bool,
    },
    #[command(flatten)]
    Device(DeviceCmd),
}

/// The link a phone camera opens: Identity › Devices, with the code in the
/// fragment a browser never sends to the server hosting the app.
#[must_use]
pub fn pairing_link(pages_url: &str, code: &str) -> String {
    let base = pages_url.split('#').next().unwrap_or(pages_url);
    format!(
        "{}/identity?view=devices#pair-tailnet={code}",
        base.trim_end_matches('/')
    )
}

fn store() -> anyhow::Result<AdminStore> {
    Ok(AdminStore::at(default_admin_dir()?))
}

fn read_secret(file: Option<&PathBuf>) -> anyhow::Result<SecretString> {
    let mut text = zeroize::Zeroizing::new(String::new());
    match file {
        Some(path) => {
            *text = std::fs::read_to_string(path)?;
        }
        None => {
            std::io::stdin().take(4096).read_to_string(&mut text)?;
        }
    }
    let line = text.lines().next().unwrap_or_default().trim().to_string();
    anyhow::ensure!(!line.is_empty(), "no secret was given");
    Ok(SecretString::from(line))
}

fn connect(
    tailnet: &str,
    client_id: Option<String>,
    secret_file: Option<&PathBuf>,
) -> anyhow::Result<Value> {
    let credential = match client_id {
        Some(id) => Credential {
            kind: CredentialKind::Oauth,
            client_id: id,
        },
        None => Credential {
            kind: CredentialKind::ApiKey,
            client_id: String::new(),
        },
    };
    let secret = read_secret(secret_file)?;
    let config = store()?
        .connect(tailnet, credential, &secret, unix_now())
        .map_err(explain)?;
    Ok(
        json!({ "connected": true, "tailnet": config.tailnet, "credential": config.credential.kind }),
    )
}

fn status() -> anyhow::Result<Value> {
    let store = store()?;
    let mut value = opensesame_tailnet_admin::ops::status(&store)?;
    let (paired, pending) = store.pairings().list(unix_now())?;
    value["paired"] = json!(paired);
    value["pending"] = json!(pending);
    Ok(value)
}

struct PairRequest<'a> {
    origin: &'a str,
    role: &'a str,
    url: &'a str,
    label: &'a str,
    pages_url: &'a str,
    no_qr: bool,
}

fn pair(request: &PairRequest<'_>) -> anyhow::Result<()> {
    anyhow::ensure!(
        is_pairable_origin(request.origin),
        "--origin must be exactly what a browser sends: https://host[:port], no path"
    );
    anyhow::ensure!(
        is_daemon_url(request.url),
        "--url must be this machine or its tailnet address (https://<name>.ts.net)"
    );
    let role =
        Role::parse(request.role).ok_or_else(|| anyhow::anyhow!("--role is read or manage"))?;
    let (code, expires_at) = store()?
        .pairings()
        .issue(request.origin, role, request.label, unix_now())
        .map_err(explain)?;
    let url = request.url.trim_end_matches('/');
    let printed = format_pairing_code(url, &code, request.origin, role, request.label);
    let link = pairing_link(request.pages_url, &printed);
    println!("role   {}", role.as_str());
    println!("code   {printed}");
    println!("link   {link}");
    println!("until  {expires_at}");
    if !request.no_qr {
        qr2term::print_qr(&link)?;
    }
    eprintln!(
        "The code works once, from {} only, for five minutes; it is not shown again.",
        request.origin
    );
    Ok(())
}

/// A refusal in words a terminal can act on.
pub(crate) fn explain(error: AdminError) -> anyhow::Error {
    match error {
        AdminError::NotConnected => anyhow::anyhow!(
            "no tailnet is connected; run `opensesame daemon tailnet connect` first"
        ),
        AdminError::Full => anyhow::anyhow!(
            "too many pairings or codes waiting; run `opensesame daemon tailnet unpair`"
        ),
        other => {
            let detail = other.detail().map(|d| format!(": {d}")).unwrap_or_default();
            anyhow::anyhow!("{} ({}){detail}", other, other.code())
        }
    }
}

/// Run one tailnet verb.
pub async fn run(cmd: TailnetCmd) -> anyhow::Result<()> {
    let value = match cmd {
        TailnetCmd::Connect {
            tailnet,
            oauth_client_id,
            api_token: _,
            secret_file,
        } => connect(&tailnet, oauth_client_id, secret_file.as_ref())?,
        TailnetCmd::Disconnect => json!({ "disconnected": store()?.disconnect()? }),
        TailnetCmd::Status => status()?,
        TailnetCmd::Pair {
            origin,
            role,
            url,
            label,
            pages_url,
            no_qr,
        } => {
            return pair(&PairRequest {
                origin: &origin,
                role: &role,
                url: &url,
                label: &label,
                pages_url: &pages_url,
                no_qr,
            })
        }
        TailnetCmd::Unpair { origin, id, all: _ } => {
            let revoked =
                store()?
                    .pairings()
                    .unpair(origin.as_deref(), id.as_deref(), unix_now())?;
            json!({ "revoked": revoked })
        }
        TailnetCmd::Device(verb) => devices::run(&store()?, verb).await?,
    };
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_link_opens_identity_devices_with_the_code_in_the_fragment() {
        assert_eq!(
            pairing_link("https://example.test/app/#x", "opensesame-tailnet:v1:abc"),
            "https://example.test/app/identity?view=devices#pair-tailnet=opensesame-tailnet:v1:abc"
        );
    }

    #[test]
    fn a_secret_is_one_trimmed_line_of_a_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("s");
        std::fs::write(&path, "  tskey-api-abc-12345678  \nignored\n").unwrap();
        let secret = read_secret(Some(&path)).unwrap();
        assert_eq!(
            secrecy::ExposeSecret::expose_secret(&secret),
            "tskey-api-abc-12345678"
        );
        std::fs::write(&path, "\n").unwrap();
        assert!(read_secret(Some(&path)).is_err());
    }

    #[test]
    fn a_refusal_names_what_to_run() {
        let text = explain(AdminError::NotConnected).to_string();
        assert!(text.contains("tailnet connect"));
        let text = explain(AdminError::Rejected {
            message: "tag:x is not valid".into(),
        })
        .to_string();
        assert!(text.contains("tailscale_rejected") && text.contains("tag:x is not valid"));
    }
}
