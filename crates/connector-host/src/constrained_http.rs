//! L2 constrained HTTP (ADR 0005 Level 2), admitted the way ADR 0150 §6.7
//! says: through the surrogate ledger, and executed through the
//! invoke-through broker.
//!
//! This path used to simulate. It checked where the caller had put the
//! placeholder with placement rules of its own, string-replaced the
//! placeholder with the credential, threw the result away (`let _wired = …`)
//! and reported `credential_injected: true` for a request nobody sent. Two
//! rule sets for one decision drift, and these had: a placeholder with
//! anything after it in the header passed, and a request carrying no
//! placeholder at all reported an injection.
//!
//! Now there is one rule set, invoke-through's:
//!
//! 1. **Recognize.** A connection's placeholder is an `osr_` surrogate this
//!    host's [`SurrogateLedger`] issued. It is admitted only as the entire
//!    value of its declared site, once, from the caller it was issued to, to
//!    a host its provider's rule names, inside its method and path scope.
//!    Anywhere else — the body beside a valid header, the query, a second
//!    header — it is refused, and the refusal is logged as a tripwire.
//! 2. **Strip.** The header it arrived in is removed.
//! 3. **Re-place.** [`Invoker::execute`] writes the connection's credential
//!    into the one site the provider's egress rule names, and scrubs it from
//!    whatever the upstream sends back. No text the caller wrote is ever
//!    rewritten into a credential.
//!
//! The caller a surrogate is bound to is the connection-policy id the
//! invocation arrives on (the `connection_id` of [`HostRuntime::invoke`]), so
//! a placeholder issued to one connector binding is dead on any other.

mod params;
mod tripwire;

use std::collections::HashMap;
use std::fmt::{self, Write as _};
use std::time::{SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use opensesame_invoke_through::{
    EgressFence, InvokeError, InvokeResponse, Invoker, PreparedRequest, Refusal, RefusalCode,
    RequestView, Surrogate, SurrogateLedger, SurrogateSpec, DEFAULT_REQUEST_BODY_CAP, EGRESS_RULES,
};
use secrecy::SecretString;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::{
    is_constrained_http, opensesame_param_digest, HostError, HostRuntime, InvokeRequest,
    InvokeResult,
};
use params::L2Call;
use tripwire::tripwire;

/// What the synchronous entry point says after admitting an L2 request it
/// cannot send.
pub(crate) const NEEDS_BROKER: &str =
    "constrained HTTP executes only through invoke_constrained_http";

pub(crate) fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

/// What the host holds for one connection: the placeholder it issued and the
/// credential that placeholder selects. Neither is a request parameter; a
/// request may name the connection, which is what a reference is for.
struct HostConnection {
    surrogate: Surrogate,
    run_id: String,
    material: SecretString,
}

/// The run only. The placeholder is the key to the connection and the
/// material is the credential; neither belongs in a trace.
impl fmt::Debug for HostConnection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HostConnection")
            .field("run_id", &self.run_id)
            .finish_non_exhaustive()
    }
}

/// The L2 connection table and the ledger its placeholders are admitted
/// through. In memory only: a restart revokes every placeholder.
pub(crate) struct ConstrainedHttp {
    ledger: SurrogateLedger,
    /// The broker's pre-connect fence over the same rules, for the
    /// synchronous entry point, which has no broker of its own.
    fence: EgressFence,
    connections: HashMap<String, HostConnection>,
}

impl Default for ConstrainedHttp {
    fn default() -> Self {
        let rules = EGRESS_RULES.to_vec();
        Self {
            ledger: SurrogateLedger::new(rules.clone()),
            fence: EgressFence::new(rules, DEFAULT_REQUEST_BODY_CAP),
            connections: HashMap::new(),
        }
    }
}

impl fmt::Debug for ConstrainedHttp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ConstrainedHttp")
            .field("ledger", &self.ledger)
            .field("connections", &self.connections.len())
            .finish_non_exhaustive()
    }
}

