//! Revocation with its enforced bound named per layer (LIFE-REVOCATION).
//!
//! Revoking a transport certificate does four separate things, and the
//! response says which happened:
//!
//! 1. **New handshakes** — the leaf thumbprint enters the process-wide
//!    denylist consulted by every secure listener before a connection is
//!    admitted (`ServerProfile::deny_thumbprint`, wired to
//!    `LifecycleState::deny_hook`), and the attached `TransportGenerations`
//!    denylist. Effective immediately for this process.
//! 2. **Existing connections** — the same denylist is checked by
//!    `enforce_current_generation` on every guarded request, so a keep-alive
//!    connection authenticated before the revocation is refused on its next
//!    operation (AT-TLS-REVOKEDLIVE). Effective immediately for this process.
//! 3. **Durable** — the thumbprint enters the stored revoked-leaf denylist
//!    ([`super::revocation_store`]), which every process reads before it
//!    serves and on the refresh cadence, and which admission consults for
//!    every binding, including one created after the revocation. It is then
//!    appended to `denied_thumbprints` on every stored service binding
//!    through the bindings store's CAS write, retried on a lost race. Either
//!    write failing is an error response, never a `200` with a note. Not
//!    possible for bindings the deployment plane pins in a file: reported,
//!    never silently skipped.
//! 4. **Facts and notice** — a `revoked` fact on every target the
//!    certificate served, and a `transport.certificate.revoked` notice on
//!    the security feed.
//!
//! What it does **not** do: it does not revoke `OpenBao`, OAuth or session
//! tokens a connector minted while the certificate was valid. Those have
//! their own lifetimes and their own revoke (`opensesame_provider_openbao`'s
//! `revoke_token`); the response carries `tokens: "not_revoked"` so nobody
//! reads the status update as fleet-wide invalidation (AT-OPENBAO-TOKEN).
//! Offline caches are out of reach entirely.
//!
//! CRL freshness lives beside this, in [`super::crl`].

use chrono::{DateTime, Utc};
use opensesame_domain::transport::{validate_thumbprint, TransportError};
use opensesame_domain::OrganizationId;
use opensesame_security_events::{NoticeState, SecurityNotice, Severity};
use opensesame_storage::StoredCertificateRevocation;
use serde::{Deserialize, Serialize};

use crate::app_state::AppState;
use crate::managed_certs::{transport_metadata, CustodyError};
use crate::transport_lifecycle::facts::{self, Fact};
use crate::transport_lifecycle::minting::leaf_thumbprint;
use crate::transport_lifecycle::revocation_store::{self, DurableError};

/// The notice published on revocation.
pub const EVENT_REVOKED: &str = "transport.certificate.revoked";

/// RFC 5280 `CRLReason` names accepted by the revoke verb.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum RevokeReason {
    Unspecified,
    KeyCompromise,
    CaCompromise,
    AffiliationChanged,
    Superseded,
    CessationOfOperation,
    PrivilegeWithdrawn,
}

impl RevokeReason {
    #[must_use]
    pub const fn code(self) -> i64 {
        match self {
            Self::Unspecified => 0,
            Self::KeyCompromise => 1,
            Self::CaCompromise => 2,
            Self::AffiliationChanged => 3,
            Self::Superseded => 4,
            Self::CessationOfOperation => 5,
            Self::PrivilegeWithdrawn => 9,
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Unspecified => "unspecified",
            Self::KeyCompromise => "key_compromise",
            Self::CaCompromise => "ca_compromise",
            Self::AffiliationChanged => "affiliation_changed",
            Self::Superseded => "superseded",
            Self::CessationOfOperation => "cessation_of_operation",
            Self::PrivilegeWithdrawn => "privilege_withdrawn",
        }
    }
}

/// The operator's request: a managed certificate by id, or any leaf by
/// thumbprint. Exactly one of the two.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RevokeRequest {
    #[serde(default)]
    pub certificate_id: Option<String>,
    #[serde(default)]
    pub thumbprint: Option<String>,
    pub reason: RevokeReason,
}

/// The bound actually enforced, per layer, after a revocation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RevocationOutcome {
    pub certificate_id: Option<String>,
    pub leaf_thumbprint_sha256: String,
    pub reason: RevokeReason,
    /// New handshakes presenting this leaf are refused by this process.
    pub new_handshakes: &'static str,
    /// Open connections are refused on their next guarded request.
    pub existing_connections: &'static str,
    /// Whether the stored binding set now denies the leaf, or why not.
    pub bindings: String,
    /// Tokens minted while the certificate was valid keep their own lifetime.
    pub tokens: &'static str,
    /// Cached application code and offline state are unreachable.
    pub offline: &'static str,
    pub targets: Vec<String>,
}

/// Why a revocation was refused.
#[derive(Debug, thiserror::Error)]
pub enum RevokeError {
    #[error("exactly one of certificate_id or thumbprint is required")]
    Ambiguous,
    #[error("thumbprint: {0}")]
    Thumbprint(TransportError),
    #[error(transparent)]
    Custody(#[from] CustodyError),
    /// A durable layer (the stored denylist, the stored bindings) could not
    /// be applied. The leaf is already refused in this process; the
    /// revocation is idempotent, so the operator retries.
    #[error("revocation not applied durably: {0}")]
    Durable(#[from] DurableError),
}

impl RevokeError {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Ambiguous | Self::Thumbprint(_) => "invalid_request",
            Self::Custody(inner) => inner.code(),
            Self::Durable(inner) => inner.code(),
        }
    }

