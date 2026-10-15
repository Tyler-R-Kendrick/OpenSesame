//! `opensesame daemon root-trust enroll` — host entry for D7-2 U3 PAKE enrollment.

use base64::Engine as _;
use opensesame_cli_app_integration::{
    generate_root_signing_key, pin_matches, root_spki_der, sas_from_fingerprint, RootEnrollClient,
    ROOT_ENROLL_ARM_PATH, ROOT_ENROLL_BEGIN_PATH, ROOT_ENROLL_FINISH_PATH,
};
use serde::Deserialize;
use serde_json::json;

use crate::daemon_toolbar;
use crate::enroll_entry::{confirm_enrollment, EnrollEntryMethod};

/// Enroll the daemon CLI root trust key (operator + PAKE + OS secure prompt).
pub async fn run(base: &str, operator: Option<&str>) -> anyhow::Result<()> {
    let base = base.trim_end_matches('/');
    daemon_toolbar::assert_daemon_url_allowed(base).map_err(anyhow::Error::msg)?;
    let token = operator
        .filter(|t| !t.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "OPENSESAME_OPERATOR_TOKEN is required to enroll CLI root trust"
            )
        })?;
    let entry = confirm_enrollment()?;
    let client = reqwest::Client::new();
    let arm = client
        .post(format!("{base}{ROOT_ENROLL_ARM_PATH}"))
        .header("x-opensesame-operator", token)
        .body(String::new())
        .send()
        .await?;
    if !arm.status().is_success() {
        anyhow::bail!("root trust enroll arm refused ({})", arm.status());
    }
    let health = client.get(format!("{base}/health")).send().await?;
    if !health.status().is_success() {
        anyhow::bail!("daemon is not healthy at {base}");
    }
    let begin = client
        .post(format!("{base}{ROOT_ENROLL_BEGIN_PATH}"))
        .header("x-opensesame-operator", token)
        .body(String::new())
        .send()
        .await?;
    if begin.status() == reqwest::StatusCode::SERVICE_UNAVAILABLE {
        anyhow::bail!("daemon root trust store is not configured");
    }
    if !begin.status().is_success() {
        let status = begin.status();
        let body = begin.text().await.unwrap_or_default();
        anyhow::bail!("root trust enroll begin refused ({status}): {body}");
    }
    let begun: BeginBody = begin.json().await?;
    let enroll_pin = std::env::var("OPENSESAME_ENROLL_BINARY_SHA256").unwrap_or_default();
    if !enroll_pin.is_empty() && !pin_matches(&enroll_pin) {
        anyhow::bail!("enroll CLI binary identity does not match the pinned hash");
    }
    if let Some(ref daemon_hash) = begun.daemon_binary_sha256 {
        let expected = std::env::var("OPENSESAME_DAEMON_BINARY_SHA256").unwrap_or_default();
        if !expected.is_empty() && daemon_hash != &expected {
            anyhow::bail!("daemon binary identity does not match the pinned hash");
        }
    }
    let secret = decode_b64(&begun.enrollment_secret_b64)?;
    let daemon_message = decode_b64(&begun.message_b64)?;
    let signing = generate_root_signing_key();
    let spki = root_spki_der(&signing);
    let enroll_client = RootEnrollClient::start(&secret)?;
    let confirm = enroll_client.confirm(&daemon_message, &spki)?;
    let finish_body = json!({
        "sessionId": begun.session_id,
        "messageB64": b64(enroll_client.message()),
        "confirmB64": b64(confirm.client_confirm()),
        "rootPublicKeySpkiB64": b64(&spki),
    });
    let finish = client
        .post(format!("{base}{ROOT_ENROLL_FINISH_PATH}"))
        .header("content-type", "application/json")
        .header("x-opensesame-enroll-entry", entry.header_value())
        .json(&finish_body)
        .send()
        .await?;
    if !finish.status().is_success() {
        let status = finish.status();
        let body = finish.text().await.unwrap_or_default();
        anyhow::bail!("root trust enroll finish refused ({status}): {body}");
    }
    let finished: FinishBody = finish.json().await?;
    let daemon_confirm = decode_b64(&finished.confirm_b64)?;
    confirm.verify_daemon(&daemon_confirm)?;
    let sas = sas_from_fingerprint(&finished.spki_fingerprint)
        .unwrap_or_else(|| "????-????-????-????".into());
    println!(
        "CLI root trust enrolled (epoch {}, SAS {}, full fingerprint {}).",
        finished.enrollment_epoch,
        sas,
        finished.spki_fingerprint
    );
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BeginBody {
    session_id: String,
    enrollment_secret_b64: String,
    message_b64: String,
    daemon_binary_sha256: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinishBody {
    spki_fingerprint: String,
    spki_sas: Option<String>,
    enrollment_epoch: u64,
    confirm_b64: String,
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn decode_b64(value: &str) -> anyhow::Result<Vec<u8>> {
    let trimmed = value.trim();
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(trimmed)
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(trimmed))
        .map_err(|_| anyhow::anyhow!("invalid base64 from daemon"))
}