/// An admitted L2 request: cleared by the ledger and by the broker's fence,
/// with the credential it will be sent under still in the host's hands.
pub(crate) struct Admitted<'a> {
    prepared: PreparedRequest,
    material: &'a SecretString,
    connection_ref: String,
    method: String,
}

impl HostRuntime {
    /// Hold `material` for `spec.connection_ref` and issue the placeholder a
    /// client presents in its place. The placeholder is an `osr_` surrogate:
    /// it selects this connection's credential when it arrives as the whole
    /// value of `spec.site`, from `spec.caller` (the connection-policy id the
    /// invocation arrives on), inside `spec`'s scope, and does nothing
    /// anywhere else.
    ///
    /// # Errors
    ///
    /// When the connection is already registered, or the ledger refuses the
    /// spec (a provider with no egress rule, an incomplete scope).
    pub fn register_connection(
        &mut self,
        spec: SurrogateSpec,
        material: SecretString,
    ) -> Result<Surrogate, HostError> {
        let table = &mut self.constrained;
        if table.connections.contains_key(&spec.connection_ref) {
            return Err(HostError::Connector(
                "connection is already registered".into(),
            ));
        }
        let connection_ref = spec.connection_ref.clone();
        let run_id = spec.run_id.clone();
        let surrogate = table
            .ledger
            .issue(spec, *uuid::Uuid::new_v4().as_bytes())
            .map_err(|error| HostError::Connector(error.to_string()))?;
        table.connections.insert(
            connection_ref,
            HostConnection {
                surrogate: surrogate.clone(),
                run_id,
                material,
            },
        );
        Ok(surrogate)
    }

    /// End a run: forget the credential of every connection registered under
    /// it and revoke their placeholders. A late use then reads as
    /// `surrogate.revoked`, a tripwire, rather than as noise.
    pub fn revoke_run(&mut self, run_id: &str) -> usize {
        self.constrained
            .connections
            .retain(|_, connection| connection.run_id != run_id);
        self.constrained.ledger.revoke_run(run_id)
    }

    /// Execute one L2 request through `invoker`: admit it through the ledger,
    /// clear it through the invoker's own fence, and let the invoker place the
    /// connection's credential and scrub it from the response. The summary
    /// is the upstream's status, allowlisted headers, body and receipt.
    ///
    /// # Errors
    ///
    /// Every check [`HostRuntime::invoke`] makes; `SurrogateRefused` naming
    /// the fence a misplaced, misdirected, foreign or stale placeholder hit;
    /// `PlaceholderMismatch` for a request with no placeholder of this
    /// connection's; and the broker's own refusals and transport failures.
    pub async fn invoke_constrained_http(
        &self,
        connection_id: &str,
        req: &InvokeRequest,
        invoker: &Invoker,
    ) -> Result<InvokeResult, HostError> {
        let (_, level) = self.checked_level(connection_id, req)?;
        if !is_constrained_http(level, req) {
            return Err(HostError::InvokeLevelDenied);
        }
        let admitted =
            self.admit_constrained_http(connection_id, req, now_unix(), Some(invoker.fence()))?;
        let response = invoker
            .execute(admitted.material, admitted.prepared)
            .await
            .map_err(|error| HostError::Connector(error.to_string()))?;
        Ok(summarize(
            &admitted.connection_ref,
            &admitted.method,
            &response,
        ))
    }

