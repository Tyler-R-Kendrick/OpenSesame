//! Host-custody certificates: issuance, renewal, and the custody predicate
//! (ADR 0075).
//!
//! A *managed* certificate is one whose private key the host sealed and kept,
//! rather than handing to the caller in a one-time delivery. That single
//! difference is what makes unattended renewal possible at all: the delivery
//! model has a recipient waiting to acknowledge a key, and a background
//! responder is nobody.
//!
//! Custody is not a label on the certificate row. It is the presence of a
//! `managed_certificate_keys` row, because that is the same fact renewal
//! actually depends on — the host can only reissue what it can still open.
//!
//! Everything here is HTTP-free on purpose. The route layer and the lifecycle
//! responder call the same functions, so a certificate renewed by the hook and
//! one renewed by an operator go through identical code.

use chrono::{DateTime, Duration, Utc};
use opensesame_connection_broker::crypto::{open_scoped, seal_scoped, SealedBlob};
use opensesame_domain::OrganizationId;
use opensesame_storage::{
    seal_scopes, SealedCertificateMaterial, StoredCertificateIssuanceRequest,
    StoredManagedCertificate, StoredManagedCertificateKey,
};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::app_state::AppState;
use crate::dev_pki::{self, DevCa, IssuedCert};

/// Sealing key id recorded on custody blobs, matching the certificate routes.
pub const KEY_ID: &str = "opensesame-connection-key:v1";
/// How long a custody issuance request stays completable.
const REQUEST_TTL_MINUTES: i64 = 5;
/// Shortest renewal lead a caller may configure (one hour).
pub const MIN_RENEW_BEFORE_SECONDS: i64 = 3_600;

/// Shortest certificate lifetime host custody will accept.
///
/// Unattended renewal only converges if a renewed certificate is *not*
/// immediately due again, which needs a lifetime with room for a renewal
/// window inside it — see [`converging_renew_before`].
pub const MIN_MANAGED_LIFETIME_SECONDS: i64 = 2 * MIN_RENEW_BEFORE_SECONDS;

/// Why a custody operation could not be carried out.
///
/// Typed rather than an `axum::Response` so the lifecycle responder can report
/// the reason on the hook feed instead of discarding an HTTP body.
#[derive(Debug, thiserror::Error)]
pub enum CustodyError {
    #[error("certificate key protection is unavailable")]
    SealingUnavailable,
    #[error("no active internal certificate authority")]
    NoAuthority,
    #[error("certificate not found")]
    NotFound,
    #[error("the host does not hold this certificate's private key")]
    NotInCustody,
    #[error("certificate is not active")]
    NotActive,
    #[error("issuance request was superseded before it completed")]
    Superseded,
    #[error(
        "host custody needs a lifetime of at least {MIN_MANAGED_LIFETIME_SECONDS} seconds so a renewed certificate is not immediately due again"
    )]
    LifetimeTooShort,
    #[error("{0}")]
    Mint(String),
    #[error(transparent)]
    Storage(#[from] anyhow::Error),
}

impl CustodyError {
    /// Stable machine code for HTTP callers and hook payload details.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::SealingUnavailable => "certificate_key_protection_unavailable",
            Self::NoAuthority => "no_certificate_authority",
            Self::NotFound => "not_found",
            Self::NotInCustody => "not_in_custody",
            Self::NotActive => "certificate_not_active",
            Self::Superseded => "issuance_superseded",
            Self::LifetimeTooShort => "lifetime_too_short",
            Self::Mint(_) => "invalid_request",
            Self::Storage(_) => "internal",
        }
    }

    /// HTTP status a route should answer with.
    #[must_use]
    pub const fn http_status(&self) -> u16 {
        match self {
            Self::SealingUnavailable => 503,
            Self::NoAuthority | Self::NotInCustody | Self::NotActive | Self::Superseded => 409,
            Self::NotFound => 404,
            Self::LifetimeTooShort | Self::Mint(_) => 400,
            Self::Storage(_) => 500,
        }
    }
}

/// A certificate the host holds the key for, with the freshly minted material.
///
/// `material` is returned so a *first* issuance can still hand the requester
/// what they need to deploy. A renewal drops it on the floor: nobody is waiting.
pub struct ManagedIssuance {
    pub certificate: StoredManagedCertificate,
    pub material: IssuedCert,
}

