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
//! 3. **Bindings** — the thumbprint is appended to `denied_thumbprints` on
//!    every service binding through the bindings store's CAS write, so
//!    admission in *every* process reading the stored set denies it. Not
//!    possible when the deployment plane pins the set in a file: reported,
//!    never silently skipped.
//! 4. **Facts and notice** — a `revoked` fact on every target the
//!    certificate served, and a `transport.certificate.revoked` notice on
//!    the security feed.
//!
//! What it does **not** do: it does not revoke OpenBao, OAuth or session
//! tokens a connector minted while the certificate was valid. Those have
//! their own lifetimes and their own revoke (`opensesame_provider_openbao`'s
//! `revoke_token`); the response carries `tokens: "not_revoked"` so nobody
//! reads the status update as fleet-wide invalidation (AT-OPENBAO-TOKEN).
//! Offline caches are out of reach entirely.
//!
//! CRL freshness: a configured `P_CRL_FILE` is parsed on load, its
//! `nextUpdate` recorded, and a CRL past that instant makes the transport
//! status `degraded`. A stale CRL is still handed to the verifier — the
//! entries it has are better than none — but never silently.

use chrono::{DateTime, Utc};
use opensesame_domain::transport::{validate_thumbprint, ServiceBindingSet, TransportError, MAX_LIST_ENTRIES};
use opensesame_domain::OrganizationId;
use opensesame_security_events::{NoticeState, SecurityNotice, Severity};
use opensesame_storage::StoredCertificateRevocation;
use serde::{Deserialize, Serialize};

use crate::app_state::AppState;
use crate::managed_certs::{transport_metadata, CustodyError};
use crate::transport::bindings::{self, BindingsSource, PutError};
use crate::transport_lifecycle::facts::{self, Fact};
use crate::transport_lifecycle::issuance::leaf_thumbprint;

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
}

