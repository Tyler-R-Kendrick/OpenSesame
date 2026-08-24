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

/// Characters of an upstream error body kept for diagnostics. A provider error
/// page is not worth holding in full, and the cap keeps a hostile upstream from
/// deciding how much of our memory its message occupies.
const MAX_ERROR_SNIPPET: usize = 512;

/// Headers the broker owns on a credentialed upload. A caller supplying any of
/// these would be competing with the injected credential or the framing of the
/// body, so they are refused rather than appended alongside.
const RESERVED_HEADERS: &[&str] = &[
    "authorization",
    "proxy-authorization",
    "content-type",
    "content-length",
    "host",
    "transfer-encoding",
];

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
    /// GET <https://api.github.com/user/repos> (authenticated).
    /// Prefer repositories the user owns so History can pick a personal password store.
    ///
    /// # Errors
    ///
    /// Returns an error when authorization, egress, upstream, or response validation fails.
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

    /// POST <https://api.github.com/user/repos> — **private by default**.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid name or failed authorized upstream request.
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
    ///
    /// # Errors
    ///
    /// Returns an error when connection state, egress, credential opening, or
    /// the upstream request fails.
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
        let tokens = Self::open_tokens(&key, &row, &credential)?;
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

    /// POST raw bytes to a provider with the connection's credential injected.
    ///
    /// The sibling of [`Self::authorized_json`] for the one case where the body
    /// is ciphertext rather than JSON: attachment replication (ADR 0054). The
    /// same status and egress-allowlist checks apply, because the caller
    /// supplies the URL and must not be able to aim a credentialed request at
    /// an origin the connection never authorized.
    ///
    /// Three things are deliberate. Redirects are not followed — a redirect
    /// would replay the bearer token at an unapproved origin. The response body
    /// is read only up to a cap, since a provider error page is not something
    /// we need in full. And no part of the credential is ever returned or
    /// logged: on failure the caller learns the status and a short snippet.
    pub async fn authorized_bytes(
        &self,
        organization_id: &OrganizationId,
        connection_id: &str,
        url: &str,
        extra_headers: &[(String, String)],
        body: Vec<u8>,
    ) -> Result<()> {
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

        let mut req = self
            .http_bytes
            .post(url)
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .header("Content-Type", "application/octet-stream")
            .header("User-Agent", "OpenSesame-Host/0.1");
        for (name, value) in extra_headers {
            // Headers are appended, not set, so a caller passing `Authorization`
            // would add a second one beside ours rather than replace it —
            // leaving which credential the provider honours up to the provider.
            // Today there is one caller passing one constant name; this is here
            // so that stays safe when there are more.
            if RESERVED_HEADERS
                .iter()
                .any(|reserved| name.eq_ignore_ascii_case(reserved))
            {
                return Err(BrokerError::Invalid(format!(
                    "caller may not set the {name} header on a credentialed upload"
                )));
            }
            req = req.header(name.as_str(), value.as_str());
        }

        let response = req
            .body(body)
            .send()
            .await
            .map_err(|e| BrokerError::ExchangeFailed(e.to_string()))?;
        let status = response.status();
        if status.is_redirection() {
            // Following this would hand the bearer token to wherever the
            // provider points, which the allowlist never vetted.
            return Err(BrokerError::ExchangeFailed(format!(
                "upstream {status}: refusing to follow a redirect on a credentialed upload"
            )));
        }
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            let snippet: String = text.chars().take(MAX_ERROR_SNIPPET).collect();
            return Err(BrokerError::ExchangeFailed(format!(
                "upstream {status}: {snippet}"
            )));
        }
        Ok(())
    }

    async fn http_authorized(
        &self,
        tokens: &TokenSet,
        method: &str,
        url: &str,
        body: Option<Value>,
    ) -> std::result::Result<Value, String> {
        let parsed_method = method
            .parse::<reqwest::Method>()
            .map_err(|_| format!("unsupported method {method}"))?;
        let mut request = self
            .http
            .request(parsed_method, url)
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "OpenSesame-Host/0.1")
            .header("X-GitHub-Api-Version", "2022-11-28");
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|e| e.to_string())?;
        let status = response.status();
        let text = response.text().await.map_err(|e| e.to_string())?;
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
        assert!(repo.clone_url.to_ascii_lowercase().ends_with(".git"));
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

#[cfg(test)]
mod reserved_header_tests {
    use super::RESERVED_HEADERS;

    #[test]
    fn reserved_headers_cover_what_the_broker_owns() {
        // The credential header above all: a caller adding its own would leave
        // the provider to choose between two Authorization values.
        for owned in ["authorization", "content-type", "content-length", "host"] {
            assert!(
                RESERVED_HEADERS.contains(&owned),
                "{owned} is set by the broker and must not be caller-supplied"
            );
        }
        // Matching is case-insensitive at the call site, so the table itself
        // must stay lowercase for that comparison to mean anything.
        for name in RESERVED_HEADERS {
            assert_eq!(*name, name.to_ascii_lowercase());
        }
        // The one header the only caller legitimately passes is not reserved.
        assert!(!RESERVED_HEADERS
            .iter()
            .any(|r| r.eq_ignore_ascii_case("Dropbox-API-Arg")));
    }
}
