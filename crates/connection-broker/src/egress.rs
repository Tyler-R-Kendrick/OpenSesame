//! Host-mediated provider egress — inject sealed credentials, never return them.
//!
//! Used by capability setup (e.g. GitHub private password-store repos) so Pages
//! can list/create remotes after OAuth without seeing access tokens (ADR 0005/0032).

use opensesame_domain::OrganizationId;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{BrokerError, Result};
use crate::model::ConnectionStatus;
use crate::store;
use crate::token::TokenSet;
use crate::ConnectionBroker;

#[derive(Debug, Clone)]
pub struct GithubRepo {
    pub full_name: String,
    pub name: String,
    pub private: bool,
    pub clone_url: String,
    pub html_url: String,
    pub default_branch: String,
}

impl ConnectionBroker {
    /// GET https://api.github.com/user/repos (authenticated).
    /// Prefer repositories the user owns so History can pick a personal password store.
    pub async fn list_github_repos(
        &self,
        organization_id: &OrganizationId,
        connection_id: &str,
    ) -> Result<Vec<GithubRepo>> {
        let body = self
            .authorized_json(
                organization_id,
                connection_id,
                "GET",
                "https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator",
                None,
            )
            .await?;
        parse_github_repo_list(&body)
    }

    /// POST https://api.github.com/user/repos — **private by default**.
    pub async fn create_github_repo(
        &self,
        organization_id: &OrganizationId,
        connection_id: &str,
        name: &str,
        private: bool,
        description: Option<&str>,
    ) -> Result<GithubRepo> {
        let name = name.trim();
        if name.is_empty()
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
            || name.len() > 100
        {
            return Err(BrokerError::Invalid(
                "repository name must be 1–100 chars of [A-Za-z0-9._-]".into(),
            ));
        }
        let mut payload = json!({
            "name": name,
            "private": private,
            "auto_init": true,
        });
        if let Some(description) = description.map(str::trim).filter(|s| !s.is_empty()) {
            payload["description"] = json!(description);
        }
        let body = self
            .authorized_json(
                organization_id,
                connection_id,
                "POST",
                "https://api.github.com/user/repos",
                Some(payload),
            )
            .await
            .map_err(map_github_repo_create_error)?;
        parse_github_repo(&body)
    }

    /// Perform an egress-constrained HTTP call with the connection's sealed
    /// bearer token. Response JSON is returned to the caller; tokens are not.
    pub async fn authorized_json(
        &self,
        organization_id: &OrganizationId,
        connection_id: &str,
        method: &str,
        url: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        let row = self.row_in_org(organization_id, connection_id).await?;
        if row.status == ConnectionStatus::Revoked {
            return Err(BrokerError::Invalid("connection is revoked".into()));
        }
        if row.status != ConnectionStatus::Active {
            return Err(BrokerError::NeedsReauth(format!(
                "connection status is {}",
                row.status.as_str()
            )));
        }
        row.egress
            .allows_url(url)
            .map_err(|e| BrokerError::Invalid(e.to_string()))?;

        let key = *self.sealing_key()?;
        let credential = store::get_credential(&self.pool, &row.id)
            .await?
            .ok_or_else(|| BrokerError::NeedsReauth("connection has no credential".into()))?;
        let tokens = self.open_tokens(&key, &row, &credential)?;
        if tokens.access_token.is_empty() {
            return Err(BrokerError::NeedsReauth("access token missing".into()));
        }

        let response = self
            .http_authorized(&tokens, method, url, body)
            .await
            .map_err(BrokerError::ExchangeFailed)?;

        // Never echo Authorization headers or token fields from upstream.
        Ok(response)
    }

    async fn http_authorized(
        &self,
        tokens: &TokenSet,
        method: &str,
        url: &str,
        body: Option<Value>,
    ) -> std::result::Result<Value, String> {
        let method = method
            .parse::<reqwest::Method>()
            .map_err(|_| format!("unsupported method {method}"))?;
        let mut req = self
            .http
            .request(method, url)
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "OpenSesame-Host/0.1")
            .header("X-GitHub-Api-Version", "2022-11-28");
        if let Some(body) = body {
            req = req.json(&body);
        }
        let res = req.send().await.map_err(|e| e.to_string())?;
        let status = res.status();
        let text = res.text().await.map_err(|e| e.to_string())?;
        if !(200..300).contains(&status.as_u16()) {
            let snippet: String = text.chars().take(240).collect();
            return Err(format!("upstream {status}: {snippet}"));
        }
        if text.trim().is_empty() {
            return Ok(json!({}));
        }
        serde_json::from_str(&text).map_err(|e| e.to_string())
    }
}

#[derive(Deserialize)]
struct GhRepoWire {
    name: String,
    full_name: String,
    private: bool,
    clone_url: String,
    html_url: String,
    #[serde(default)]
    default_branch: String,
}

fn parse_github_repo(value: &Value) -> Result<GithubRepo> {
    let wire: GhRepoWire = serde_json::from_value(value.clone()).map_err(BrokerError::from)?;
    Ok(GithubRepo {
        full_name: wire.full_name,
        name: wire.name,
        private: wire.private,
        clone_url: wire.clone_url,
        html_url: wire.html_url,
        default_branch: if wire.default_branch.is_empty() {
            "main".into()
        } else {
            wire.default_branch
        },
    })
}

fn parse_github_repo_list(value: &Value) -> Result<Vec<GithubRepo>> {
    let arr = value
        .as_array()
        .ok_or_else(|| BrokerError::Invalid("expected GitHub repo array".into()))?;
    arr.iter().map(parse_github_repo).collect()
}

fn map_github_repo_create_error(error: BrokerError) -> BrokerError {
    let BrokerError::ExchangeFailed(detail) = &error else {
        return error;
    };
    if detail.contains("Resource not accessible by integration") {
        return BrokerError::Invalid(
            "GitHub refused to create the repository for this connection. \
             Install the tenant GitHub App on your account (All repositories; \
             Administration + Contents), then Re-authorize in Settings, \
             or connect with a personal access token that has the repo scope, \
             or pick an existing private repo from the list."
                .into(),
        );
    }
    error
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_private_repo() {
        let v = json!({
            "name": "opensesame-passwords",
            "full_name": "alice/opensesame-passwords",
            "private": true,
            "clone_url": "https://github.com/alice/opensesame-passwords.git",
            "html_url": "https://github.com/alice/opensesame-passwords",
            "default_branch": "main"
        });
        let repo = parse_github_repo(&v).unwrap();
        assert!(repo.private);
        assert_eq!(repo.name, "opensesame-passwords");
        assert!(repo.clone_url.ends_with(".git"));
    }

    #[test]
    fn maps_integration_forbidden_to_actionable_hint() {
        let mapped = map_github_repo_create_error(BrokerError::ExchangeFailed(
            "upstream 403 Forbidden: {\"message\":\"Resource not accessible by integration\"}"
                .into(),
        ));
        assert_eq!(mapped.code(), "invalid_request");
        assert!(mapped.hint().contains("Install the tenant GitHub App"));
        assert!(mapped.hint().contains("Re-authorize"));
    }
}
