//! Verification of a rotated credential (ADR 0076).
//!
//! `CandidateVerified` is the load-bearing edge of the `opensesame-rotation`
//! machine: `PreviousRevoked` is unreachable without passing through it, and
//! that Kani-proven ordering is what makes a failed rotation recoverable rather
//! than terminal. Until now the broker walked that edge with the honest detail
//! `verify_skipped` — truthful, but it meant the edge proved nothing.
//!
//! This module makes the edge real for providers that publish a side-effect-free
//! authenticated endpoint: one `GET`, through the `invoke-through` fences, using
//! the credential the rotation just installed.
//!
//! ## Ordering is the security property
//!
//! ```text
//! preflight(request)    // egress allowlist, exact host, https, no userinfo
//!   -> open the credential   // ONLY after the fence has passed
//!   -> execute(token, prepared)
//! ```
//!
//! A denied request must never cause the credential to be opened, so preflight
//! runs first and `resolve_bearer` is not called on the denial path. `Invoker`
//! splits `preflight` from `execute` precisely so a caller can honor this, and
//! `pact::assert_source_order` pins it in the gateway's test suite.
//!
//! ## What this does not add
//!
//! No new trust: `ConnectionBroker::refresh` already opens the sealed credential
//! server-side to call the provider's token endpoint. This reuses that same
//! plaintext, for one request, behind an allowlist the token endpoint does not
//! have. Nothing here is public: no method returns credential material, and the
//! outcome carries a status class, never a response body.

use opensesame_domain::OrganizationId;
use opensesame_invoke_through::{InvokeError, InvokeRequest, Invoker};
use secrecy::SecretString;

use crate::error::Result;
use crate::rotation_egress::ROTATION_EGRESS_RULES;
use crate::ConnectionBroker;

/// What a verification attempt established.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyOutcome {
    /// The provider accepted the credential.
    Verified,
    /// No verification is possible for this provider. Recorded honestly rather
    /// than reported as a pass.
    Skipped(&'static str),
    /// The provider rejected the credential, or the call could not be made.
    /// The hint is a class, never a response body.
    Failed(String),
}

/// Recorded when a provider publishes no verification endpoint. Unchanged from
/// the string this module replaces, so an un-verifiable provider reads exactly
/// as it always did.
pub const VERIFY_SKIPPED_DETAIL: &str =
    "verify_skipped: provider catalog exposes no no-op verification invoke";

const VERIFY_DENIED_DETAIL: &str = "verify_skipped: no rotation egress rule permits this provider";

impl ConnectionBroker {
    /// Proves a rotated connection credential works by calling the provider's
    /// own read-only identity endpoint.
    ///
    /// # Errors
    ///
    /// Returns an error only when the connection or provider cannot be loaded.
    /// A provider that rejects the credential is a [`VerifyOutcome::Failed`],
    /// not an `Err`: it is information about the credential, not a broker fault.
    pub(crate) async fn verify_rotated_credential(
        &self,
        organization_id: &OrganizationId,
        connection_id: &str,
    ) -> Result<VerifyOutcome> {
        let row = self.row_in_org(organization_id, connection_id).await?;
        let provider = self
            .resolve_provider(&row.organization_id, &row.provider_id)
            .await?;
        let Some(verify) = provider.verify.as_ref() else {
            return Ok(VerifyOutcome::Skipped(VERIFY_SKIPPED_DETAIL));
        };
        let Some(host) = provider.egress.authorities.first() else {
            return Ok(VerifyOutcome::Skipped(VERIFY_SKIPPED_DETAIL));
        };

        let invoker = Invoker::with_rules(ROTATION_EGRESS_RULES.to_vec());
        let url = format!("https://{host}{}", verify.path);
        self.verify_credential_with(&invoker, &row, &provider.id, &url)
            .await
    }