    #[must_use]
    pub fn http_status(&self) -> u16 {
        match self {
            Self::Ambiguous | Self::Thumbprint(_) => 400,
            Self::Custody(inner) => inner.http_status(),
            Self::Durable(inner) => inner.http_status(),
        }
    }
}

/// Revoke for `organization`. See the module docs for what each layer gets.
///
/// # Errors
///
/// [`RevokeError`].
pub async fn revoke_transport(
    state: &AppState,
    organization: &OrganizationId,
    request: RevokeRequest,
) -> Result<RevocationOutcome, RevokeError> {
    let tenant = organization.to_string();
    let now = Utc::now();
    let (certificate_id, thumbprint) = match (&request.certificate_id, &request.thumbprint) {
        (Some(id), None) => {
            let row = state
                .db
                .get_certificate(&tenant, id)
                .await
                .map_err(CustodyError::Storage)?
                .ok_or(CustodyError::NotFound)?;
            let thumbprint = recorded_thumbprint(&row).ok_or(CustodyError::LeafNotRetained)?;
            if row.status == "active" {
                let revocation = StoredCertificateRevocation {
                    id: format!("revocation:{}", uuid::Uuid::new_v4()),
                    organization_id: tenant.clone(),
                    certificate_id: row.id.clone(),
                    ca_id: row.authority_id.clone(),
                    serial: row.serial_number.clone(),
                    reason_code: request.reason.code(),
                    revoked_at: now.to_rfc3339(),
                    crl_number: None,
                    version: 1,
                    created_at: now.to_rfc3339(),
                    updated_at: now.to_rfc3339(),
                };
                state
                    .db
                    .insert_certificate_revocation(&revocation)
                    .await
                    .map_err(CustodyError::Storage)?;
            }
            (Some(row.id), thumbprint)
        }
        (None, Some(thumbprint)) => {
            let lowered = thumbprint.to_ascii_lowercase();
            validate_thumbprint("thumbprint", &lowered).map_err(RevokeError::Thumbprint)?;
            (None, lowered)
        }
        _ => return Err(RevokeError::Ambiguous),
    };

    // Layers 1 and 2: this process, immediately.
    state.transport_lifecycle.deny(&thumbprint);
    if let Some(id) = &certificate_id {
        state.transport_lifecycle.invalidate(id);
        state
            .transport_lifecycle
            .with_scheduler(|s| s.forget(&tenant, id));
    }
    // Layer 3: the durable denylist (every process, every binding — also
    // ones created later — and across restarts), then the stored binding
    // set. The denylist is written first so a failure there is the one
    // that stops the revocation.
    revocation_store::persist(state, &thumbprint).await?;
    let bindings_note = revocation_store::deny_in_bindings(state, &thumbprint).await;
    // Layer 4: facts and the feed.
    let mut targets = certificate_id
        .as_deref()
        .map(|id| state.transport_lifecycle.targets_for(id))
        .unwrap_or_default();
    if let Some(id) = &certificate_id {
        targets.push(id.clone());
    }
    for target in &targets {
        facts::note(
            state,
            target,
            Fact::Revoked {
                reason: request.reason.as_str().to_owned(),
                at: now,
            },
        )
        .await;
    }
    publish_revoked(
        state,
        &tenant,
        certificate_id.as_deref(),
        &thumbprint,
        request.reason,
        now,
    )
    .await;
    // Facts and the notice are recorded either way: the leaf *is* revoked
    // in this process and in the durable denylist.
    let bindings_note = bindings_note?;
    Ok(RevocationOutcome {
        certificate_id,
        leaf_thumbprint_sha256: thumbprint,
        reason: request.reason,
        new_handshakes: "refused_in_this_process",
        existing_connections: "denied_on_next_guarded_request",
        bindings: bindings_note,
        tokens: "not_revoked_by_this_operation",
        offline: "unreachable",
        targets,
    })
}

fn recorded_thumbprint(row: &opensesame_storage::StoredManagedCertificate) -> Option<String> {
    transport_metadata(row)
        .and_then(|t| t.get("leaf_thumbprint_sha256")?.as_str().map(str::to_owned))
        .or_else(|| {
            crate::managed_certs_tls::retained_leaf_pem(row)
                .and_then(|pem| leaf_thumbprint(&pem).ok())
        })
}

async fn publish_revoked(
    state: &AppState,
    tenant: &str,
    certificate_id: Option<&str>,
    thumbprint: &str,
    reason: RevokeReason,
    now: DateTime<Utc>,
) {
    let subject_id = certificate_id.map_or_else(|| format!("leaf:{thumbprint}"), str::to_owned);
    let notice = SecurityNotice {
        event_type: EVENT_REVOKED.into(),
        severity: Severity::Critical,
        state: NoticeState::Firing,
        organization_id: tenant.to_owned(),
        subject_kind: "certificate".into(),
        subject_id,
        label: None,
        occurred_at: now,
        summary: format!("transport certificate revoked ({})", reason.as_str()),
        detail: Some(format!("leaf {thumbprint}")),
        payload: serde_json::json!({
            "reason": reason.as_str(),
            "leaf_thumbprint_sha256": thumbprint,
            "new_handshakes": "refused_in_this_process",
            "existing_connections": "denied_on_next_guarded_request",
            "tokens": "not_revoked_by_this_operation",
            "secrets_returned": false,
        }),
    };
    crate::security::dispatch::publish(state, &notice, now).await;
}
