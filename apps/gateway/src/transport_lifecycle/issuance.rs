//! Transport issuance over the existing private CA and custody path
//! (LIFE-ISSUANCE).
//!
//! Nothing new is enrolled here — no EST, no ACME server. The organization's
//! persisted internal authority signs, `managed_certs` seals the key exactly
//! as it does for any managed certificate, and the only things this module
//! adds are the *shape* a transport identity needs and the policy that
//! bounds it:
//!
//! - the requested identity is exact (one DNS name or one SPIFFE ID, never a
//!   wildcard, an IP, or a thumbprint);
//! - EKUs follow the purpose: `clientAuth` for an identity used as a client,
//!   `serverAuth` + `clientAuth` for a listener, and the SPIFFE dual set only
//!   when the selector is a SPIFFE ID;
//! - validity runs through `pki_core::policy` presets plus a hard ceiling,
//!   and the floor `managed_certs` already enforces for convergent renewal.
//!
//! Trust is a separate, operator-only decision (`trust.rs`): issuing a
//! certificate here creates no trust profile and no service binding, so a
//! self-issued certificate never becomes a service identity by itself.

use std::time::Duration;

use chrono::{DateTime, Utc};
use opensesame_domain::transport::{PeerIdentitySelector, TransportError};
use opensesame_domain::OrganizationId;
use opensesame_pki_core::policy::PolicyViolation;
use opensesame_storage::StoredManagedCertificate;
use serde::{Deserialize, Serialize};

use crate::app_state::AppState;
use crate::dev_pki::{DevCa, IssueRequest};
use crate::managed_certs::{self, CustodyError, ManagedRequest};
use crate::managed_certs_tls::TransportPurpose;
use crate::transport_lifecycle::facts::{self, Fact};
use crate::transport_lifecycle::minting::{leaf_thumbprint, mint_leaf, LeafShape};

/// Longest validity a transport certificate may be issued with.
pub const MAX_VALIDITY_SECONDS: u64 = 90 * 24 * 3_600;
/// Validity when the request names none.
pub const DEFAULT_VALIDITY_SECONDS: u64 = 30 * 24 * 3_600;

/// The operator's request. Bounded and exact; unknown fields are refused.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct TransportIssuanceRequest {
    pub purpose: TransportPurpose,
    /// `dns_name` or `spiffe_id`; the other selector kinds are refused.
    pub selector: PeerIdentitySelector,
    #[serde(default)]
    pub validity_seconds: Option<u64>,
    #[serde(default)]
    pub renew_before_seconds: Option<i64>,
    /// Must be `true`: a transport identity without host custody could not
    /// be renewed unattended, and a delivered key has nobody to go to.
    #[serde(default)]
    pub managed: bool,
}

/// What issuance returns: public facts only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct TransportIssuance {
    pub certificate_id: String,
    pub purpose: TransportPurpose,
    pub selector: PeerIdentitySelector,
    pub leaf_thumbprint_sha256: String,
    pub not_before: String,
    pub not_after: String,
    pub renew_before_seconds: Option<i64>,
    /// The public leaf, PEM.
    pub certificate_pem: String,
    /// The issuing authority's certificate, PEM.
    pub issuer_pem: String,
    pub managed: bool,
}

/// Why a transport issuance was refused.
#[derive(Debug, thiserror::Error)]
pub enum IssuanceError {
    #[error("transport identities must be host-managed (managed: true)")]
    NotManaged,
    #[error("selector: {0}")]
    Selector(TransportError),
    #[error("policy refused the request")]
    Policy(Vec<PolicyViolation>),
    #[error(transparent)]
    Custody(#[from] CustodyError),
}

impl IssuanceError {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotManaged => "custody_required",
            Self::Selector(_) => "invalid_selector",
            Self::Policy(_) => "policy_violation",
            Self::Custody(inner) => inner.code(),
        }
    }

    #[must_use]
    pub fn http_status(&self) -> u16 {
        match self {
            Self::NotManaged | Self::Selector(_) | Self::Policy(_) => 400,
            Self::Custody(inner) => inner.http_status(),
        }
    }
}

/// The metadata document a transport certificate row carries: the purpose
/// and selector it was issued for, its source, and the public leaf.
fn metadata_document(shape: &LeafShape, leaf_pem: &str, thumbprint: &str) -> String {
    serde_json::json!({
        "transport": {
            "purpose": shape.purpose,
            "selector": shape.selector,
            "source": "managed_certificate",
            "leaf_thumbprint_sha256": thumbprint,
        },
        "leaf_pem": leaf_pem,
    })
    .to_string()
}