    /// Admission alone, shared by both entry points so there is one rule set.
    pub(crate) fn admit_constrained_http(
        &self,
        caller: &str,
        req: &InvokeRequest,
        now_unix: u64,
        fence: Option<&EgressFence>,
    ) -> Result<Admitted<'_>, HostError> {
        if req.operation != req.authorized_operation {
            return Err(HostError::OperationMismatch);
        }
        if opensesame_param_digest(&req.parameters) != req.parameters_digest {
            return Err(HostError::ParameterDigestMismatch);
        }
        let call = L2Call::parse(req)?;
        let table = &self.constrained;
        // Parsed as the broker will send it, never normalized: a path the
        // ledger scoped is the path the upstream receives.
        let uri: http::Uri = call
            .url
            .parse()
            .map_err(|_| HostError::DestinationDenied("invalid request URL".into()))?;
        let host = uri.host().unwrap_or_default().to_ascii_lowercase();
        let view = RequestView {
            method: &call.method,
            scheme: uri.scheme_str().unwrap_or_default(),
            host: &host,
            port: uri.port_u16(),
            path_and_query: uri
                .path_and_query()
                .map_or("/", http::uri::PathAndQuery::as_str),
            headers: &call.headers,
            body: &call.body,
        };
        let admission = match table.ledger.admit(&view, caller, now_unix) {
            Ok(Some(admission)) => admission,
            Ok(None) => return Err(HostError::PlaceholderMismatch),
            Err(refusal) => return Err(tripwire(&refusal)),
        };
        // Another connection's placeholder, presented under this connection's
        // name, is not one this connection issued. The ledger answers before
        // the connection table is read, so naming a connection reference
        // confirms nothing about whether this host holds it.
        if admission.connection_ref != call.connection_ref {
            return Err(tripwire(&Refusal {
                code: RefusalCode::Unknown,
                run_id: Some(admission.run_id),
                provider_id: Some(admission.provider_id),
                detail: Some("connection_ref".into()),
            }));
        }
        // A run's end drops the connection and revokes its placeholder
        // together, so the ledger has already refused anything this misses.
        let connection = table
            .connections
            .get(&call.connection_ref)
            .ok_or_else(|| HostError::Connector("unknown connection".into()))?;
        // A request may name the placeholder it carries, but not another.
        if call
            .placeholder
            .as_deref()
            .is_some_and(|named| named != connection.surrogate.as_str())
        {
            return Err(HostError::PlaceholderMismatch);
        }
        let prepared = fence
            .unwrap_or(&table.fence)
            .preflight(opensesame_invoke_through::InvokeRequest {
                provider_id: admission.provider_id,
                method: call.method.clone(),
                url: call.url,
                headers: admission.forward_headers,
                body: (!call.body.is_empty()).then(|| Bytes::from(call.body)),
                subject: Some(call.connection_ref.clone()),
                actor: Some(admission.run_id),
            })
            .map_err(preflight_refusal)?;
        Ok(Admitted {
            prepared,
            material: &connection.material,
            connection_ref: call.connection_ref,
            method: call.method,
        })
    }
}

fn preflight_refusal(error: InvokeError) -> HostError {
    match error {
        InvokeError::InvalidUrl
        | InvokeError::UnsupportedProvider(_)
        | InvokeError::EgressDenied { .. }
        | InvokeError::HttpsRequired(_) => HostError::DestinationDenied(error.to_string()),
        other => HostError::Connector(other.to_string()),
    }
}

/// What the caller sees: the upstream response the broker already capped,
/// filtered and scrubbed, and the receipt. The request digest covers the
/// method and the receipt's scheme, host and path — never the query, never a
/// header.
fn summarize(connection_ref: &str, method: &str, response: &InvokeResponse) -> InvokeResult {
    let receipt = &response.receipt;
    let digest = Sha256::new()
        .chain_update(method.to_ascii_uppercase())
        .chain_update(b" ")
        .chain_update(&receipt.scheme)
        .chain_update(b"://")
        .chain_update(&receipt.host)
        .chain_update(&receipt.path)
        .finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(hex, "{byte:02x}");
    }
    InvokeResult {
        ok: (200..300).contains(&response.status),
        safe_summary: json!({
            "status": response.status,
            "connection_ref": connection_ref,
            "headers": response.headers,
            "body": String::from_utf8_lossy(&response.body),
            "receipt": receipt,
            "credential_injected": true,
            "credential_bytes_returned_to_guest": false,
        }),
        external_request_digest: Some(format!("sha256:{hex}")),
    }
}

#[cfg(test)]
#[path = "constrained_http_tests.rs"]
mod tests;
