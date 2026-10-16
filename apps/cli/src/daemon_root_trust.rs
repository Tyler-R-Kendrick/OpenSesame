//! `opensesame daemon root-trust enroll` — host entry for D7-2 U3 PAKE enrollment.

use base64::Engine as _;
use opensesame_cli_app_integration::{
    generate_root_signing_key, root_spki_der, RootEnrollClient, ROOT_ENROLL_BEGIN_PATH,
    ROOT_ENROLL_FINISH_PATH,
};
use serde::Deserialize;
use serde_json::json;

use crate::daemon_toolbar;
use crate::enroll_entry::confirm_enrollment;

/// Enroll the daemon CLI root trust key (operator + PAKE + OS secure prompt).
pub async fn run(base: &str, operator: Option<&str>) -> anyhow::Result<()> {
    let base = base.trim_end_matches('/');
    daemon_toolbar::assert_daemon_url_allowed(base).map_err(anyhow::Error::msg)?;
    let token = operator.filter(|t| !t.is_empty()).ok_or_else(|| {
        anyhow::anyhow!("OPENSESAME_OPERATOR_TOKEN is required to enroll CLI root trust")
    })?;
    let entry = confirm_enrollment()?;
    let client = reqwest::Client::new();
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
    let begin_body: BeginBody = begin.json().await?;
    let secret = decode_b64(&begin_body.enrollment_secret_b64)?;
    let daemon_message = decode_b64(&begin_body.message_b64)?;
    let signing = generate_root_signing_key();
    let spki = root_spki_der(&signing);
    let enroll_client = RootEnrollClient::start(&secret)?;
    let confirm = enroll_client.confirm(&daemon_message, &spki)?;
    let finish_body = json!({
        "sessionId": begin_body.session_id,
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
    println!(
        "CLI root trust enrolled (epoch {}, fingerprint {}).",
        finished.enrollment_epoch, finished.spki_fingerprint
    );
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BeginBody {
    session_id: String,
    enrollment_secret_b64: String,
    message_b64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinishBody {
    spki_fingerprint: String,
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