/// The shape a stored transport certificate was issued with.
///
/// # Errors
///
/// `CustodyError::Mint` when the metadata is not a transport document.
pub fn shape_of(row: &StoredManagedCertificate) -> Result<LeafShape, CustodyError> {
    let transport = managed_certs::transport_metadata(row)
        .ok_or_else(|| CustodyError::Mint("not a transport certificate".into()))?;
    let purpose = transport
        .get("purpose")
        .and_then(|p| serde_json::from_value::<TransportPurpose>(p.clone()).ok())
        .ok_or_else(|| CustodyError::Mint("transport metadata lacks a purpose".into()))?;
    let selector = transport
        .get("selector")
        .and_then(|s| serde_json::from_value::<PeerIdentitySelector>(s.clone()).ok())
        .ok_or_else(|| CustodyError::Mint("transport metadata lacks a selector".into()))?;
    LeafShape::derive(purpose, selector).map_err(|e| CustodyError::Mint(e.code().to_owned()))
}

/// Re-mint a transport certificate for renewal: same purpose, same exact
/// selector, same EKU shape, fresh key. Returns the material and the
/// metadata document for the successor row.
///
/// # Errors
///
/// `CustodyError::Mint` when the predecessor's metadata is not a transport
/// document or signing fails.
pub fn remint_for_renewal(
    previous: &StoredManagedCertificate,
    ca: &DevCa,
    ttl: Duration,
) -> Result<(IssuedCert, String), CustodyError> {
    let shape = shape_of(previous)?;
    let material = mint_leaf(ca, &shape, ttl).map_err(CustodyError::Mint)?;
    let thumbprint = leaf_thumbprint(&material.certificate).map_err(CustodyError::Mint)?;
    let metadata = metadata_document(&shape, &material.certificate, &thumbprint);
    Ok((material, metadata))
}

/// Issue a host-managed transport identity for `organization`.
///
/// # Errors
///
/// [`IssuanceError`] — the request is refused whole before anything is
/// minted, sealed or recorded.
pub async fn issue_for_transport(
    state: &AppState,
    organization: &OrganizationId,
    request: TransportIssuanceRequest,
    actor: &str,
) -> Result<TransportIssuance, IssuanceError> {
    if !request.managed {
        return Err(IssuanceError::NotManaged);
    }
    let shape =
        LeafShape::derive(request.purpose, request.selector).map_err(IssuanceError::Selector)?;
    let validity = request
        .validity_seconds
        .unwrap_or(DEFAULT_VALIDITY_SECONDS);
    shape.check_policy(validity).map_err(IssuanceError::Policy)?;
    let key = state
        .connection_broker
        .config()
        .key()
        .copied()
        .ok_or(CustodyError::SealingUnavailable)?;
    let tenant = organization.to_string();
    let (authority_id, ca) = managed_certs::load_authority(state, &tenant, "", &key).await?;
    let ttl = Duration::from_secs(validity);
    let material = mint_leaf(&ca, &shape, ttl).map_err(CustodyError::Mint)?;
    let thumbprint = leaf_thumbprint(&material.certificate).map_err(CustodyError::Mint)?;
    let metadata = metadata_document(&shape, &material.certificate, &thumbprint);
    let issue_request = IssueRequest {
        common_name: material.common_name.clone(),
        dns_names: material.dns_names.clone(),
        ip_addrs: Vec::new(),
        ttl,
    };
    let issued = managed_certs::issue_managed_material(
        state,
        &ManagedRequest {
            organization,
            authority_id: &authority_id,
            ca: &ca,
            request: &issue_request,
            renew_before_seconds: request
                .renew_before_seconds
                .unwrap_or(opensesame_lifecycle::DEFAULT_RENEW_BEFORE_SECONDS),
            actor,
            renewed_from: None,
        },
        material,
        &metadata,
    )
    .await?;
    let row = issued.certificate;
    facts::note(
        state,
        &row.id,
        Fact::Issued {
            certificate_id: row.id.clone(),
            at: Utc::now(),
        },
    )
    .await;
    // `issued.material` — the one copy of the private key outside custody —
    // is dropped here, unread. The view below is public material only.
    Ok(TransportIssuance {
        certificate_id: row.id,
        purpose: shape.purpose,
        selector: shape.selector,
        leaf_thumbprint_sha256: thumbprint,
        not_before: row.not_before,
        not_after: row.expires_at,
        renew_before_seconds: row.renew_before_seconds,
        certificate_pem: issued.material.certificate,
        issuer_pem: issued.material.ca_certificate,
        managed: true,
    })
}

/// Parse a stored RFC 3339 time.
#[must_use]
pub fn parse_time(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}