fn sealing_key(state: &AppState) -> Result<[u8; 32], CustodyError> {
    state
        .connection_broker
        .config()
        .key()
        .copied()
        .ok_or(CustodyError::SealingUnavailable)
}

/// Whether the host still holds this certificate's private key.
///
/// # Errors
///
/// Returns an error when the lookup fails.
pub async fn is_in_custody(
    state: &AppState,
    organization: &str,
    certificate_id: &str,
) -> anyhow::Result<bool> {
    Ok(state
        .db
        .get_managed_certificate_key(organization, certificate_id)
        .await?
        .is_some())
}

fn san_document(request: &dev_pki::IssueRequest) -> String {
    json!({
        "dns_names": request.dns_names,
        "ip_addrs": request.ip_addrs.iter().map(ToString::to_string).collect::<Vec<_>>(),
    })
    .to_string()
}

/// Fingerprint of one custody issuance request.
///
/// The request id is part of the hash, and has to be: a renewal asks for the
/// *same* subject and SANs as the certificate it replaces, so a content-only
/// digest collides with its own predecessor against
/// `UNIQUE(organization_id, request_digest)`. The digest still commits to what
/// was asked for — it just also says which asking it was.
fn custody_digest(
    organization: &str,
    authority_id: &str,
    request_id: &str,
    request: &dev_pki::IssueRequest,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"opensesame:managed-certificate:v1\0");
    hasher.update(organization.as_bytes());
    hasher.update(b"\0");
    hasher.update(authority_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(request_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(request.common_name.as_bytes());
    for name in &request.dns_names {
        hasher.update(b"\0dns:");
        hasher.update(name.as_bytes());
    }
    for ip in &request.ip_addrs {
        hasher.update(b"\0ip:");
        hasher.update(ip.to_string().as_bytes());
    }
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

/// The renewal lead a certificate of `lifetime` can actually carry.
///
/// Two bounds, and the upper one is load-bearing rather than tidy. A lead at
/// least as long as the lifetime means the renewal window is open the instant
/// the certificate is signed — so its replacement is due immediately too, and
/// the responder reissues on every single tick, forever. Capping the lead at
/// half the lifetime guarantees a successor spends at least half its life
/// outside the window, which is what makes unattended renewal terminate.
///
/// The lower bound keeps the lead longer than the scanner's own tick, so the
/// rung is not crossed and acted on in the same pass that first sees it.
///
/// # Errors
///
/// Returns [`CustodyError::LifetimeTooShort`] when the lifetime has no room
/// for a window at all.
pub fn converging_renew_before(
    requested_seconds: i64,
    lifetime_seconds: i64,
) -> Result<i64, CustodyError> {
    if lifetime_seconds < MIN_MANAGED_LIFETIME_SECONDS {
        return Err(CustodyError::LifetimeTooShort);
    }
    let ceiling = lifetime_seconds / 2;
    Ok(requested_seconds.clamp(MIN_RENEW_BEFORE_SECONDS, ceiling))
}

/// Issue a certificate the host keeps the key for.
///
/// `renew_before_seconds` is put through [`converging_renew_before`], so a
/// requested lead can never be long enough to make the certificate's own
/// replacement immediately due.
///
/// # Errors
///
/// Returns [`CustodyError`] when sealing is unavailable, the lifetime is too
/// short to renew unattended, the leaf will not mint, or the request is
/// superseded before it completes.
/// Everything one host-custody issuance needs that is not the gateway itself.
///
/// Grouped into a struct rather than passed as eight positional arguments,
/// which is both what Clippy objects to and genuinely easy to get wrong: two
/// of them are `&str` and mixing them up would file a certificate under the
/// wrong authority.
pub struct ManagedRequest<'a> {
    pub organization: &'a OrganizationId,
    pub authority_id: &'a str,
    pub ca: &'a DevCa,
    pub request: &'a dev_pki::IssueRequest,
    pub renew_before_seconds: i64,
    pub actor: &'a str,
    /// The certificate this one replaces, when it is a renewal.
    pub renewed_from: Option<&'a str>,
}

pub async fn issue_managed(
    state: &AppState,
    spec: &ManagedRequest<'_>,
) -> Result<ManagedIssuance, CustodyError> {
    let key = sealing_key(state)?;
    let lifetime = i64::try_from(spec.request.ttl.as_secs()).unwrap_or(i64::MAX);
    let renew_before_seconds = converging_renew_before(spec.renew_before_seconds, lifetime)?;
    let organization = spec.organization.to_string();
    let now = Utc::now();
    let san_json = san_document(spec.request);

    let request_id = open_issuance_request(state, spec, &organization, &san_json, now).await?;
    let material = dev_pki::issue_leaf(spec.ca, spec.request).map_err(CustodyError::Mint)?;

    let certificate_id = format!("certificate:{}", uuid::Uuid::new_v4());
    let sealed = seal_scoped(
        &key,
        seal_scopes::MANAGED_LEAF_KEY,
        &certificate_id,
        &organization,
        material.private_key.as_bytes(),
    )
    .map_err(|error| CustodyError::Storage(anyhow::anyhow!("{error}")))?;

    let stamp = now.to_rfc3339();
    let certificate = StoredManagedCertificate {
        id: certificate_id.clone(),
        organization_id: organization.clone(),
        authority_id: spec.authority_id.into(),
        request_id: request_id.clone(),
        certificate_digest: format!(
            "sha256:{}",
            hex::encode(Sha256::digest(material.certificate.as_bytes()))
        ),
        serial_number: material.serial.clone(),
        common_name: material.common_name.clone(),
        san_json,
        not_before: material.not_before.clone(),
        expires_at: material.not_after.clone(),
        status: "active".into(),
        application_id: None,
        profile_id: None,
        source: "issued".into(),
        enrollment_method: Some("api".into()),
        metadata_json: "{}".into(),
        key_algorithm: None,
        signature_algorithm: None,
        fingerprint_sha256: None,
        chain_pem: Some(material.ca_certificate.clone()),
        renewed_from_id: spec.renewed_from.map(str::to_string),
        renewed_by_id: None,
        auto_renew_enabled: true,
        renew_before_seconds: Some(renew_before_seconds),
        revocation_reason: None,
        revoked_at: None,
        version: 1,
        created_at: stamp.clone(),
        updated_at: stamp.clone(),
    };
    let sealed_key = StoredManagedCertificateKey {
        id: format!("managed-key:{certificate_id}"),
        organization_id: organization.clone(),
        certificate_id,
        sealed_key: SealedCertificateMaterial {
            key_id: KEY_ID.into(),
            ciphertext: sealed.ciphertext,
            nonce: sealed.nonce,
            aad_digest: sealed.aad_digest,
        },
        version: 1,
        created_at: stamp.clone(),
        updated_at: stamp,
    };

    if !state
        .db
        .complete_managed_certificate_issuance(
            &organization,
            &request_id,
            1,
            "created",
            &certificate,
            &sealed_key,
        )
        .await?
    {
        return Err(CustodyError::Superseded);
    }
    Ok(ManagedIssuance {
        certificate,
        material,
    })
}

/// Record the issuance request this certificate will be filed against.
///
/// Every certificate row needs its own: `request_id` is NOT NULL behind a
/// unique foreign key, so a renewal is auditable as a request in exactly the
/// way a first issuance is.
async fn open_issuance_request(
    state: &AppState,
    spec: &ManagedRequest<'_>,
    organization: &str,
    san_json: &str,
    now: DateTime<Utc>,
) -> Result<String, CustodyError> {
    let request_id = format!("certificate-request:{}", uuid::Uuid::new_v4());
    let stored_request = StoredCertificateIssuanceRequest {
        id: request_id.clone(),
        organization_id: organization.to_string(),
        authority_id: spec.authority_id.into(),
        request_digest: custody_digest(organization, spec.authority_id, &request_id, spec.request),
        idempotency_key: format!("managed:{request_id}"),
        created_by: spec.actor.into(),
        state: "created".into(),
        common_name: spec.request.common_name.clone(),
        san_json: san_json.to_string(),
        delivery: None,
        expires_at: (now + Duration::minutes(REQUEST_TTL_MINUTES)).to_rfc3339(),
        version: 1,
        created_at: now.to_rfc3339(),
        updated_at: now.to_rfc3339(),
    };
    if state
        .db
        .insert_certificate_issuance_request(&stored_request)
        .await?
    {
        Ok(request_id)
    } else {
        Err(CustodyError::Superseded)
    }
}

/// Open a managed certificate's private key.
///
/// Human- and operator-gated at the route; never reachable from an agent
/// surface. Returns the PEM so an operator can redeploy after a renewal.
///
/// # Errors
///
/// Returns [`CustodyError`] when the certificate is unknown, the host does not
/// hold its key, or the sealed blob will not open.
pub async fn reveal_managed_key(
    state: &AppState,
    organization: &str,
    certificate_id: &str,
) -> Result<String, CustodyError> {
    let key = sealing_key(state)?;
    state
        .db
        .get_certificate(organization, certificate_id)
        .await?
        .ok_or(CustodyError::NotFound)?;
    let held = state
        .db
        .get_managed_certificate_key(organization, certificate_id)
        .await?
        .ok_or(CustodyError::NotInCustody)?;
    if held.sealed_key.key_id != KEY_ID {
        return Err(CustodyError::SealingUnavailable);
    }
    let plaintext = open_scoped(
        &key,
        seal_scopes::MANAGED_LEAF_KEY,
        certificate_id,
        organization,
        &SealedBlob {
            ciphertext: held.sealed_key.ciphertext.clone(),
            nonce: held.sealed_key.nonce.clone(),
            aad_digest: held.sealed_key.aad_digest.clone(),
        },
    )
    .map_err(|error| CustodyError::Storage(anyhow::anyhow!("{error}")))?;
    String::from_utf8(plaintext)
        .map_err(|_| CustodyError::Storage(anyhow::anyhow!("managed key is not valid UTF-8")))
}

fn parse_time(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|time| time.with_timezone(&Utc))
}

