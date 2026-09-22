//! Provider-specific access-token identity probes (login / username).

use crate::config::BrokerConfig;
use crate::error::{BrokerError, Result};

pub(crate) async fn probe_access_token_account(
    http: &reqwest::Client,
    config: &BrokerConfig,
    provider_id: &str,
    token: &str,
) -> Result<Option<String>> {
    match provider_id {
        "github" => {
            let url = format!("{}/user", config.github_api_base());
            let res = http
                .get(&url)
                .header("Authorization", format!("Bearer {token}"))
                .header("Accept", "application/vnd.github+json")
                .header("User-Agent", "OpenSesame-Host/0.1")
                .header("X-GitHub-Api-Version", "2022-11-28")
                .send()
                .await
                .map_err(|e| BrokerError::ExchangeFailed(e.to_string()))?;
            let status = res.status();
            let text = res
                .text()
                .await
                .map_err(|e| BrokerError::ExchangeFailed(e.to_string()))?;
            if !(200..300).contains(&status.as_u16()) {
                let snippet: String = text.chars().take(160).collect();
                return Err(BrokerError::ExchangeFailed(format!(
                    "GitHub rejected the token ({status}): {snippet}"
                )));
            }
            let body: serde_json::Value = serde_json::from_str(&text)
                .map_err(|e| BrokerError::ExchangeFailed(e.to_string()))?;
            Ok(body
                .get("login")
                .and_then(|v| v.as_str())
                .map(std::string::ToString::to_string))
        }
        "gitlab" => {
            let res = http
                .get("https://gitlab.com/api/v4/user")
                .header("Authorization", format!("Bearer {token}"))
                .header("User-Agent", "OpenSesame-Host/0.1")
                .send()
                .await
                .map_err(|e| BrokerError::ExchangeFailed(e.to_string()))?;
            let status = res.status();
            let text = res
                .text()
                .await
                .map_err(|e| BrokerError::ExchangeFailed(e.to_string()))?;
            if !(200..300).contains(&status.as_u16()) {
                return Err(BrokerError::ExchangeFailed(format!(
                    "GitLab rejected the token ({status})"
                )));
            }
            let body: serde_json::Value = serde_json::from_str(&text)
                .map_err(|e| BrokerError::ExchangeFailed(e.to_string()))?;
            Ok(body
                .get("username")
                .and_then(|v| v.as_str())
                .map(std::string::ToString::to_string))
        }
        "bitbucket" => {
            let res = http
                .get("https://api.bitbucket.org/2.0/user")
                .header("Authorization", format!("Bearer {token}"))
                .header("User-Agent", "OpenSesame-Host/0.1")
                .send()
                .await
                .map_err(|e| BrokerError::ExchangeFailed(e.to_string()))?;
            let status = res.status();
            let text = res
                .text()
                .await
                .map_err(|e| BrokerError::ExchangeFailed(e.to_string()))?;
            if !(200..300).contains(&status.as_u16()) {
                return Err(BrokerError::ExchangeFailed(format!(
                    "Bitbucket rejected the token ({status})"
                )));
            }
            let body: serde_json::Value = serde_json::from_str(&text)
                .map_err(|e| BrokerError::ExchangeFailed(e.to_string()))?;
            Ok(body
                .get("username")
                .and_then(|v| v.as_str())
                .map(std::string::ToString::to_string))
        }
        "codeberg" => {
            // Forgejo/Gitea PATs use `Authorization: token …`; OAuth access
            // tokens also accept that form on Codeberg.
            let res = http
                .get("https://codeberg.org/api/v1/user")
                .header("Authorization", format!("token {token}"))
                .header("User-Agent", "OpenSesame-Host/0.1")
                .send()
                .await
                .map_err(|e| BrokerError::ExchangeFailed(e.to_string()))?;
            let status = res.status();
            let text = res
                .text()
                .await
                .map_err(|e| BrokerError::ExchangeFailed(e.to_string()))?;
            if !(200..300).contains(&status.as_u16()) {
                return Err(BrokerError::ExchangeFailed(format!(
                    "Codeberg rejected the token ({status})"
                )));
            }
            let body: serde_json::Value = serde_json::from_str(&text)
                .map_err(|e| BrokerError::ExchangeFailed(e.to_string()))?;
            Ok(body
                .get("login")
                .and_then(|v| v.as_str())
                .map(std::string::ToString::to_string))
        }
        "origin" => {
            // Installation tokens (oit_…) authenticate as Bearer against
            // the Origin REST API. Git HTTPS uses x-access-token separately.
            let res = http
                .get("https://api.cursor.com/v1/origin/rate_limit")
                .header("Authorization", format!("Bearer {token}"))
                .header("User-Agent", "OpenSesame-Host/0.1")
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
