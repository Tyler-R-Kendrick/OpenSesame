//! `OpenBao` TLS-certificate authentication (ADR 0130, CONN-OPENBAO /
//! CONN-TOKEN-LIFECYCLE).
//!
//! `POST /v1/auth/cert/login` with `{"name":"<role>"}` over a connection that
//! presented a client certificate. `OpenBao` matches the presented chain
//! against the CA certificate stored at `auth/cert/certs/<role>` and that
//! role's name constraints, and answers with `auth.client_token`,
//! `auth.policies` and `auth.lease_duration`
//! (<https://openbao.org/docs/auth/cert/>). The listener must be configured
//! with `tls_cert_file`, `tls_key_file`, `tls_client_ca_file` and
//! `tls_require_and_verify_client_cert = true`; a plaintext `-dev` server
//! cannot authenticate a certificate at all, so it is not a proof of this
//! path.
//!
//! ## Three things this module is careful about
//!
//! **The mode is explicit.** [`OpenBaoAuthMode`] is chosen by configuration.
//! A failed certificate login is an error; it never falls back to a static
//! token, and a deployment configured for `CertRole` with no usable identity
//! refuses rather than degrading (EXPLICIT-ENFORCEMENT).
//!
//! **The token is cached per identity, never globally.** The cache key is
//! `(role, identity generation, trust generation)`, where the identity
//! generation is the presented leaf's SHA-256 thumbprint. Two workloads with
//! two certificates therefore never share a token, and rotating a certificate
//! invalidates the cache entry rather than reusing a token minted under the
//! old key (CONN-TOKEN-LIFECYCLE: "no global refreshed token shared across
//! certificate identities").
//!
//! **Revoking the certificate does not revoke the token.** `OpenBao` issues a
//! token with its own `lease_duration`; revoking or expiring the client
//! certificate stops *future* logins and nothing else. The already-issued
//! token stays valid until its TTL runs out or it is explicitly revoked —
//! which is what [`OpenBaoCertAuth::revoke_token`] is for, and why it exists
//! as a separate operation instead of being implied (AT-OPENBAO-TOKEN).

use std::sync::Mutex;

use chrono::Utc;
use secrecy::{ExposeSecret, SecretString};
use serde_json::{json, Value};

pub use crate::cert_token::{parse_login, CertToken, CertTokenScope};
use crate::{assert_authority_base_url, AuthorityError};

/// The default mount path of the certificate auth method.
pub const DEFAULT_CERT_MOUNT: &str = "cert";

/// Largest login response body this adapter will read.
pub const MAX_LOGIN_BODY_BYTES: usize = 64 * 1024;

/// How this adapter authenticates to `OpenBao`. Explicit modes, never a
/// downgrade ladder: a `CertRole` deployment whose login fails gets an error.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OpenBaoAuthMode {
    /// An operator-configured token (the existing supported mode).
    Token,
    /// TLS client certificate against a named `cert` auth role.
    CertRole {
        /// The role name, exactly as `auth/cert/certs/<name>` spells it.
        role: String,
        /// The auth mount, `cert` unless the operator remounted it.
        mount: String,
    },
}

impl OpenBaoAuthMode {
    /// A cert-role mode on the default mount.
    ///
    /// # Errors
    ///
    /// `Provider` when the role name is empty, oversized, or contains
    /// anything but `[a-z0-9._-]` — a role is a name, never a path segment a
    /// caller can traverse out of.
    pub fn cert_role(role: &str) -> Result<Self, AuthorityError> {
        Self::cert_role_on(role, DEFAULT_CERT_MOUNT)
    }

    /// A cert-role mode on an explicit mount.
    ///
    /// # Errors
    ///
    /// As [`OpenBaoAuthMode::cert_role`], for either name.
    pub fn cert_role_on(role: &str, mount: &str) -> Result<Self, AuthorityError> {
        Ok(Self::CertRole {
            role: validated_name("role", role)?,
            mount: validated_name("mount", mount)?,
        })
    }

    /// The login path this mode posts to.
    #[must_use]
    pub fn login_path(&self) -> Option<String> {
        match self {
            Self::Token => None,
            Self::CertRole { mount, .. } => Some(format!("/v1/auth/{mount}/login")),
        }
    }
}

fn validated_name(field: &str, value: &str) -> Result<String, AuthorityError> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 64 {
        return Err(AuthorityError::Provider(format!(
            "{field} must be 1..=64 characters"
        )));
    }
    if !trimmed.bytes().all(|byte| {
        byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
    }) {
        return Err(AuthorityError::Provider(format!(
            "{field} is a name, not a path"
        )));
    }
    Ok(trimmed.to_owned())
}

/// A certificate-authenticated `OpenBao` client.
///
/// The `reqwest::Client` is built by the caller from
/// `opensesame_transport_security::reqwest_builder`, so the client certificate,
/// the server trust bundle and the expected server identity are all already
/// validated: this adapter never reads a PEM file, never selects a certificate
/// per request, and never disables verification.
pub struct OpenBaoCertAuth {
    base: String,
    mode: OpenBaoAuthMode,
    scope: CertTokenScope,
    http: reqwest::Client,
    cached: Mutex<Option<CertToken>>,
}

impl std::fmt::Debug for OpenBaoCertAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenBaoCertAuth")
            .field("base", &self.base)
            .field("mode", &self.mode)
            .field("scope", &self.scope)
            .finish_non_exhaustive()
    }
}