/// The lifetime to give a renewal: the same span the predecessor had.
///
/// Renewing to a *fixed* default would silently shorten or lengthen a
/// certificate's life the first time it rolled over, which is the kind of
/// change nobody asks for and everybody notices later.
fn inherited_ttl(previous: &StoredManagedCertificate) -> std::time::Duration {
    let span = parse_time(&previous.not_before)
        .zip(parse_time(&previous.expires_at))
        .map(|(from, to)| to.signed_duration_since(from));
    span.and_then(|span| span.to_std().ok())
        .filter(|span| !span.is_zero())
        .unwrap_or(dev_pki::DEFAULT_TTL)
}

/// Reissue a certificate the host holds the key for.
///
/// The successor inherits the predecessor's subject, SANs, validity span, and
/// renewal lead, then the two are linked in both directions and the
/// predecessor is retired — which also drops it out of the expiry sweep, so
/// the scanner stops warning about a deadline that no longer matters.
///
/// # Errors
///
/// Returns [`CustodyError::NotInCustody`] when the host does not hold the
/// key — the case that makes unattended renewal impossible rather than merely
/// unimplemented — and the other variants as their names say.
pub async fn renew_managed(
    state: &AppState,
    organization: &OrganizationId,
    certificate_id: &str,
) -> Result<StoredManagedCertificate, CustodyError> {
    let organization_text = organization.to_string();
    let previous = state
        .db
        .get_certificate(&organization_text, certificate_id)
        .await?
        .ok_or(CustodyError::NotFound)?;
    if previous.status != "active" {
        return Err(CustodyError::NotActive);
    }
    if !is_in_custody(state, &organization_text, certificate_id).await? {
        return Err(CustodyError::NotInCustody);
    }

    let key = sealing_key(state)?;
    let (authority_id, ca) =
        load_authority(state, &organization_text, &previous.authority_id, &key).await?;

    let request = dev_pki::IssueRequest {
        common_name: previous.common_name.clone(),
        dns_names: san_names(&previous.san_json),
        ip_addrs: san_ips(&previous.san_json),
        ttl: inherited_ttl(&previous),
    };
    let renewed = issue_managed(
        state,
        &ManagedRequest {
            organization,
            authority_id: &authority_id,
            ca: &ca,
            request: &request,
            renew_before_seconds: previous
                .renew_before_seconds
                .unwrap_or(opensesame_lifecycle::DEFAULT_RENEW_BEFORE_SECONDS),
            actor: "lifecycle-responder",
            renewed_from: Some(certificate_id),
        },
    )
    .await?;

    state
        .db
        .insert_renewal_link(&organization_text, certificate_id, &renewed.certificate.id)
        .await?;
    state
        .db
        .mark_certificate_renewed(&organization_text, certificate_id)
        .await?;
    // The predecessor is no longer a subject; forget where it sat on the
    // ladder so nothing can inherit a stale rung.
    state
        .db
        .clear_lifecycle_watermarks(&organization_text, "certificate", certificate_id)
        .await?;
    Ok(renewed.certificate)
}

