//! What a certificate login produced, and the scope it belongs to
//! (ADR 0132, CONN-TOKEN-LIFECYCLE).
//!
//! A token from `OpenBao` has its own lifetime. It is issued with a
//! `lease_duration` and a policy list, and neither is derived from the
//! certificate that obtained it: the certificate proved *who asked*, the
//! policies decide *what the answer may do*, and the lease decides *for how
//! long*. Keeping those three facts in one small, `Debug`-safe value is what
//! stops the rest of the adapter from conflating them.
//!
//! [`CertTokenScope`] is the other half: a token is cached for one role, one
//! certificate (by leaf thumbprint) and one trust generation. Two workloads
//! never share a token, and a rotated certificate never reuses the token its
//! predecessor obtained.

use std::time::Duration;

use chrono::{DateTime, Utc};
use secrecy::SecretString;
use serde_json::Value;

use crate::AuthorityError;

/// How much of a lease is spent before a cached token is treated as stale, so
/// a request is never made with a token that expires mid-flight.
pub(crate) const RENEW_BEFORE: Duration = Duration::from_secs(60);

/// What a certificate login produced. `Debug` never shows the token.
pub struct CertToken {
    token: SecretString,
    pub policies: Vec<String>,
    pub lease_duration: Duration,
    pub renewable: bool,
    pub issued_at: DateTime<Utc>,
}

impl std::fmt::Debug for CertToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CertToken")
            .field("policies", &self.policies)
            .field("lease_duration", &self.lease_duration)
            .field("renewable", &self.renewable)
            .field("issued_at", &self.issued_at)
            .finish_non_exhaustive()
    }
}

impl CertToken {
    /// The token itself. Crate-internal on purpose: no public method of this
    /// adapter hands a caller `OpenBao` credential material, and the value is
    /// zeroized with the `SecretString`.
    #[must_use]
    pub(crate) fn secret(&self) -> &SecretString {
        &self.token
    }

    /// When the lease runs out. A zero `lease_duration` means the token is
    /// not lease-bound (a root or periodic token); it is still cached only
    /// for this identity and can still be revoked explicitly.
    #[must_use]
    pub fn expires_at(&self) -> Option<DateTime<Utc>> {
        if self.lease_duration.is_zero() {
            return None;
        }
        chrono::Duration::from_std(self.lease_duration)
            .ok()
            .map(|lease| self.issued_at + lease)
    }

    /// Whether the token may still be used at `now`, leaving [`RENEW_BEFORE`]
    /// of headroom so it cannot expire between the check and the request.
    #[must_use]
    pub fn is_usable_at(&self, now: DateTime<Utc>) -> bool {
        match self.expires_at() {
            None => true,
            Some(expiry) => {
                let headroom = chrono::Duration::from_std(RENEW_BEFORE)
                    .unwrap_or_else(|_| chrono::Duration::zero());
                now + headroom < expiry
            }
        }
    }

    /// Whether the token carries `policy`. `OpenBao` enforces policy itself;
    /// this exists so a caller can *check* the scope it was given rather than
    /// assume it (AT-OPENBAO-REAL: "token stays narrowly scoped").
    #[must_use]
    pub fn has_policy(&self, policy: &str) -> bool {
        self.policies.iter().any(|held| held == policy)
    }
}

/// Parse a `/v1/auth/<mount>/login` response.
///
/// # Errors
///
/// `Denied` when the body carries `errors` (what `OpenBao` answers for a role
/// the presented certificate does not match); `Provider` when `auth` or
/// `auth.client_token` is missing or of the wrong type — an unreadable
/// response is never treated as a successful login.
pub fn parse_login(body: &Value) -> Result<CertToken, AuthorityError> {
    if let Some(Value::Array(errors)) = body.get("errors") {
        let detail = errors
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("; ");
        return Err(AuthorityError::Denied(if detail.is_empty() {
            "certificate login refused".into()
        } else {
            detail
        }));
    }
    let auth = body
        .get("auth")
        .and_then(Value::as_object)
        .ok_or_else(|| AuthorityError::Provider("login response has no auth object".into()))?;
    let token = auth
        .get("client_token")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AuthorityError::Provider("login response has no client_token".into()))?;
    let lease = auth
        .get("lease_duration")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let policies = auth
        .get("token_policies")
        .or_else(|| auth.get("policies"))
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    Ok(CertToken {
        token: SecretString::from(token.to_owned()),
        policies,
        lease_duration: Duration::from_secs(lease),
        renewable: auth
            .get("renewable")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        issued_at: Utc::now(),
    })
}

/// The scope a cached token belongs to: one role, one certificate, one trust
/// generation. Nothing here is secret — a leaf thumbprint is a public digest.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CertTokenScope {
    pub role: String,
    /// The presented leaf's SHA-256 thumbprint: the identity generation.
    pub identity_thumbprint: String,
    pub trust_generation: u64,
}
