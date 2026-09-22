//! The callout route's deployment-plane configuration and the bridge's two
//! doors.
//!
//! `mtls` is the only door a production deployment has. The shared secret is
//! a named legacy profile (`OPENSESAME_NATS_CALLOUT_AUTH=shared_secret`),
//! confined to a plain loopback listener in a deployment without production
//! safeguards — never a fallback when mTLS admission fails.

use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use opensesame_domain::transport::BindingPurpose;
use opensesame_transport_security::ListenerProvenance;

use super::callout_evidence::{parse_issuer_jwks, CalloutEvidenceVerifier};
use super::{refuse, verify, CALLOUT_TOKEN_HEADER};
use crate::app_state::AppState;
use crate::config::constant_time_eq;
use crate::transport::admission;
use crate::transport::config::AuthMode;

/// Everything the route reads from the deployment plane.
#[derive(Clone, Debug)]
pub struct CalloutConfig {
    pub shared_secret: String,
    pub issuer_allowlist: String,
    /// Server nkeys allowed to sign requests. Empty refuses every callout,
    /// because an unpinned server is not provenance (AT-CALLOUT-PROVENANCE).
    pub server_nkeys: Vec<String>,
    /// The callout issuer nats-server puts in a request's `sub`.
    pub callout_subject: Option<String>,
    /// Development only: the identity used when a request carries no
    /// verifiable user evidence. A decision made from it is stamped
    /// `unverified_dev`, which the bridge refuses to sign as an allow, so the
    /// hatch is visibly unable to satisfy the enforcement claim.
    pub dev_identity: Option<(String, String)>,
    pub cert_identity: bool,
    pub cert_peers: Vec<verify::CertPeer>,
    pub evidence: CalloutEvidenceVerifier,
}

fn split_list(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect()
}

impl CalloutConfig {
    /// Read the process environment.
    ///
    /// # Errors
    ///
    /// The offending variable, so the route answers `callout_misconfigured`
    /// rather than guessing a weaker policy.
    pub fn from_env(production: bool) -> Result<Self, String> {
        Self::from_lookup(production, &|name| std::env::var(name).ok())
    }

    /// Read from a lookup, so tests never touch the process environment.
    ///
    /// # Errors
    ///
    /// As [`Self::from_env`].
    pub fn from_lookup(
        production: bool,
        lookup: &dyn Fn(&str) -> Option<String>,
    ) -> Result<Self, String> {
        let var = |name: &str| lookup(name).unwrap_or_default();
        let issuers = parse_issuer_jwks(&var("OPENSESAME_NATS_CALLOUT_ISSUER_JWKS"), !production)?;
        let cert_peers = verify::parse_cert_peers(&var("OPENSESAME_NATS_CALLOUT_CERT_PEERS"))?;
        let cert_identity = var("OPENSESAME_NATS_CALLOUT_CERT_IDENTITY") == "1";
        if cert_identity && cert_peers.is_empty() {
            return Err("OPENSESAME_NATS_CALLOUT_CERT_PEERS".into());
        }
        let dev_identity = if production {
            None
        } else {
            var("OPENSESAME_NATS_CALLOUT_DEV_IDENTITY")
                .split_once('|')
                .map(|(issuer, subject)| (issuer.trim().to_owned(), subject.trim().to_owned()))
                .filter(|(issuer, subject)| !issuer.is_empty() && !subject.is_empty())
        };
        Ok(Self {
            shared_secret: var("OPENSESAME_NATS_CALLOUT_SECRET"),
            issuer_allowlist: var("OPENSESAME_NATS_CALLOUT_ISSUERS"),
            server_nkeys: split_list(&var("OPENSESAME_NATS_SERVER_NKEYS")),
            callout_subject: Some(var("OPENSESAME_NATS_CALLOUT_SUBJECT")).filter(|s| !s.is_empty()),
            dev_identity,
            cert_identity,
            cert_peers,
            evidence: CalloutEvidenceVerifier::new(
                issuers,
                Some(var("OPENSESAME_NATS_CALLOUT_AUDIENCE")).filter(|a| !a.is_empty()),
                !production,
            ),
        })
    }
}

fn extract_callout_token(headers: &HeaderMap) -> Option<String> {
    if let Some(v) = headers
        .get(CALLOUT_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
    {
        let t = v.trim();
        if !t.is_empty() {
            return Some(t.to_owned());
        }
    }
    let auth = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())?;
    let lower = auth.to_ascii_lowercase();
    let rest = lower.strip_prefix("bearer ")?;
    let start = auth.len() - rest.len();
    let token = auth[start..].trim();
    (!token.is_empty()).then(|| token.to_owned())
}

/// Authenticate the *bridge* (never the end user).
///
/// # Errors
///
/// The refusal to send back: `listener_policy_mismatch` when the configured
/// door is mTLS and this request did not come through it, `unauthorized` for
/// a wrong or missing shared secret, `callout_misconfigured` when neither
/// door is usable.
pub fn authenticate_bridge(
    st: &AppState,
    cfg: &CalloutConfig,
    parts: &axum::http::request::Parts,
) -> Result<(), Response> {
    if admission::requires_mtls(st, BindingPurpose::NatsAuthBridge) {
        return admission::require_service_caller(
            st,
            &parts.extensions,
            BindingPurpose::NatsAuthBridge,
            "nats.callout.decide",
        )
        .map(|_| ());
    }
    let shared_secret_configured = st
        .transport
        .as_ref()
        .is_none_or(|runtime| runtime.config.callout_auth == AuthMode::SharedSecret);
    let plain_listener = matches!(
        parts.extensions.get::<ListenerProvenance>(),
        Some(ListenerProvenance::Plain { .. }) | None
    );
    if st.deployment.production_safeguards() || !shared_secret_configured || !plain_listener {
        return Err(refuse(StatusCode::FORBIDDEN, "listener_policy_mismatch"));
    }
    if cfg.shared_secret.is_empty() {
        return Err(refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            "callout_misconfigured",
        ));
    }
    let Some(presented) = extract_callout_token(&parts.headers) else {
        return Err(refuse(StatusCode::UNAUTHORIZED, "unauthorized"));
    };
    if constant_time_eq(&presented, &cfg.shared_secret) {
        Ok(())
    } else {
        Err(refuse(StatusCode::UNAUTHORIZED, "unauthorized"))
    }
}