impl RevokeError {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Ambiguous | Self::Thumbprint(_) => "invalid_request",
            Self::Custody(inner) => inner.code(),
        }
    }

    #[must_use]
    pub fn http_status(&self) -> u16 {
        match self {
            Self::Ambiguous | Self::Thumbprint(_) => 400,
            Self::Custody(inner) => inner.http_status(),
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
    // Layer 3: the stored binding set, for every process.
    let bindings_note = deny_in_bindings(state, &thumbprint).await;
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
    publish_revoked(state, &tenant, certificate_id.as_deref(), &thumbprint, request.reason, now).await;
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

/// Append `thumbprint` to every stored binding's `denied_thumbprints`.
/// Returns a one-line note for the response.
async fn deny_in_bindings(state: &AppState, thumbprint: &str) -> String {
    let file = std::env::var("OPENSESAME_SERVICE_BINDINGS_FILE")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(std::path::PathBuf::from);
    let loaded = match bindings::load(&state.db, file.as_deref()).await {
        Ok(loaded) => loaded,
        Err(error) => return format!("not_updated: bindings unreadable ({})", error.code()),
    };
    if loaded.source == BindingsSource::Env {
        return "not_updated: OPENSESAME_SERVICE_BINDINGS_FILE pins the set; add the thumbprint to denied_thumbprints there".into();
    }
    let mut proposed: ServiceBindingSet = loaded.set;
    let mut changed = false;
    for binding in &mut proposed.bindings {
        if binding.denied_thumbprints.iter().any(|d| d == thumbprint) {
            continue;
        }
        if binding.denied_thumbprints.len() >= MAX_LIST_ENTRIES {
            return format!("not_updated: binding {} denylist is full", binding.id);
        }
        binding.denied_thumbprints.push(thumbprint.to_owned());
        changed = true;
    }
    if !changed {
        return "unchanged".into();
    }
    let live = state.transport_lifecycle.bindings();
    match bindings::put_cas(&state.db, loaded.source, live.as_deref(), proposed).await {
        Ok(set) => format!("updated: revision {}", set.revision),
        Err(PutError::EnvOverride) => "not_updated: env override".into(),
        Err(PutError::StaleRevision { current }) => {
            format!("not_updated: stale revision (current {current}); retry")
        }
        Err(PutError::Invalid(error)) => format!("not_updated: {}", error.code()),
        Err(PutError::Storage(_)) => "not_updated: storage error".into(),
    }
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

// —— CRL freshness ——————————————————————————————————————————————

/// What was read from a configured CRL file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct CrlFreshness {
    pub crls: usize,
    pub loaded_at: DateTime<Utc>,
    pub this_update: DateTime<Utc>,
    /// `nextUpdate`; the CRL is stale past it. Absent when the CRL carries
    /// none, which is treated as stale from the start.
    pub crl_fresh_until: Option<DateTime<Utc>>,
}

impl CrlFreshness {
    /// Stale at `now`: the status is `degraded`, never healthy.
    #[must_use]
    pub fn is_stale(&self, now: DateTime<Utc>) -> bool {
        self.crl_fresh_until.is_none_or(|until| now >= until)
    }
}

fn to_chrono(value: time::OffsetDateTime) -> Result<DateTime<Utc>, TransportError> {
    DateTime::<Utc>::from_timestamp(value.unix_timestamp(), 0)
        .ok_or_else(|| TransportError::malformed("crl: timestamp out of range"))
}

/// Parse every `X509 CRL` block in `pem` and report the earliest
/// `nextUpdate` across them.
///
/// # Errors
///
/// `MalformedConfiguration` when no CRL block parses.
pub fn crl_freshness(pem: &[u8], now: DateTime<Utc>) -> Result<CrlFreshness, TransportError> {
    let mut count = 0usize;
    let mut this_update: Option<DateTime<Utc>> = None;
    let mut next_update: Option<DateTime<Utc>> = None;
    let mut saw_missing_next = false;
    for block in x509_parser::pem::Pem::iter_from_buffer(pem) {
        let block = block.map_err(|e| TransportError::malformed(format!("crl pem: {e}")))?;
        if block.label != "X509 CRL" {
            continue;
        }
        let facts = opensesame_pki_core::revocation::parse_crl(&block.contents)
            .map_err(|e| TransportError::malformed(format!("crl: {e}")))?;
        count += 1;
        let this = to_chrono(facts.this_update)?;
        this_update = Some(this_update.map_or(this, |t| t.max(this)));
        match facts.next_update {
            Some(next) => {
                let next = to_chrono(next)?;
                next_update = Some(next_update.map_or(next, |n| n.min(next)));
            }
            None => saw_missing_next = true,
        }
    }
    if count == 0 {
        return Err(TransportError::malformed("crl file holds no X509 CRL block"));
    }
    Ok(CrlFreshness {
        crls: count,
        loaded_at: now,
        this_update: this_update.unwrap_or(now),
        crl_fresh_until: if saw_missing_next { None } else { next_update },
    })
}

/// Read a CRL file, record its freshness on the lifecycle state, and return
/// the PEM for `TrustBundle::with_crls`. A stale CRL is returned *and*
/// logged; it is the status view's job to say `degraded`.
///
/// # Errors
///
/// `MalformedConfiguration` when the file is unreadable or parses to no CRL.
pub fn load_crl_file(
    state: &AppState,
    path: &std::path::Path,
    now: DateTime<Utc>,
) -> Result<Vec<u8>, TransportError> {
    let pem = std::fs::read(path).map_err(|e| TransportError::malformed(format!("crl file: {e}")))?;
    let freshness = crl_freshness(&pem, now)?;
    if freshness.is_stale(now) {
        tracing::warn!(
            fresh_until = ?freshness.crl_fresh_until,
            "configured CRL is past its nextUpdate; transport status is degraded"
        );
    }
    state.transport_lifecycle.set_crl(Some(freshness));
    Ok(pem)
}

/// The revocation dimension for a status view.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RevocationStatus {
    pub denied_leaves: usize,
    pub crl: Option<CrlFreshness>,
    /// `healthy` with a fresh CRL or none configured, `degraded` with a
    /// stale one.
    pub outcome: &'static str,
}

#[must_use]
pub fn status(state: &AppState, now: DateTime<Utc>) -> RevocationStatus {
    let crl = state.transport_lifecycle.crl();
    let outcome = match &crl {
        Some(freshness) if freshness.is_stale(now) => "degraded",
        _ => "healthy",
    };
    RevocationStatus {
        denied_leaves: state.transport_lifecycle.denied_count(),
        crl,
        outcome,
    }
}
