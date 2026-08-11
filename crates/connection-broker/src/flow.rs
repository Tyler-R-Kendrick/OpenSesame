//! Authorization-code flow with PKCE S256 — always, including for confidential
//! clients (ADR 0032 §4).

use std::env;

use oauth2::{CsrfToken, PkceCodeChallenge};
use sha2::{Digest, Sha256};
use url::Url;

use crate::catalog::{AuthMethod, Provider, TokenAuth};
use crate::config::BrokerConfig;
use crate::error::{BrokerError, Result};
use crate::token::TokenResponse;

/// A `state` outlives a human deciding whether to consent, and no longer.
pub const STATE_TTL_SECONDS: i64 = 600;

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

pub const CHALLENGE_METHOD: &str = "S256";

impl Pkce {
    pub fn generate() -> Self {
        let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
        Self {
            verifier: verifier.secret().clone(),
            challenge: challenge.as_str().to_string(),
        }
    }

    /// The challenge a verifier must produce, per RFC 7636 §4.2. Computed here
    /// rather than through `oauth2`, whose constructor panics on a verifier of the
    /// wrong length — this is also used to check verifiers we did not generate.
    pub fn challenge_for(verifier: &str) -> String {
        use base64::Engine;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
    }
}

/// 32 bytes of CSPRNG output; a guessable `state` is a session-fixation hole.
pub fn new_state() -> String {
    CsrfToken::new_random_len(32).secret().clone()
}

/// Mirrors the gateway's production check rather than importing the binary crate.
pub fn is_production_env() -> bool {
    env::var("OPENSESAME_ENV").ok().as_deref() == Some("production")
        || env::var("NODE_ENV").ok().as_deref() == Some("production")
}

fn is_loopback(url: &Url) -> bool {
    matches!(
        url.host_str(),
        Some("127.0.0.1") | Some("localhost") | Some("::1")
    )
}

/// Tokens and codes only travel over TLS. Loopback is the single exception, and
/// only outside production, so the bundled mock authorization server works.
pub fn assert_transport_allowed(raw: &str) -> Result<Url> {
    let url = Url::parse(raw).map_err(|_| BrokerError::Invalid(format!("malformed url {raw}")))?;
    match url.scheme() {
        "https" => Ok(url),
        "http" if is_loopback(&url) && !is_production_env() => Ok(url),
        _ => Err(BrokerError::Invalid(format!(
            "{} endpoints must be https",
            url.scheme()
        ))),
    }
}

pub struct AuthorizeParams<'a> {
    pub client_id: &'a str,
    pub redirect_uri: &'a str,
    pub scopes: &'a [String],
    pub state: &'a str,
    pub code_challenge: &'a str,
}

pub fn build_authorize_url(
    provider: &Provider,
    config: &BrokerConfig,
    params: AuthorizeParams<'_>,
) -> Result<String> {
    let AuthMethod::OAuth2AuthCode {
        extra_authorize_params,
        ..
    } = provider.auth
    else {
        return Err(BrokerError::UnsupportedCredential(provider.id.to_string()));
    };
    let raw = config
        .authorize_url(provider)
        .ok_or_else(|| BrokerError::UnsupportedCredential(provider.id.to_string()))?;
    let mut url = assert_transport_allowed(&raw)?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("response_type", "code");
        q.append_pair("client_id", params.client_id);
        q.append_pair("redirect_uri", params.redirect_uri);
        q.append_pair("state", params.state);
        q.append_pair("code_challenge", params.code_challenge);
        q.append_pair("code_challenge_method", CHALLENGE_METHOD);
        if !params.scopes.is_empty() {
            q.append_pair("scope", &params.scopes.join(" "));
        }
        for (k, v) in extra_authorize_params {
            q.append_pair(k, v);
        }
    }
    Ok(url.to_string())
}

