//! A mock Host for the live stack: an axum router on a `SecureListener` that
//! requires the bridge's client certificate.
//!
//! It stands in for `apps/gateway/src/routes/nats_callout.rs` and repeats the
//! two Host behaviours the live path is meant to prove — **independent**
//! re-verification of the server-signed request (never trusting the bridge's
//! summary of it) and one immutable decision per request digest. It does
//! *not* re-implement the gateway's JWKS token verification: the upstream
//! token here is matched against a small table, and the real verification is
//! unit-tested in `apps/gateway/src/callout_evidence_tests.rs`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::http::StatusCode;
use axum::{Json, Router};
use opensesame_authz::CalloutPermissions;
use opensesame_domain::transport::PeerIdentitySelector;
use opensesame_nats_callout::digest::RequestDigest;
use opensesame_nats_callout::host_client::{HostDecisionRequest, HostDecisionResponse};
use opensesame_nats_callout::jwt::{decode_request, Expectations};
use opensesame_transport_security::PeerExtension;

use super::pki::BRIDGE_DNS;
use super::tokens::{outcome_for, TokenOutcome};

#[derive(Default)]
struct Ledger {
    calls: usize,
    denials: usize,
    digests: Vec<String>,
    raw_requests: Vec<String>,
    decisions: HashMap<String, HostDecisionResponse>,
}

/// What the mock Host pins when it re-verifies a request for itself.
pub struct HostPins {
    pub server_public_keys: Vec<String>,
    pub callout_subject: String,
}

pub struct MockHost {
    ledger: Mutex<Ledger>,
    pins: Mutex<Option<HostPins>>,
}

impl MockHost {
    #[must_use]
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            ledger: Mutex::new(Ledger::default()),
            pins: Mutex::new(None),
        })
    }

    /// Set once the NATS server's key is known.
    pub fn pin(&self, pins: HostPins) {
        *self.pins.lock().expect("pins") = Some(pins);
    }

    /// Decision requests received.
    #[must_use]
    pub fn calls(&self) -> usize {
        self.ledger.lock().expect("ledger").calls
    }

    /// Decision requests answered `deny`.
    #[must_use]
    pub fn denials(&self) -> usize {
        self.ledger.lock().expect("ledger").denials
    }

    /// Digests in arrival order.
    #[must_use]
    pub fn digests(&self) -> Vec<String> {
        self.ledger.lock().expect("ledger").digests.clone()
    }

    /// The raw server-signed requests, in arrival order.
    #[must_use]
    pub fn raw_requests(&self) -> Vec<String> {
        self.ledger.lock().expect("ledger").raw_requests.clone()
    }

    /// How many distinct decisions were ever recorded for `digest` (the
    /// replay invariant: always exactly one).
    #[must_use]
    pub fn decisions_for(&self, digest: &str) -> usize {
        usize::from(
            self.ledger
                .lock()
                .expect("ledger")
                .decisions
                .contains_key(digest),
        )
    }

    fn deny(&self, req: &HostDecisionRequest, code: &str) -> HostDecisionResponse {
        self.ledger.lock().expect("ledger").denials += 1;
        HostDecisionResponse {
            decision: "deny".into(),
            error: Some(code.to_owned()),
            user_nkey: Some(req.user_nkey.clone()),
            server_id: Some(req.server.id.clone()),
            request_digest: Some(req.request_digest.clone()),
            ..HostDecisionResponse::default()
        }
    }

    /// Re-verify the raw request, then decide, then record. A digest already
    /// decided returns the stored decision unchanged.
    fn decide(&self, req: &HostDecisionRequest) -> HostDecisionResponse {
        {
            let mut ledger = self.ledger.lock().expect("ledger");
            ledger.calls += 1;
            ledger.digests.push(req.request_digest.clone());
            ledger.raw_requests.push(req.raw_request_jwt.clone());
        }
        let pins = self.pins.lock().expect("pins");
        let pins = pins.as_ref().expect("pins set before the first callout");
        let verified = match decode_request(
            &req.raw_request_jwt,
            &Expectations {
                server_public_keys: pins.server_public_keys.clone(),
                callout_subject: Some(pins.callout_subject.clone()),
                now: chrono::Utc::now().timestamp(),
            },
        ) {
            Ok(verified) => verified,
            Err(err) => return self.deny(req, err.code()),
        };
        // The bridge's summary is checked against the signed original.
        if RequestDigest::compute(&verified.claims).as_str() != req.request_digest
            || verified.user_nkey() != req.user_nkey
            || verified.claims.nats.server_id.id != req.server.id
        {
            return self.deny(req, "request_mismatch");
        }
        if let Some(stored) = self
            .ledger
            .lock()
            .expect("ledger")
            .decisions
            .get(&req.request_digest)
        {
            return stored.clone();
        }
        let token = req
            .evidence
            .as_ref()
            .and_then(|e| e.upstream_token.as_deref());
        let decided = match token.map(outcome_for) {
            None => self.deny(req, "unsigned_evidence"),
            Some(TokenOutcome::Deny(code)) => self.deny(req, code),
            Some(TokenOutcome::Allow { principal, ttl }) => allow(req, principal, ttl),
        };
        self.ledger
            .lock()
            .expect("ledger")
            .decisions
            .insert(req.request_digest.clone(), decided.clone());
        decided
    }
}

fn allow(req: &HostDecisionRequest, principal: &str, ttl: i64) -> HostDecisionResponse {
    let inbox = format!("opensesame.callout.principal.{principal}.>");
    HostDecisionResponse {
        decision: "allow".into(),
        principal_id: Some(principal.to_owned()),
        provisional: Some(false),
        permissions: Some(CalloutPermissions {
            publish: vec![inbox.clone()],
            subscribe: vec![inbox, "_INBOX.>".into()],
        }),
        user_nkey: Some(req.user_nkey.clone()),
        server_id: Some(req.server.id.clone()),
        request_digest: Some(req.request_digest.clone()),
        exp: Some((chrono::Utc::now() + chrono::Duration::seconds(ttl)).to_rfc3339()),
        enforcement: Some("verified".into()),
        ..HostDecisionResponse::default()
    }
}

async fn callout(
    State(host): State<Arc<MockHost>>,
    peer: Option<axum::extract::Extension<PeerExtension>>,
    Json(req): Json<HostDecisionRequest>,
) -> Result<Json<HostDecisionResponse>, StatusCode> {
    // AT-CALLOUT-BRIDGE: only the bridge's exact identity may ask.
    let Some(axum::extract::Extension(PeerExtension(peer))) = peer else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let is_bridge = peer
        .identities()
        .iter()
        .any(|id| matches!(id, PeerIdentitySelector::DnsName(name) if name == BRIDGE_DNS));
    if !is_bridge {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(Json(host.decide(&req)))
}

/// The mock Host's router.
pub fn router(host: Arc<MockHost>) -> Router {
    Router::new()
        .route("/api/v1/nats/auth/callout", axum::routing::post(callout))
        .with_state(host)
}