    /// The verification itself, over an injected [`Invoker`] so tests drive the
    /// real ordering against a loopback server rather than a parallel mock.
    ///
    /// The fence runs first and the credential is opened only after it passes,
    /// so a denied request never causes the sealed credential to be opened at
    /// all. `apps/gateway`'s pact suite pins that order in this source.
    async fn verify_credential_with(
        &self,
        invoker: &Invoker,
        row: &crate::store::ConnectionRow,
        provider_id: &str,
        url: &str,
    ) -> Result<VerifyOutcome> {
        let request = InvokeRequest {
            provider_id: provider_id.to_string(),
            method: "GET".to_string(),
            url: url.to_string(),
            headers: vec![("accept".to_string(), "application/json".to_string())],
            body: None,
            // RFC 8693 delegation placeholders are the daemon's to fill; a
            // scheduler-driven rotation acts as the connection's own owner.
            subject: None,
            actor: None,
        };

        // Fence first. A denial must never reach the credential below.
        let prepared = match invoker.preflight(request) {
            Ok(prepared) => prepared,
            Err(InvokeError::EgressDenied { .. }) => {
                return Ok(VerifyOutcome::Skipped(VERIFY_DENIED_DETAIL));
            }
            Err(error) => return Ok(VerifyOutcome::Failed(verify_error_class(&error))),
        };

        // Only now is the credential opened, for this one request.
        let Some(token) = self.resolve_bearer(row).await? else {
            return Ok(VerifyOutcome::Skipped(VERIFY_SKIPPED_DETAIL));
        };

        match invoker.execute(&token, prepared).await {
            Ok(response) if (200..300).contains(&response.status) => Ok(VerifyOutcome::Verified),
            Ok(response) => Ok(VerifyOutcome::Failed(format!(
                "verify rejected: provider answered {}",
                response.status
            ))),
            Err(error) => Ok(VerifyOutcome::Failed(verify_error_class(&error))),
        }
    }

    /// Opens the stored credential for one outbound verification.
    ///
    /// Private to the crate and returning a `SecretString` on purpose: no
    /// public surface returns credential material (ADR 0005, ADR 0032 §6), and
    /// the value is zeroized when the request that used it is dropped.
    async fn resolve_bearer(
        &self,
        row: &crate::store::ConnectionRow,
    ) -> Result<Option<SecretString>> {
        let key = *self.sealing_key()?;
        let Some(credential) = crate::store::get_credential(&self.pool, &row.id).await? else {
            return Ok(None);
        };
        let tokens = Self::open_tokens(&key, row, &credential)?;
        if tokens.access_token.is_empty() {
            return Ok(None);
        }
        Ok(Some(SecretString::from(tokens.access_token)))
    }
}

