//! Provider-specific access-token identity probes (login / username).

use crate::config::BrokerConfig;
use crate::error::{BrokerError, Result};

const USER_AGENT: &str = "OpenSesame-Host/0.1";

pub(crate) async fn probe_access_token_account(
    http: &reqwest::Client,
    config: &BrokerConfig,
    provider_id: &str,
    token: &str,
) -> Result<Option<String>> {
    let bearer = format!("Bearer {token}");
    match provider_id {
        "github" => {
            let url = format!("{}/user", config.github_api_base());
            let request = http
                .get(&url)
                .header("Authorization", bearer)
                .header("Accept", "application/vnd.github+json")
                .header("User-Agent", USER_AGENT)
                .header("X-GitHub-Api-Version", "2022-11-28");
            account_field(request, "GitHub", "login", true).await
        }
        "gitlab" => {
            let request = http
                .get("https://gitlab.com/api/v4/user")
                .header("Authorization", bearer)
                .header("User-Agent", USER_AGENT);
            account_field(request, "GitLab", "username", false).await
        }
        "bitbucket" => {
            let request = http
                .get("https://api.bitbucket.org/2.0/user")
                .header("Authorization", bearer)
                .header("User-Agent", USER_AGENT);
            account_field(request, "Bitbucket", "username", false).await
        }
        "codeberg" => {
            // Forgejo/Gitea PATs use `Authorization: token …`; OAuth access
            // tokens also accept that form on Codeberg.
            let request = http
                .get("https://codeberg.org/api/v1/user")
                .header("Authorization", format!("token {token}"))
                .header("User-Agent", USER_AGENT);
            account_field(request, "Codeberg", "login", false).await
        }
        "origin" => {
            // Installation tokens (oit_…) authenticate as Bearer against
            // the Origin REST API. Git HTTPS uses x-access-token separately.
            let res = http
                .get("https://api.cursor.com/v1/origin/rate_limit")
                .header("Authorization", bearer)
                .header("User-Agent", USER_AGENT)
                .send()
                .await
                .map_err(|e| BrokerError::ExchangeFailed(e.to_string()))?;
            let status = res.status();
            if !(200..300).contains(&status.as_u16()) {
                return Err(BrokerError::ExchangeFailed(format!(
                    "Cursor Origin rejected the token ({status})"
                )));
            }
            Ok(Some("origin".to_string()))
        }
        _ => Ok(None),
    }
}

/// Send a forge's "who am I" request and read one string `field` from the
/// JSON it answers with. `show_body` appends the start of a refusal's body
/// to the error, for the forge whose refusals say why.
async fn account_field(
    request: reqwest::RequestBuilder,
    forge: &str,
    field: &str,
    show_body: bool,
) -> Result<Option<String>> {
    let res = request
        .send()
        .await
        .map_err(|e| BrokerError::ExchangeFailed(e.to_string()))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| BrokerError::ExchangeFailed(e.to_string()))?;
    if !(200..300).contains(&status.as_u16()) {
        let detail = if show_body {
            let snippet: String = text.chars().take(160).collect();
            format!(": {snippet}")
        } else {
            String::new()
        };
        return Err(BrokerError::ExchangeFailed(format!(
            "{forge} rejected the token ({status}){detail}"
        )));
    }
    let body: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| BrokerError::ExchangeFailed(e.to_string()))?;
    Ok(body
        .get(field)
        .and_then(|v| v.as_str())
        .map(std::string::ToString::to_string))
}