/// Seal scope for a persisted certificate authority, matching the certificate
/// routes so an authority sealed by one is openable by the other.
const CA_SCOPE: &str = "certificate_authority";

/// Load the signing authority a renewal should use.
///
/// The predecessor's own authority first, so a renewal keeps signing under the
/// chain its consumers already trust; the organization's active internal
/// authority only if that one is gone or retired. An authority whose sealed
/// material will not open is a refusal, never a silent fall-through to a
/// different signer — that would quietly re-root somebody's trust.
async fn load_authority(
    state: &AppState,
    organization: &str,
    preferred_id: &str,
    key: &[u8; 32],
) -> Result<(String, DevCa), CustodyError> {
    let authorities = state.db.list_certificate_authorities(organization).await?;
    let chosen = authorities
        .iter()
        .find(|authority| authority.id == preferred_id && authority.status == "active")
        .or_else(|| {
            authorities
                .iter()
                .find(|authority| authority.status == "active")
        })
        .ok_or(CustodyError::NoAuthority)?;
    if chosen.sealed_material.key_id != KEY_ID {
        return Err(CustodyError::SealingUnavailable);
    }
    let plaintext = open_scoped(
        key,
        CA_SCOPE,
        &chosen.id,
        organization,
        &SealedBlob {
            ciphertext: chosen.sealed_material.ciphertext.clone(),
            nonce: chosen.sealed_material.nonce.clone(),
            aad_digest: chosen.sealed_material.aad_digest.clone(),
        },
    )
    .map_err(|error| CustodyError::Storage(anyhow::anyhow!("open authority: {error}")))?;
    let ca: DevCa = serde_json::from_slice(&plaintext)
        .map_err(|error| CustodyError::Storage(anyhow::anyhow!("decode authority: {error}")))?;
    dev_pki::validate_ca(&ca).map_err(CustodyError::Mint)?;
    Ok((chosen.id.clone(), ca))
}

