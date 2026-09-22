//! The bridge core: payload in, signed response out. Deterministic given a
//! [`DecisionSource`], so every path is unit-tested without a server; the
//! NATS loop in [`run`] is the only I/O.
//!
//! Every failure after the request has been verified becomes a signed
//! *deny* naming a stable code, so the server closes the client promptly
//! instead of waiting for a timeout. A payload that does not even verify
//! gets no response at all: there is no user key to address it to, and an
//! unsigned request is not a request.

use std::sync::Arc;

use futures::StreamExt as _;

use crate::error::CalloutError;
use crate::host_client::{check_echo, DecisionSource, HostDecisionRequest, HostDecisionResponse};
use crate::jwt::{decode_request, Expectations, VerifiedRequest};
use crate::response::{ResponseSigner, UserGrant};
use crate::xkey::{is_sealed, CalloutXKey};
use crate::{AUTH_SUBJECT, MAX_REQUEST_BYTES, QUEUE_GROUP, SERVER_XKEY_HEADER};

/// Everything the core needs, all immutable after start.
pub struct BridgeCore {
    pub signer: ResponseSigner,
    /// Pinned server keys (may be empty on the bridge; never on the Host).
    pub server_public_keys: Vec<String>,
    pub xkey: Option<CalloutXKey>,
    /// Config mode: the target account's name for issued users.
    pub target_account: String,
    /// The callout issuer nats-server puts in the request's `sub`. `None`
    /// means the signing account's public key, which is what config mode
    /// (`auth_callout.issuer`) sends. Operator mode sends the account
    /// *name*, so that deployment must set this explicitly.
    pub callout_subject: Option<String>,
    pub source: Arc<dyn DecisionSource>,
}

impl std::fmt::Debug for BridgeCore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BridgeCore")
            .field("account", &self.signer.account_public_key())
            .field("pinned_servers", &self.server_public_keys.len())
            .field("xkey", &self.xkey.as_ref().map(CalloutXKey::public_key))
            .field("target_account", &self.target_account)
            .field("callout_subject", &self.callout_subject)
            .finish_non_exhaustive()
    }
}

/// The outcome of one payload.
#[derive(Debug)]
pub enum Outcome {
    /// Bytes to publish on the reply subject.
    Reply(Vec<u8>),
    /// The payload was not a verifiable request; nothing to answer.
    Dropped(CalloutError),
}

impl BridgeCore {
    fn expectations(&self, now: i64) -> Expectations {
        Expectations {
            server_public_keys: self.server_public_keys.clone(),
            callout_subject: Some(
                self.callout_subject
                    .clone()
                    .unwrap_or_else(|| self.signer.account_public_key()),
            ),
            now,
        }
    }

    /// Unseal (when needed) and verify the raw payload.
    fn verify(&self, payload: &[u8], server_xkey_header: Option<&str>, now: i64) -> Result<VerifiedRequest, CalloutError> {
        if payload.len() > MAX_REQUEST_BYTES {
            return Err(crate::error::malformed("payload exceeds the request bound"));
        }
        let token = if is_sealed(payload) {
            let Some(xkey) = &self.xkey else {
                return Err(CalloutError::XkeyRequired);
            };
            let Some(sender) = server_xkey_header else {
                return Err(CalloutError::XkeyOpenFailed);
            };
            String::from_utf8(xkey.open(payload, sender)?)
                .map_err(|_| crate::error::malformed("opened payload is not UTF-8"))?
        } else {
            String::from_utf8(payload.to_vec())
                .map_err(|_| crate::error::malformed("payload is not UTF-8"))?
        };
        let verified = decode_request(&token, &self.expectations(now))?;
        // A sealed request must name the same server xkey it was sealed with.
        if let Some(sender) = server_xkey_header {
            if verified.claims.nats.server_id.xkey.as_deref() != Some(sender) {
                return Err(CalloutError::EnvelopeMismatch);
            }
        }
        Ok(verified)
    }

