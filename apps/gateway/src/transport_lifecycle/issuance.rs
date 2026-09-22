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
use opensesame_pki_core::policy::{self, PolicyCandidate, PolicyViolation};
use opensesame_pki_core::{
    BasicConstraints, ExtendedKeyUsage, KeyAlgorithm, KeyUsage, PolicyPreset, SanEntry,
    SignatureAlgorithm, SubjectDn,
};
use opensesame_storage::StoredManagedCertificate;
use rcgen::{
    CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, Ia5String, KeyPair,
    KeyUsagePurpose, SanType, SerialNumber, PKCS_ECDSA_P256_SHA256,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

use crate::app_state::AppState;
use crate::dev_pki::{DevCa, IssueRequest, IssuedCert};
use crate::managed_certs::{self, CustodyError, ManagedRequest};
use crate::managed_certs_tls::TransportPurpose;
use crate::transport_lifecycle::facts::{self, Fact};

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

/// The leaf shape a purpose and selector imply.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LeafShape {
    pub purpose: TransportPurpose,
    pub selector: PeerIdentitySelector,
    pub server_auth: bool,
    pub client_auth: bool,
}

impl LeafShape {
    /// Derive the shape, refusing every selector kind but DNS and SPIFFE.
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` for a malformed or unsupported selector.
    pub fn derive(
        purpose: TransportPurpose,
        selector: PeerIdentitySelector,
    ) -> Result<Self, TransportError> {
        selector.validate()?;
        let spiffe = match &selector {
            PeerIdentitySelector::SpiffeId(_) => true,
            PeerIdentitySelector::DnsName(_) => false,
            PeerIdentitySelector::UriSan(_) | PeerIdentitySelector::LeafThumbprintSha256(_) => {
                return Err(TransportError::malformed(
                    "transport issuance takes a dns_name or spiffe_id selector",
                ))
            }
        };
        Ok(Self {
            purpose,
            selector,
            // A SPIFFE X.509-SVID carries both EKUs; a private-PKI listener
            // needs both to serve and to probe; a client gets clientAuth only.
            server_auth: spiffe || purpose.is_listener(),
            client_auth: true,
        })
    }

    fn preset(&self) -> PolicyPreset {
        match (&self.selector, self.purpose.is_listener()) {
            (PeerIdentitySelector::SpiffeId(_), _) => PolicyPreset::Device,
            (_, true) => PolicyPreset::DualPurposeServer,
            (_, false) => PolicyPreset::TlsClient,
        }
    }

    fn ekus(&self) -> Vec<ExtendedKeyUsage> {
        let mut out = Vec::new();
        if self.server_auth {
            out.push(ExtendedKeyUsage::ServerAuth);
        }
        if self.client_auth {
            out.push(ExtendedKeyUsage::ClientAuth);
        }
        out
    }

    fn common_name(&self) -> String {
        match &self.selector {
            PeerIdentitySelector::DnsName(name) => name.clone(),
            other => format!("workload-{}", &short_digest(other.value())[..16]),
        }
    }

    /// Check the shape and lifetime against the matching policy preset.
    ///
    /// # Errors
    ///
    /// Every violation the preset produced.
    pub fn check_policy(&self, validity_seconds: u64) -> Result<(), Vec<PolicyViolation>> {
        let sans = match &self.selector {
            PeerIdentitySelector::DnsName(name) => vec![SanEntry::Dns(name.clone())],
            other => vec![SanEntry::Uri(other.value().to_owned())],
        };
        let candidate = PolicyCandidate {
            subject: SubjectDn::common_name(self.common_name()),
            sans,
            key_algorithm: Some(KeyAlgorithm::EcdsaP256),
            signature_algorithm: Some(SignatureAlgorithm::Sha256Ecdsa),
            key_usages: vec![KeyUsage::DigitalSignature],
            ext_key_usages: self.ekus(),
            basic_constraints: Some(BasicConstraints {
                ca: false,
                max_path_len: None,
            }),
            ttl_seconds: Some(validity_seconds),
        };
        policy::evaluate_with_max_validity(
            &policy::preset(self.preset()),
            Some(MAX_VALIDITY_SECONDS),
            &candidate,
        )
    }
}

fn short_digest(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn rfc3339(at: OffsetDateTime) -> Result<String, String> {
    at.format(&Rfc3339).map_err(|error| error.to_string())
}

/// SHA-256 of the first certificate in `pem`, lowercase hex.
///
/// # Errors
///
/// A message when the PEM does not hold a certificate.
pub fn leaf_thumbprint(pem: &str) -> Result<String, String> {
    let (_, block) =
        x509_parser::pem::parse_x509_pem(pem.as_bytes()).map_err(|error| error.to_string())?;
    if block.label != "CERTIFICATE" {
        return Err("not a certificate PEM block".into());
    }
    Ok(hex::encode(Sha256::digest(&block.contents)))
}

/// Mint a leaf of `shape` under `ca`, valid for `ttl`.
///
/// # Errors
///
/// A message when the authority is unusable or signing fails.
pub fn mint_leaf(ca: &DevCa, shape: &LeafShape, ttl: Duration) -> Result<IssuedCert, String> {
    crate::dev_pki::validate_ca(ca)?;
    let ca_key = KeyPair::from_pem(&ca.key_pem).map_err(|e| e.to_string())?;
    let ca_params = CertificateParams::from_ca_cert_pem(&ca.cert_pem).map_err(|e| e.to_string())?;
    let issuer = ca_params.self_signed(&ca_key).map_err(|e| e.to_string())?;
    let common_name = shape.common_name();
    let dns_names: Vec<String> = match &shape.selector {
        PeerIdentitySelector::DnsName(name) => vec![name.clone()],
        _ => Vec::new(),
    };
    let mut params = CertificateParams::new(dns_names.clone()).map_err(|e| e.to_string())?;
    params.distinguished_name = DistinguishedName::new();
    params
        .distinguished_name
        .push(DnType::CommonName, common_name.clone());
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = Vec::new();
    if shape.server_auth {
        params
            .extended_key_usages
            .push(ExtendedKeyUsagePurpose::ServerAuth);
    }
    if shape.client_auth {
        params
            .extended_key_usages
            .push(ExtendedKeyUsagePurpose::ClientAuth);
    }
    if let PeerIdentitySelector::SpiffeId(id) = &shape.selector {
        let uri = Ia5String::try_from(id.as_str()).map_err(|e| e.to_string())?;
        params.subject_alt_names.push(SanType::URI(uri));
    }
    params.serial_number = Some(SerialNumber::from_slice(
        &uuid::Uuid::new_v4().as_bytes()[..],
    ));
    let not_before = OffsetDateTime::now_utc() - time::Duration::minutes(1);
    let not_after = OffsetDateTime::now_utc()
        + time::Duration::seconds(i64::try_from(ttl.as_secs()).unwrap_or(i64::MAX));
    params.not_before = not_before;
    params.not_after = not_after;
    let serial = params
        .serial_number
        .as_ref()
        .map(|number| hex::encode(number.to_bytes()))
        .unwrap_or_default();
    let leaf_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(|e| e.to_string())?;
    let cert = params
        .signed_by(&leaf_key, &issuer, &ca_key)
        .map_err(|e| e.to_string())?;
    Ok(IssuedCert {
        certificate: cert.pem(),
        private_key: leaf_key.serialize_pem(),
        ca_certificate: ca.cert_pem.clone(),
        serial,
        common_name,
        dns_names,
        not_before: rfc3339(not_before)?,
        not_after: rfc3339(not_after)?,
    })
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