fn san_names(san_json: &str) -> Vec<String> {
    serde_json::from_str::<serde_json::Value>(san_json)
        .ok()
        .and_then(|document| {
            document.get("dns_names")?.as_array().map(|names| {
                names
                    .iter()
                    .filter_map(|n| n.as_str().map(str::to_string))
                    .collect()
            })
        })
        .unwrap_or_default()
}

fn san_ips(san_json: &str) -> Vec<std::net::IpAddr> {
    serde_json::from_str::<serde_json::Value>(san_json)
        .ok()
        .and_then(|document| {
            document.get("ip_addrs")?.as_array().map(|addrs| {
                addrs
                    .iter()
                    .filter_map(|addr| addr.as_str()?.parse().ok())
                    .collect()
            })
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn certificate(not_before: &str, expires_at: &str) -> StoredManagedCertificate {
        StoredManagedCertificate {
            id: "certificate:1".into(),
            organization_id: "org:1".into(),
            authority_id: "ca:1".into(),
            request_id: "request:1".into(),
            certificate_digest: "sha256:x".into(),
            serial_number: "01".into(),
            common_name: "api.example".into(),
            san_json: r#"{"dns_names":["api.example","alt.example"],"ip_addrs":["10.0.0.1"]}"#
                .into(),
            not_before: not_before.into(),
            expires_at: expires_at.into(),
            status: "active".into(),
            application_id: None,
            profile_id: None,
            source: "issued".into(),
            enrollment_method: Some("api".into()),
            metadata_json: "{}".into(),
            key_algorithm: None,
            signature_algorithm: None,
            fingerprint_sha256: None,
            chain_pem: None,
            renewed_from_id: None,
            renewed_by_id: None,
            auto_renew_enabled: true,
            renew_before_seconds: Some(86_400),
            revocation_reason: None,
            revoked_at: None,
            version: 1,
            created_at: "2026-08-01T00:00:00+00:00".into(),
            updated_at: "2026-08-01T00:00:00+00:00".into(),
        }
    }

    #[test]
    fn a_renewal_inherits_the_span_it_replaces() {
        let previous = certificate("2026-08-01T00:00:00+00:00", "2026-08-31T00:00:00+00:00");
        assert_eq!(inherited_ttl(&previous).as_secs(), 30 * 86_400);
    }

    #[test]
    fn an_unreadable_span_falls_back_rather_than_minting_a_zero_life_certificate() {
        for (from, to) in [
            ("not a time", "2026-08-31T00:00:00+00:00"),
            ("2026-08-01T00:00:00+00:00", "not a time"),
            // A backwards or zero-length span would otherwise produce a
            // certificate that is expired the moment it is signed.
            ("2026-08-31T00:00:00+00:00", "2026-08-01T00:00:00+00:00"),
            ("2026-08-01T00:00:00+00:00", "2026-08-01T00:00:00+00:00"),
        ] {
            assert_eq!(
                inherited_ttl(&certificate(from, to)),
                dev_pki::DEFAULT_TTL,
                "{from} -> {to}",
            );
        }
    }

    #[test]
    fn sans_round_trip_through_the_stored_document() {
        let previous = certificate("2026-08-01T00:00:00+00:00", "2026-08-31T00:00:00+00:00");
        assert_eq!(
            san_names(&previous.san_json),
            ["api.example", "alt.example"]
        );
        assert_eq!(
            san_ips(&previous.san_json),
            vec!["10.0.0.1".parse::<std::net::IpAddr>().unwrap()],
        );
    }

    #[test]
    fn a_malformed_san_document_yields_no_names_rather_than_a_panic() {
        assert!(san_names("not json").is_empty());
        assert!(san_ips("not json").is_empty());
        assert!(san_names(r#"{"dns_names":"not-an-array"}"#).is_empty());
        assert!(san_ips(r#"{"ip_addrs":["not-an-ip"]}"#).is_empty());
    }

    #[test]
    fn custody_errors_carry_a_stable_code_and_status() {
        for (error, code, status) in [
            (CustodyError::NotInCustody, "not_in_custody", 409),
            (CustodyError::NotFound, "not_found", 404),
            (CustodyError::NotActive, "certificate_not_active", 409),
            (
                CustodyError::SealingUnavailable,
                "certificate_key_protection_unavailable",
                503,
            ),
            (CustodyError::Mint("bad cn".into()), "invalid_request", 400),
        ] {
            assert_eq!(error.code(), code);
            assert_eq!(error.http_status(), status);
        }
    }

    #[test]
    fn the_renewal_lead_is_clamped_away_from_the_scanner_tick() {
        // A lead shorter than a tick makes the renewal rung a coin flip.
        let day = 86_400;
        assert_eq!(
            converging_renew_before(60, day).unwrap(),
            MIN_RENEW_BEFORE_SECONDS
        );
    }

    #[test]
    fn a_lead_can_never_reach_the_lifetime_it_sits_inside() {
        // The loop this prevents: a lead >= the lifetime makes every successor
        // due the moment it is signed, so the responder reissues every tick.
        for lifetime in [MIN_MANAGED_LIFETIME_SECONDS, 86_400, 90 * 86_400] {
            let lead = converging_renew_before(lifetime * 10, lifetime).unwrap();
            assert!(
                lead <= lifetime / 2,
                "lead {lead} must leave room inside {lifetime}",
            );
            assert!(
                lifetime - lead >= lead,
                "a successor must spend at least as long outside the window as inside it",
            );
        }
    }

    #[test]
    fn a_lifetime_with_no_room_for_a_window_is_refused() {
        for lifetime in [0, 60, MIN_MANAGED_LIFETIME_SECONDS - 1] {
            let refused = converging_renew_before(MIN_RENEW_BEFORE_SECONDS, lifetime);
            assert!(
                matches!(refused, Err(CustodyError::LifetimeTooShort)),
                "{lifetime}"
            );
        }
        assert!(
            converging_renew_before(MIN_RENEW_BEFORE_SECONDS, MIN_MANAGED_LIFETIME_SECONDS).is_ok()
        );
    }

    #[test]
    fn a_requested_lead_inside_the_ceiling_is_honoured() {
        assert_eq!(
            converging_renew_before(6 * 3_600, 86_400).unwrap(),
            6 * 3_600
        );
    }
}