/// Failure *class*, never provider output. An upstream body can echo request
/// content, and this string lands in a durable job row.
fn verify_error_class(error: &InvokeError) -> String {
    let class = match error {
        InvokeError::EgressDenied { .. } => "egress denied",
        InvokeError::HttpsRequired(_) => "https required",
        InvokeError::InvalidUrl => "invalid verify url",
        InvokeError::Timeout => "timeout",
        InvokeError::Transport(_) => "transport failure",
        InvokeError::ResponseTooLarge { .. } => "response too large",
        _ => "verify call failed",
    };
    format!("verify failed: {class}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Router};
    use opensesame_invoke_through::{AuthStyle, EgressRule};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// A loopback stand-in for a provider's verification endpoint. Counts hits
    /// so a test can prove a denied request never reached the wire.
    async fn verify_server(status: u16) -> (String, Arc<AtomicUsize>) {
        async fn answer(
            axum::extract::State((hits, status)): axum::extract::State<(Arc<AtomicUsize>, u16)>,
        ) -> axum::http::StatusCode {
            hits.fetch_add(1, Ordering::SeqCst);
            axum::http::StatusCode::from_u16(status).expect("status")
        }

        let hits = Arc::new(AtomicUsize::new(0));
        let state = (Arc::clone(&hits), status);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = Router::new()
            .route("/verify", get(answer))
            .with_state(state);
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        (format!("http://{address}/verify"), hits)
    }

    /// Rules for a loopback stand-in. Host matching ignores the port (the
    /// invoker compares `authority.host()`), so the rule names the address
    /// only; `allow_http_for_tests` is loopback-gated inside the crate.
    const SERVER_HOST: &[&str] = &["127.0.0.1"];
    const OTHER_HOST: &[&str] = &["127.0.0.2"];

    fn loopback_invoker(allowed: &'static [&'static str]) -> Invoker {
        Invoker::with_rules(vec![EgressRule {
            provider_id: "mock",
            scheme: "https",
            hosts: allowed,
            auth: AuthStyle::Bearer,
        }])
        .allow_http_for_tests()
    }

    /// A connection carrying a sealed API-key credential, plus its durable row.
    /// Built through the public broker API so the credential is sealed exactly
    /// as production seals it.
    async fn verifiable_connection_row() -> (ConnectionBroker, crate::store::ConnectionRow) {
        use crate::config::BrokerConfig;
        use crate::model::CreateConnection;
        use opensesame_storage::Db;

        let db = Db::connect_memory().await.expect("db");
        let config = BrokerConfig::in_memory(Some([9u8; 32]), "http://127.0.0.1:8787");
        let broker = ConnectionBroker::new(db.pool().clone(), config).expect("broker");
        let organization = OrganizationId::new();
        let connection = broker
            .create_connection(
                &organization,
                CreateConnection {
                    provider_id: "openai".into(),
                    integration_id: None,
                    display_name: None,
                    logical_name: None,
                    project_id: None,
                    scopes: None,
                    shareability: None,
                    owner_subject: None,
                },
            )
            .await
            .expect("connection");
        broker
            .set_api_key(
                &organization,
                &connection.connection_id,
                "sk-test-credential",
            )
            .await
            .expect("api key");
        let row = crate::store::get_connection(db.pool(), &connection.connection_id)
            .await
            .expect("row query")
            .expect("row");
        // The pool is owned by the broker's clone, so `db` may drop here.
        std::mem::forget(db);
        (broker, row)
    }

    /// End to end over a real socket: a provider that accepts the credential
    /// produces `Verified`, which is what lets the machine leave
    /// `CandidateInstalled`.
    #[tokio::test]
    async fn a_provider_that_accepts_the_credential_verifies() {
        let (broker, row) = verifiable_connection_row().await;
        let (url, hits) = verify_server(200).await;
        let invoker = loopback_invoker(SERVER_HOST);

        let outcome = broker
            .verify_credential_with(&invoker, &row, "mock", &url)
            .await
            .unwrap();

        assert_eq!(outcome, VerifyOutcome::Verified);
        assert_eq!(hits.load(Ordering::SeqCst), 1, "the endpoint was called");
    }

    /// A rejected credential is a `Failed`, carrying the status class only —
    /// never the response body, which a provider can echo request content into
    /// and which lands in a durable job row.
    #[tokio::test]
    async fn a_rejected_credential_fails_without_quoting_the_body() {
        let (broker, row) = verifiable_connection_row().await;
        let (url, _hits) = verify_server(401).await;
        let invoker = loopback_invoker(SERVER_HOST);

        let outcome = broker
            .verify_credential_with(&invoker, &row, "mock", &url)
            .await
            .unwrap();

        match outcome {
            VerifyOutcome::Failed(hint) => {
                assert!(hint.contains("401"), "status class is recorded: {hint}");
                assert!(!hint.contains('{'), "no response body in the hint: {hint}");
            }
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    /// The fence bites before the wire: a host the rules do not name is refused
    /// and the server is never contacted.
    #[tokio::test]
    async fn a_host_outside_the_rules_is_denied_before_any_request() {
        let (broker, row) = verifiable_connection_row().await;
        let (url, hits) = verify_server(200).await;
        // Rules naming a different host entirely.
        let invoker = loopback_invoker(OTHER_HOST);

        let outcome = broker
            .verify_credential_with(&invoker, &row, "mock", &url)
            .await
            .unwrap();

        assert_eq!(outcome, VerifyOutcome::Skipped(VERIFY_DENIED_DETAIL));
        assert_eq!(hits.load(Ordering::SeqCst), 0, "nothing reached the wire");
    }

    /// Production rules are https-only, so a plain-http verify URL cannot be
    /// smuggled through the real invoker even for an allowlisted host.
    #[tokio::test]
    async fn production_rules_refuse_plain_http() {
        let (broker, row) = verifiable_connection_row().await;
        let invoker = Invoker::with_rules(ROTATION_EGRESS_RULES.to_vec());

        let outcome = broker
            .verify_credential_with(&invoker, &row, "github", "http://api.github.com/user")
            .await
            .unwrap();

        assert!(
            matches!(
                outcome,
                VerifyOutcome::Failed(_) | VerifyOutcome::Skipped(_)
            ),
            "plain http must never verify: {outcome:?}"
        );
    }

    /// Error text stays a class. Provider output must not reach a durable row.
    #[test]
    fn error_classes_never_carry_provider_output() {
        let leaky = InvokeError::Transport("connection refused to secret-host.internal".into());
        let class = verify_error_class(&leaky);
        assert_eq!(class, "verify failed: transport failure");
        assert!(!class.contains("secret-host"));
    }
}