pub async fn exchange_code(
    http: &reqwest::Client,
    provider: &Provider,
    config: &BrokerConfig,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<TokenResponse> {
    let form = vec![
        ("grant_type".to_string(), "authorization_code".to_string()),
        ("code".to_string(), code.to_string()),
        ("redirect_uri".to_string(), redirect_uri.to_string()),
        ("code_verifier".to_string(), code_verifier.to_string()),
    ];
    post_token_endpoint(http, provider, config, form).await
}

/// POSTs to the provider's token endpoint honouring its client authentication.
/// The response body is never echoed into an error: on the success path it holds
/// the tokens themselves.
pub async fn post_token_endpoint(
    http: &reqwest::Client,
    provider: &Provider,
    config: &BrokerConfig,
    mut form: Vec<(String, String)>,
) -> Result<TokenResponse> {
    let AuthMethod::OAuth2AuthCode { token_auth, .. } = provider.auth else {
        return Err(BrokerError::UnsupportedCredential(provider.id.to_string()));
    };
    let raw = config
        .token_url(provider)
        .ok_or_else(|| BrokerError::UnsupportedCredential(provider.id.to_string()))?;
    let url = assert_transport_allowed(&raw)?;

    let provider_config = config.provider(provider.id);
    let missing = config.missing_config(provider);
    if !missing.is_empty() {
        return Err(BrokerError::ProviderUnconfigured {
            provider: provider.id.to_string(),
            missing,
        });
    }
    let (Some(client_id), Some(client_secret)) =
        (provider_config.client_id, provider_config.client_secret)
    else {
        return Err(BrokerError::ProviderUnconfigured {
            provider: provider.id.to_string(),
            missing: config.missing_config(provider),
        });
    };

    let mut request = http.post(url).header("Accept", "application/json");
    match token_auth {
        TokenAuth::ClientSecretBasic => {
            request = request.basic_auth(&client_id, Some(&client_secret));
            form.push(("client_id".to_string(), client_id));
        }
        TokenAuth::ClientSecretPost => {
            form.push(("client_id".to_string(), client_id));
            form.push(("client_secret".to_string(), client_secret));
        }
    }

    let response = request
        .form(&form)
        .send()
        .await
        .map_err(|e| BrokerError::ExchangeFailed(transport_detail(&e)))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| BrokerError::ExchangeFailed(transport_detail(&e)))?;

    if !status.is_success() {
        return Err(BrokerError::ExchangeFailed(format!(
            "provider returned {}{}",
            status.as_u16(),
            oauth_error_detail(&body)
                .map(|d| format!(" ({d})"))
                .unwrap_or_default()
        )));
    }
    serde_json::from_str::<TokenResponse>(&body).map_err(|_| {
        BrokerError::ExchangeFailed(
            oauth_error_detail(&body)
                .unwrap_or_else(|| "token response was not understood".to_string()),
        )
    })
}

/// Best-effort upstream revocation. A provider that refuses is recorded, not fatal:
/// the connection is revoked here either way.
pub async fn revoke_upstream(
    http: &reqwest::Client,
    provider: &Provider,
    config: &BrokerConfig,
    token: &str,
) -> Result<()> {
    let AuthMethod::OAuth2AuthCode {
        revoke_url: Some(revoke_url),
        token_auth,
        ..
    } = provider.auth
    else {
        return Err(BrokerError::UnsupportedCredential(provider.id.to_string()));
    };
    let url = assert_transport_allowed(revoke_url)?;
    let provider_config = config.provider(provider.id);
    let mut form = vec![("token".to_string(), token.to_string())];
    let mut request = http.post(url).header("Accept", "application/json");
    match (
        token_auth,
        provider_config.client_id,
        provider_config.client_secret,
    ) {
        (TokenAuth::ClientSecretBasic, Some(id), Some(secret)) => {
            request = request.basic_auth(id, Some(secret));
        }
        (TokenAuth::ClientSecretPost, Some(id), Some(secret)) => {
            form.push(("client_id".to_string(), id));
            form.push(("client_secret".to_string(), secret));
        }
        _ => {
            return Err(BrokerError::ProviderUnconfigured {
                provider: provider.id.to_string(),
                missing: config.missing_config(provider),
            })
        }
    }
    let response = request
        .form(&form)
        .send()
        .await
        .map_err(|e| BrokerError::ExchangeFailed(transport_detail(&e)))?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(BrokerError::ExchangeFailed(format!(
            "revocation returned {}",
            response.status().as_u16()
        )))
    }
}

/// reqwest's Display can carry the full URL including a query; keep it to the class.
fn transport_detail(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "provider timed out".into()
    } else if e.is_connect() {
        "provider unreachable".into()
    } else {
        "provider request failed".into()
    }
}