    /// Ask the Host and turn its answer into a signed response.
    async fn decide(&self, verified: &VerifiedRequest, now: i64) -> Result<String, CalloutError> {
        let req = HostDecisionRequest::from_verified(verified);
        let server_id = req.server.id.as_str();
        let user = req.user_nkey.as_str();
        let resp = match self.source.decide(&req).await {
            Ok(resp) => resp,
            Err(err) => {
                tracing::warn!(code = err.code(), digest = %req.request_digest, "Host decision failed; denying");
                return self.signer.deny(server_id, user, err.code(), now);
            }
        };
        if let Err(err) = check_echo(&req, &resp) {
            tracing::warn!(code = err.code(), digest = %req.request_digest, "Host response did not echo the request; denying");
            return self.signer.deny(server_id, user, err.code(), now);
        }
        match grant_from(&resp, user, &self.target_account) {
            Some(grant) => self.signer.allow(server_id, &grant, now),
            None => {
                let code = resp.error.as_deref().unwrap_or("denied");
                self.signer.deny(server_id, user, code, now)
            }
        }
    }

    /// Handle one message payload at `now` (unix seconds).
    pub async fn handle(&self, payload: &[u8], server_xkey_header: Option<&str>, now: i64) -> Outcome {
        let verified = match self.verify(payload, server_xkey_header, now) {
            Ok(v) => v,
            Err(err) => {
                tracing::warn!(code = err.code(), "dropping unverifiable callout payload");
                return Outcome::Dropped(err);
            }
        };
        let jwt = match self.decide(&verified, now).await {
            Ok(jwt) => jwt,
            Err(err) => return Outcome::Dropped(err),
        };
        match (&self.xkey, verified.claims.nats.server_id.xkey.as_deref()) {
            (Some(xkey), Some(server_xkey)) => match xkey.seal(jwt.as_bytes(), server_xkey) {
                Ok(sealed) => Outcome::Reply(sealed),
                Err(err) => Outcome::Dropped(err),
            },
            _ => Outcome::Reply(jwt.into_bytes()),
        }
    }
}

/// An allow decision becomes a grant only when it is complete.
fn grant_from(resp: &HostDecisionResponse, user_nkey: &str, target_account: &str) -> Option<UserGrant> {
    if resp.decision != "allow" {
        return None;
    }
    let permissions = resp.permissions.clone()?;
    let exp = resp.exp.as_deref()?;
    let expires_at = chrono::DateTime::parse_from_rfc3339(exp).ok()?.timestamp();
    Some(UserGrant {
        user_nkey: user_nkey.to_owned(),
        target_account: target_account.to_owned(),
        permissions,
        expires_at,
        name: resp.principal_id.clone(),
    })
}

/// Serve callouts on `client` until the subscription ends.
///
/// # Errors
///
/// `MalformedConfiguration` when the subscription cannot be made; a publish
/// failure is logged and the loop continues (the server times the client
/// out, which is a deny).
pub async fn run(client: async_nats::Client, core: Arc<BridgeCore>) -> Result<(), CalloutError> {
    let mut sub = client
        .queue_subscribe(AUTH_SUBJECT, QUEUE_GROUP.to_owned())
        .await
        .map_err(|e| crate::error::misconfigured(format!("subscribe {AUTH_SUBJECT}: {e}")))?;
    tracing::info!(subject = AUTH_SUBJECT, queue = QUEUE_GROUP, "auth bridge serving");
    while let Some(message) = sub.next().await {
        let Some(reply) = message.reply.clone() else {
            tracing::warn!("callout without a reply subject ignored");
            continue;
        };
        let header = message
            .headers
            .as_ref()
            .and_then(|h| h.get(SERVER_XKEY_HEADER))
            .map(|v| v.as_str().to_owned());
        let now = chrono::Utc::now().timestamp();
        match core.handle(&message.payload, header.as_deref(), now).await {
            Outcome::Reply(bytes) => {
                if let Err(e) = client.publish(reply, bytes.into()).await {
                    tracing::warn!(error = %e, "callout reply publish failed");
                }
            }
            Outcome::Dropped(err) => {
                tracing::warn!(code = err.code(), "callout dropped");
            }
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "bridge_tests.rs"]
mod tests;