impl OpenBaoCertAuth {
    /// # Errors
    ///
    /// `Provider` for a base URL that is not https (or loopback http), or for
    /// a mode that is not [`OpenBaoAuthMode::CertRole`] — this adapter exists
    /// only for certificate authentication, and token mode stays on
    /// `OpenBaoHttpAuthority`.
    pub fn new(
        base: impl Into<String>,
        mode: OpenBaoAuthMode,
        scope: CertTokenScope,
        http: reqwest::Client,
    ) -> Result<Self, AuthorityError> {
        let base = base.into().trim_end_matches('/').to_string();
        assert_authority_base_url(&base)?;
        if mode.login_path().is_none() {
            return Err(AuthorityError::Provider(
                "OpenBaoCertAuth requires an explicit cert-role mode".into(),
            ));
        }
        Ok(Self {
            base,
            mode,
            scope,
            http,
            cached: Mutex::new(None),
        })
    }

    #[must_use]
    pub fn scope(&self) -> &CertTokenScope {
        &self.scope
    }

    /// Log in with the client certificate this adapter's HTTP client presents.
    ///
    /// # Errors
    ///
    /// `Denied` when the role refuses the presented certificate, `Unavailable`
    /// when the server is sealed or throttled, `Provider` for a transport
    /// failure (which includes a handshake the server or the client rejected)
    /// or an unreadable response.
    pub async fn login(&self) -> Result<CertToken, AuthorityError> {
        let path = self
            .mode
            .login_path()
            .ok_or_else(|| AuthorityError::Provider("no login path for this mode".into()))?;
        let OpenBaoAuthMode::CertRole { role, .. } = &self.mode else {
            return Err(AuthorityError::Provider("not a cert-role mode".into()));
        };
        // The URL guard runs before the request is sent, every time.
        assert_authority_base_url(&self.base)?;
        let response = self
            .http
            .post(format!("{}{path}", self.base))
            .json(&json!({ "name": role }))
            .send()
            .await
            .map_err(|error| AuthorityError::Provider(transport_class(&error)))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| AuthorityError::Provider(transport_class(&error)))?;
        if body.len() > MAX_LOGIN_BODY_BYTES {
            return Err(AuthorityError::Provider("login response too large".into()));
        }
        if status.as_u16() == 503 || status.as_u16() == 429 {
            return Err(AuthorityError::Unavailable);
        }
        let parsed: Value = serde_json::from_str(&body)
            .map_err(|_| AuthorityError::Provider(format!("login answered {status}")))?;
        if !status.is_success() {
            return Err(match parse_login(&parsed) {
                Err(error) => error,
                Ok(_) => AuthorityError::Denied(format!("login answered {status}")),
            });
        }
        parse_login(&parsed)
    }

    /// The token for this scope, logging in only when there is no usable
    /// cached one.
    ///
    /// # Errors
    ///
    /// As [`OpenBaoCertAuth::login`].
    pub async fn token(&self) -> Result<SecretString, AuthorityError> {
        if let Some(token) = self.cached_usable() {
            return Ok(token);
        }
        let minted = self.login().await?;
        let value = minted.secret().clone();
        if let Ok(mut slot) = self.cached.lock() {
            *slot = Some(minted);
        }
        Ok(value)
    }

    fn cached_usable(&self) -> Option<SecretString> {
        let slot = self.cached.lock().ok()?;
        let token = slot.as_ref()?;
        token
            .is_usable_at(Utc::now())
            .then(|| token.secret().clone())
    }

    /// Forget the cached token without revoking it. Used when the identity or
    /// trust generation moves: the *next* call logs in with the new
    /// certificate. This does **not** invalidate the token at the server.
    pub fn forget_cached(&self) {
        if let Ok(mut slot) = self.cached.lock() {
            *slot = None;
        }
    }

    /// Revoke the cached token at the server (`auth/token/revoke-self`).
    ///
    /// This is the only thing that actually invalidates an issued token.
    /// Revoking, expiring or rotating the *certificate* does not: it stops
    /// future logins and leaves every already-issued token valid until its
    /// lease runs out (AT-OPENBAO-TOKEN). Callers that need the token gone
    /// must call this.
    ///
    /// # Errors
    ///
    /// `Provider` for a transport failure or a non-success status. A scope
    /// with no cached token is `Ok` — there is nothing to revoke.
    pub async fn revoke_token(&self) -> Result<(), AuthorityError> {
        let Some(token) = self.cached_usable().or_else(|| {
            self.cached
                .lock()
                .ok()
                .and_then(|slot| slot.as_ref().map(|held| held.secret().clone()))
        }) else {
            return Ok(());
        };
        assert_authority_base_url(&self.base)?;
        let response = self
            .http
            .post(format!("{}/v1/auth/token/revoke-self", self.base))
            .header("X-Vault-Token", token.expose_secret())
            .send()
            .await
            .map_err(|error| AuthorityError::Provider(transport_class(&error)))?;
        self.forget_cached();
        if !response.status().is_success() {
            return Err(AuthorityError::Provider(format!(
                "revoke-self answered {}",
                response.status()
            )));
        }
        Ok(())
    }
}

/// A failure *class*. A `reqwest` error can carry the full URL and, for a TLS
/// failure, the peer's certificate details; neither belongs in a log line.
fn transport_class(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "openbao request timed out".into()
    } else if error.is_connect() {
        "openbao connection or TLS handshake failed".into()
    } else if error.is_decode() {
        "openbao response could not be decoded".into()
    } else {
        "openbao request failed".into()
    }
}

#[cfg(test)]
#[path = "cert_auth_tests.rs"]
mod tests;