/// Only the RFC 6749 error fields are quotable; the rest of the body is not.
fn oauth_error_detail(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let code = value.get("error").and_then(|v| v.as_str())?;
    (code.len() <= 64
        && code
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "_.-".contains(character)))
    .then(|| code.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog;
    use crate::config::ProviderConfig;
    use base64::Engine;

    fn config() -> BrokerConfig {
        BrokerConfig::in_memory(Some([3u8; 32]), "http://127.0.0.1:8787").with_provider(
            "github",
            ProviderConfig {
                client_id: Some("client-id".into()),
                client_secret: Some("client-secret".into()),
                ..Default::default()
            },
        )
    }

    #[test]
    fn verifier_is_high_entropy_and_within_rfc_bounds() {
        let a = Pkce::generate();
        let b = Pkce::generate();
        assert_ne!(a.verifier, b.verifier);
        assert!(
            (43..=128).contains(&a.verifier.len()),
            "{}",
            a.verifier.len()
        );
        assert!(a
            .verifier
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-._~".contains(c)));
    }

    /// The challenge must be exactly base64url(sha256(verifier)), unpadded.
    #[test]
    fn challenge_is_s256_of_the_verifier() {
        let pkce = Pkce::generate();
        let expected = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(pkce.verifier.as_bytes()));
        assert_eq!(pkce.challenge, expected);
        assert_eq!(Pkce::challenge_for(&pkce.verifier), pkce.challenge);
        assert_ne!(Pkce::challenge_for("some-other-verifier"), pkce.challenge);
    }

    #[test]
    fn state_is_unguessable_and_unique() {
        let a = new_state();
        let b = new_state();
        assert_ne!(a, b);
        assert!(a.len() >= 43, "{}", a.len());
    }

    #[test]
    fn authorize_url_carries_the_whole_pkce_request() {
        let github = catalog::find("github").expect("github");
        let scopes = vec!["read:user".to_string(), "repo".to_string()];
        let url = build_authorize_url(
            github,
            &config(),
            AuthorizeParams {
                client_id: "client-id",
                redirect_uri: "http://127.0.0.1:8787/api/v1/oauth/callback/github",
                scopes: &scopes,
                state: "st-1",
                code_challenge: "chal",
            },
        )
        .unwrap();
        let parsed = Url::parse(&url).unwrap();
        let q: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["client_id"], "client-id");
        assert_eq!(q["state"], "st-1");
        assert_eq!(q["code_challenge"], "chal");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["scope"], "read:user repo");
        assert_eq!(
            q["redirect_uri"],
            "http://127.0.0.1:8787/api/v1/oauth/callback/github"
        );
    }

    #[test]
    fn google_asks_for_offline_consent() {
        let google = catalog::find("google").expect("google");
        let cfg = config().with_provider(
            "google",
            ProviderConfig {
                client_id: Some("id".into()),
                client_secret: Some("secret".into()),
                ..Default::default()
            },
        );
        let url = build_authorize_url(
            google,
            &cfg,
            AuthorizeParams {
                client_id: "id",
                redirect_uri: "https://app.example/cb",
                scopes: &[],
                state: "s",
                code_challenge: "c",
            },
        )
        .unwrap();
        assert!(url.contains("access_type=offline"));
        assert!(url.contains("prompt=consent"));
        assert!(!url.contains("scope="));
    }

    #[test]
    fn api_key_providers_have_no_authorize_url() {
        let stripe = catalog::find("stripe").expect("stripe");
        let err = build_authorize_url(
            stripe,
            &config(),
            AuthorizeParams {
                client_id: "id",
                redirect_uri: "https://app.example/cb",
                scopes: &[],
                state: "s",
                code_challenge: "c",
            },
        )
        .unwrap_err();
        assert_eq!(err.code(), "unsupported_credential");
    }

    #[test]
    fn cleartext_is_refused_off_loopback() {
        assert!(assert_transport_allowed("https://example.com/token").is_ok());
        assert!(assert_transport_allowed("http://127.0.0.1:9090/token").is_ok());
        assert!(assert_transport_allowed("http://localhost:9090/token").is_ok());
        assert!(assert_transport_allowed("http://example.com/token").is_err());
        assert!(assert_transport_allowed("ftp://example.com/token").is_err());
        assert!(assert_transport_allowed("nonsense").is_err());
    }

    #[test]
    fn error_detail_quotes_only_the_oauth_fields() {
        assert_eq!(
            oauth_error_detail(r#"{"error":"invalid_grant","error_description":"expired"}"#),
            Some("invalid_grant".to_string())
        );
        assert_eq!(
            oauth_error_detail(r#"{"error":"invalid_grant"}"#),
            Some("invalid_grant".to_string())
        );
        assert_eq!(oauth_error_detail(r#"{"access_token":"secret-abc"}"#), None);
        assert_eq!(
            oauth_error_detail(
                r#"{"error":"invalid_grant","error_description":"access_token=secret-abc"}"#
            ),
            Some("invalid_grant".to_string())
        );
        assert_eq!(oauth_error_detail(r#"{"error":"secret abc"}"#), None);
        assert_eq!(oauth_error_detail("not json"), None);
    }
}
