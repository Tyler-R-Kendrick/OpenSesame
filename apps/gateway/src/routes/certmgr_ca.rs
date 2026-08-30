//! Certificate Manager — certificate authority management (plan §5.6,
//! [ADR 0066](../../../../docs/adr/0066-certificate-manager-domain-model.md)
//! domain model, [ADR 0067](../../../../docs/adr/0067-certificate-revocation-crl-ocsp.md)
//! revocation).
//!
//! Roots and intermediates are created, exported for external signing,
//! re-imported, renewed and re-configured here. Every X.509 decision — key
//! generation, self-signing, subordinate signing, the `basicConstraints`
//! budget, chain normalization — is delegated to `opensesame_pki_core`; this
//! module is authorization, org scoping, sealed custody, persistence and
//! projection only.
//!
//! # Secrecy invariant
//!
//! An authority's private key exists in this module in exactly two shapes: a
//! `pki_core::KeyPair` (not `Clone`, not `Serialize`, redacted `Debug`) held
//! for the duration of one request, and a sealed blob produced by
//! [`seal_scoped`] under the [`CA_SCOPE`] scope, bound to the authority id and
//! the owning organization as additional authenticated data. No projection in
//! this module — [`ca_view`], [`signing_config_view`] or an error body —
//! renders key material, and the sealed columns are never echoed either. The
//! only route that returns a PEM document is [`export_csr`], and a PKCS#10
//! certificate signing request is public material.
//!
//! # Org scoping
//!
//! Every handler resolves the caller's organization first and passes it to
//! every storage call. An authority belonging to another organization is
//! reported as absent (404), never as forbidden (403), so the routes are not
//! an existence oracle.
//!
//! # Scope of `issuer_kind`
//!
//! These routes own authorities stamped [`CERTMGR_ISSUER`]. The legacy
//! `opensesame_private_ca` rows written by `routes::certs` seal a different
//! document shape, so they are invisible here rather than being opened with
//! the wrong reader.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use opensesame_connection_broker::crypto::{open_scoped, seal_scoped, SealedBlob};
use opensesame_pki_core::{
    bundle, ca,
    ca::{CaFacts, CaParams},
    csr, keys, KeyAlgorithm, KeyPair, PkiError, SubjectDn,
};
use opensesame_storage::{
    SealedCertificateMaterial, StoredCaSigningConfig, StoredCertificateAuthority,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use time::OffsetDateTime;

use crate::app_state::AppState;
use crate::middleware::auth::{resolve_caller, resolve_caller_organization, Caller};

/// `issuer_kind` stamped on every authority these routes own.
pub const CERTMGR_ISSUER: &str = "opensesame_certmgr";
/// Seal scope for certificate authority private keys (plan §4.5 — the
/// pre-existing scope shared with `routes::certs`).
const CA_SCOPE: &str = "certificate_authority";
/// Sealing key identifier recorded alongside every sealed blob.
const KEY_ID: &str = "opensesame-connection-key:v1";

/// Largest number of CRL mirror URLs an authority may advertise.
const MAX_CRL_MIRRORS: usize = 4;
/// Largest number of CRL distribution points embedded in a CA certificate.
const MAX_DISTRIBUTION_POINTS: usize = 8;
/// Largest accepted URL length for a mirror or distribution point.
const MAX_URL_LEN: usize = 512;
/// Largest accepted length of one subject distinguished-name attribute.
const MAX_SUBJECT_FIELD: usize = 64;
/// Largest accepted number of `domainComponent` values in a subject.
const MAX_DC_COMPONENTS: usize = 4;
/// Largest accepted display name.
const MAX_DISPLAY_NAME: usize = 128;
/// Largest accepted validity window, in days (a century).
const MAX_VALIDITY_DAYS: i64 = 36_525;
/// Default validity for a new root, in days.
const DEFAULT_ROOT_DAYS: i64 = 3650;
/// Default validity for a new subordinate, in days.
const DEFAULT_INTERMEDIATE_DAYS: i64 = 1825;
/// Backdating applied to `notBefore` so a freshly issued authority is not
/// rejected by a verifier whose clock trails ours.
const CLOCK_SKEW_MINUTES: i64 = 5;

/// Request body limit for every route in this module except `import-chain`.
pub const MAX_BODY: usize = 16 * 1024;
/// Request body limit for `POST /api/v1/certmgr/cas/{id}/import-chain`.
pub const MAX_IMPORT_BODY: usize = 512 * 1024;

/// Outbox event type for a created authority.
const EVENT_CREATED: &str = "certmgr.ca.created";
/// Outbox event type for a patched authority.
const EVENT_UPDATED: &str = "certmgr.ca.updated";
/// Outbox event type for an imported signed chain.
const EVENT_IMPORTED: &str = "certmgr.ca.imported";
/// Outbox event type for a renewed authority.
const EVENT_RENEWED: &str = "certmgr.ca.renewed";
/// Outbox event type for a patched signing configuration.
const EVENT_SIGNING_CONFIG: &str = "certmgr.ca.signing_config_updated";

// —— gates and error shapes ————————————————————————————————————————

/// Owner/admin gate, run before any `st.db` access in every handler.
fn require_configurator(
    st: &AppState,
    headers: &axum::http::HeaderMap,
) -> Result<Caller, Response> {
    let who = resolve_caller(st, headers)?;
    if !who.can_configure_integrations() {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "forbidden",
                "hint": "owner or admin role required to manage certificate authorities"
            })),
        )
            .into_response());
    }
    Ok(who)
}

/// Logs the cause and returns a body that never carries it.
fn internal(error: impl std::fmt::Display, context: &'static str) -> Response {
    tracing::error!(%error, %context, "certificate authority operation failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error":"internal","hint":"certificate authority operation failed"})),
    )
        .into_response()
}

fn bad_request(error: &str, hint: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error": error, "hint": hint})),
    )
        .into_response()
}

fn conflict(error: &str, hint: &str) -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({"error": error, "hint": hint})),
    )
        .into_response()
}

/// A missing authority and a foreign-organization authority are the same
/// answer: an existence oracle is a cross-tenant leak.
fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({
            "error": "not_found",
            "hint": "no certificate authority with that id in this organization"
        })),
    )
        .into_response()
}

fn sealing_unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({
            "error": "certificate_key_protection_unavailable",
            "hint": "set OPENSESAME_CONNECTION_KEY before managing certificate authorities"
        })),
    )
        .into_response()
}

/// Maps an engine error onto a caller-visible response.
///
/// Every failure the caller can provoke with bad input is a 400 carrying a
/// specific hint; only a backend failure the caller cannot influence becomes a
/// 500. In particular a refused `pathLenConstraint` budget is a 400, never a
/// 500.
fn pki_response(error: &PkiError, context: &'static str) -> Response {
    let (code, hint) = match error {
        PkiError::PathLenExceeded => (
            "path_len_exceeded",
            "the parent authority's basicConstraints budget does not permit this subordinate; lower path_len or pick a parent with a larger budget",
        ),
        PkiError::NotACertificateAuthority => (
            "not_a_certificate_authority",
            "the certificate is not a CA with keyCertSign; supply an authority certificate",
        ),
        PkiError::KeyMismatch => (
            "key_mismatch",
            "the certificate does not certify this authority's stored key",
        ),
        PkiError::ChainInvalid => (
            "chain_invalid",
            "each certificate must be signed by the one after it, leaf first",
        ),
        PkiError::InvalidPem => ("invalid_pem", "expected one or more PEM CERTIFICATE blocks"),
        PkiError::InvalidDer => ("invalid_der", "a certificate body could not be decoded"),
        PkiError::CsrParse => ("invalid_csr", "the certificate signing request is unusable"),
        PkiError::InvalidName => (
            "invalid_subject",
            "a subject attribute or distribution point cannot be encoded",
        ),
        PkiError::InvalidValidity => (
            "invalid_validity",
            "not_before must be strictly before not_after",
        ),
        PkiError::TooLarge => (
            "input_too_large",
            "the document exceeds the permitted size or certificate count",
        ),
        PkiError::UnsupportedAlgorithm | PkiError::UnknownEnumValue => (
            "unsupported_algorithm",
            "key_algorithm must be one of rsa-2048, rsa-4096, ecdsa-p256, ecdsa-p384",
        ),
        PkiError::NotYetSupported(_) => (
            "not_yet_supported",
            "this build cannot encode the requested certificate shape",
        ),
        _ => return internal(error, context),
    };
    bad_request(code, hint)
}

// —— sealed custody ————————————————————————————————————————————————

fn sealing_key(st: &AppState) -> Result<[u8; 32], Response> {
    st.connection_broker
        .config()
        .key()
        .copied()
        .ok_or_else(sealing_unavailable)
}

fn stored_material(blob: SealedBlob) -> SealedCertificateMaterial {
    SealedCertificateMaterial {
        key_id: KEY_ID.into(),
        ciphertext: blob.ciphertext,
        nonce: blob.nonce,
        aad_digest: blob.aad_digest,
    }
}

fn sealed_blob(material: &SealedCertificateMaterial) -> SealedBlob {
    SealedBlob {
        ciphertext: material.ciphertext.clone(),
        nonce: material.nonce.clone(),
        aad_digest: material.aad_digest.clone(),
    }
}

/// Seals `key`'s PKCS#8 document under the authority's identity.
fn seal_ca_key(
    sealing: &[u8; 32],
    authority_id: &str,
    organization: &str,
    key: &KeyPair,
) -> Result<SealedCertificateMaterial, Response> {
    let pem = key.private_key_pkcs8_pem();
    let blob = seal_scoped(
        sealing,
        CA_SCOPE,
        authority_id,
        organization,
        pem.as_bytes(),
    )
    .map_err(|error| internal(error, "seal certificate authority key"))?;
    Ok(stored_material(blob))
}

/// Opens the sealed key of `authority`, typed by its recorded algorithm.
fn open_ca_key(
    sealing: &[u8; 32],
    authority: &StoredCertificateAuthority,
    config: &StoredCaSigningConfig,
) -> Result<KeyPair, Response> {
    if authority.sealed_material.key_id != KEY_ID {
        return Err(conflict(
            "unsupported_sealing_key",
            "this authority was sealed with a key id this build cannot open",
        ));
    }
    let algorithm = parse_key_algorithm(&config.key_algorithm)?;
    let plaintext = open_scoped(
        sealing,
        CA_SCOPE,
        &authority.id,
        &authority.organization_id,
        &sealed_blob(&authority.sealed_material),
    )
    .map_err(|error| internal(error, "open certificate authority key"))?;
    let pem = String::from_utf8(plaintext)
        .map_err(|error| internal(error, "decode certificate authority key"))?;
    keys::from_pkcs8_pem(&pem, algorithm)
        .map_err(|error| internal(error, "import certificate authority key"))
}

// —— validation ————————————————————————————————————————————————————

/// Authority keys must be signing keys a CA can rotate and an HSM can hold.
/// Ed25519 is deliberately refused for authorities even though the engine can
/// generate it: too much of the deployed verifier population still rejects an
/// Ed25519 issuer.
fn parse_key_algorithm(value: &str) -> Result<KeyAlgorithm, Response> {
    match value {
        "rsa-2048" => Ok(KeyAlgorithm::Rsa2048),
        "rsa-4096" => Ok(KeyAlgorithm::Rsa4096),
        "ecdsa-p256" => Ok(KeyAlgorithm::EcdsaP256),
        "ecdsa-p384" => Ok(KeyAlgorithm::EcdsaP384),
        "ed25519" => Err(bad_request(
            "unsupported_ca_key_algorithm",
            "ed25519 is not accepted for a certificate authority; use ecdsa-p256, ecdsa-p384, rsa-2048 or rsa-4096",
        )),
        _ => Err(bad_request(
            "unsupported_ca_key_algorithm",
            "key_algorithm must be one of rsa-2048, rsa-4096, ecdsa-p256, ecdsa-p384",
        )),
    }
}

fn validate_subject(subject: &SubjectDn) -> Result<(), Response> {
    if subject.is_empty() {
        return Err(bad_request(
            "invalid_subject",
            "at least one subject attribute (cn, o, ou, c, st, l or dc) is required",
        ));
    }
    let fields = [
        &subject.cn,
        &subject.o,
        &subject.ou,
        &subject.c,
        &subject.st,
        &subject.l,
    ];
    for field in fields.into_iter().flatten() {
        if field.trim().is_empty() || field.chars().count() > MAX_SUBJECT_FIELD {
            return Err(bad_request(
                "invalid_subject",
                "each subject attribute must be non-blank and at most 64 characters",
            ));
        }
    }
    if subject.dc.len() > MAX_DC_COMPONENTS {
        return Err(bad_request(
            "invalid_subject",
            "at most four domainComponent values are accepted",
        ));
    }
    for component in &subject.dc {
        if component.trim().is_empty() || component.chars().count() > MAX_SUBJECT_FIELD {
            return Err(bad_request(
                "invalid_subject",
                "each domainComponent must be non-blank and at most 64 characters",
            ));
        }
    }
    Ok(())
}

/// Validates a list of `http(s)` URLs used as CRL mirrors or distribution
/// points. Any other scheme — `file:`, `ldap:`, `javascript:` — is refused.
fn validate_urls(urls: &[String], limit: usize, error: &str) -> Result<(), Response> {
    if urls.len() > limit {
        return Err(bad_request(
            error,
            "at most four CRL mirrors and eight distribution points are accepted",
        ));
    }
    for url in urls {
        let acceptable = (url.starts_with("https://") || url.starts_with("http://"))
            && url.len() <= MAX_URL_LEN
            && url.is_ascii()
            && !url.chars().any(char::is_whitespace);
        if !acceptable {
            return Err(bad_request(
                error,
                "each URL must be an ASCII http:// or https:// URL of at most 512 characters",
            ));
        }
    }
    Ok(())
}

fn validate_display_name(name: &str) -> Result<(), Response> {
    if name.trim().is_empty() || name.chars().count() > MAX_DISPLAY_NAME {
        return Err(bad_request(
            "invalid_display_name",
            "display_name must be non-blank and at most 128 characters",
        ));
    }
    Ok(())
}

/// Resolves the requested validity window into an absolute `notAfter`.
fn resolve_not_after(
    validity_days: Option<i64>,
    not_after: Option<&str>,
    default_days: i64,
) -> Result<DateTime<Utc>, Response> {
    let now = Utc::now();
    match (validity_days, not_after) {
        (Some(_), Some(_)) => Err(bad_request(
            "invalid_validity",
            "supply either validity_days or not_after, not both",
        )),
        (Some(days), None) => {
            if !(1..=MAX_VALIDITY_DAYS).contains(&days) {
                return Err(bad_request(
                    "invalid_validity",
                    "validity_days must be between 1 and 36525",
                ));
            }
            Ok(now + Duration::days(days))
        }
        (None, Some(raw)) => {
            let parsed = DateTime::parse_from_rfc3339(raw)
                .map_err(|_| {
                    bad_request("invalid_validity", "not_after must be an RFC3339 timestamp")
                })?
                .with_timezone(&Utc);
            if parsed <= now || parsed > now + Duration::days(MAX_VALIDITY_DAYS) {
                return Err(bad_request(
                    "invalid_validity",
                    "not_after must be in the future and within 36525 days",
                ));
            }
            Ok(parsed)
        }
        (None, None) => Ok(now + Duration::days(default_days)),
    }
}

fn to_offset(moment: DateTime<Utc>) -> Result<OffsetDateTime, Response> {
    OffsetDateTime::from_unix_timestamp(moment.timestamp())
        .map_err(|error| internal(error, "convert timestamp"))
}

fn from_offset(moment: OffsetDateTime) -> Option<String> {
    DateTime::from_timestamp(moment.unix_timestamp(), 0)
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Secs, true))
}

/// Assembles the engine parameters for a root or subordinate authority.
fn build_params(
    subject: SubjectDn,
    key_algorithm: KeyAlgorithm,
    not_after: DateTime<Utc>,
    path_len: Option<u8>,
    crl_distribution_points: Vec<String>,
) -> Result<CaParams, Response> {
    Ok(CaParams {
        subject,
        key_algorithm,
        not_before: to_offset(Utc::now() - Duration::minutes(CLOCK_SKEW_MINUTES))?,
        not_after: to_offset(not_after)?,
        path_len,
        crl_distribution_points,
    })
}

// —— projections ———————————————————————————————————————————————————

fn metadata_of(authority: &StoredCertificateAuthority) -> Map<String, Value> {
    serde_json::from_str::<Value>(&authority.public_metadata_json)
        .ok()
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default()
}

fn string_list(metadata: &Map<String, Value>, key: &str) -> Vec<String> {
    metadata
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// The authority's kind.
///
/// `certificate_authorities.kind` is authoritative once a parent link exists,
/// because `Db::insert_ca_link` is the only accessor that writes the column.
/// A subordinate that is still waiting for an *external* signature has no
/// in-organization parent yet, so until it is linked the requested kind is
/// read from the metadata document this module owns. See the report note on
/// plan §4.3: a `set_ca_pending_csr` that also stamped the kind would remove
/// this fallback.
fn ca_kind(metadata: &Map<String, Value>, config: &StoredCaSigningConfig) -> String {
    if config.parent_id.is_some() {
        return "intermediate".into();
    }
    match metadata.get("kind").and_then(Value::as_str) {
        Some(kind @ ("root" | "intermediate")) => kind.to_owned(),
        _ => config.kind.clone(),
    }
}

fn crl_mirrors(config: &StoredCaSigningConfig) -> Vec<String> {
    config
        .crl_mirrors_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Vec<String>>(raw).ok())
        .unwrap_or_default()
}

/// Whitelist projection of an authority. Carries public certificate material
/// and configuration only — never the sealed columns, never a private key.
fn ca_view(authority: &StoredCertificateAuthority, config: &StoredCaSigningConfig) -> Value {
    let metadata = metadata_of(authority);
    json!({
        "id": authority.id,
        "display_name": authority.display_name,
        "kind": ca_kind(&metadata, config),
        "parent_id": config.parent_id,
        "status": authority.status,
        "key_algorithm": config.key_algorithm,
        "key_source": config.key_source,
        "path_len": config.path_len,
        "crl_enabled": config.crl_enabled,
        "crl_mirrors": crl_mirrors(config),
        "crl_distribution_points": string_list(&metadata, "crl_distribution_points"),
        "subject": metadata.get("subject").cloned().unwrap_or(Value::Null),
        "certificate": metadata.get("certificate").cloned().unwrap_or(Value::Null),
        "chain": string_list(&metadata, "chain"),
        "serial_hex": metadata.get("serial_hex").cloned().unwrap_or(Value::Null),
        "fingerprint_sha256": metadata.get("fingerprint_sha256").cloned().unwrap_or(Value::Null),
        "not_before": metadata.get("not_before").cloned().unwrap_or(Value::Null),
        "not_after": metadata.get("not_after").cloned().unwrap_or(Value::Null),
        "renewed_from": metadata.get("renewed_from").cloned().unwrap_or(Value::Null),
        "renewed_by": metadata.get("renewed_by").cloned().unwrap_or(Value::Null),
        "awaiting_external_signature": config.pending_csr_pem.is_some(),
        "version": authority.version,
        "created_at": authority.created_at,
        "updated_at": authority.updated_at,
    })
}

fn signing_config_view(config: &StoredCaSigningConfig, kind: &str) -> Value {
    json!({
        "certificate_authority_id": config.certificate_authority_id,
        "kind": kind,
        "parent_id": config.parent_id,
        "key_algorithm": config.key_algorithm,
        "key_source": config.key_source,
        "hsm_connector_id": config.hsm_connector_id,
        "hsm_key_label": config.hsm_key_label,
        "path_len": config.path_len,
        "crl_enabled": config.crl_enabled,
        "crl_mirrors": crl_mirrors(config),
        "awaiting_external_signature": config.pending_csr_pem.is_some(),
        "version": config.version,
    })
}

/// The non-secret audit projection appended to the outbox.
fn audit_payload(
    organization: &str,
    authority: &StoredCertificateAuthority,
    config: &StoredCaSigningConfig,
    extra: &[(&str, Value)],
) -> String {
    let mut payload = Map::new();
    payload.insert("organization_id".into(), json!(organization));
    payload.insert("certificate_authority_id".into(), json!(authority.id));
    payload.insert("display_name".into(), json!(authority.display_name));
    payload.insert(
        "kind".into(),
        json!(ca_kind(&metadata_of(authority), config)),
    );
    payload.insert("status".into(), json!(authority.status));
    payload.insert("key_algorithm".into(), json!(config.key_algorithm));
    payload.insert("key_source".into(), json!(config.key_source));
    payload.insert("version".into(), json!(authority.version));
    for (key, value) in extra {
        payload.insert((*key).to_owned(), value.clone());
    }
    Value::Object(payload).to_string()
}

/// Builds the `public_metadata_json` document for an authority.
fn metadata_document(
    kind: &str,
    subject: &SubjectDn,
    chain: &[String],
    facts: Option<&CaFacts>,
    extra: &[(&str, Value)],
) -> Value {
    let mut document = Map::new();
    document.insert("kind".into(), json!(kind));
    document.insert("trust_scope".into(), json!("private_local"));
    document.insert("subject".into(), json!(subject));
    document.insert("chain".into(), json!(chain));
    if let Some(certificate) = chain.first() {
        document.insert("certificate".into(), json!(certificate));
    }
    if let Some(facts) = facts {
        document.insert("subject".into(), json!(facts.subject));
        document.insert("serial_hex".into(), json!(facts.serial_hex));
        document.insert("fingerprint_sha256".into(), json!(facts.fingerprint_sha256));
        document.insert("is_self_signed".into(), json!(facts.is_self_signed));
        document.insert("not_before".into(), json!(from_offset(facts.not_before)));
        document.insert("not_after".into(), json!(from_offset(facts.not_after)));
    }
    for (key, value) in extra {
        document.insert((*key).to_owned(), value.clone());
    }
    Value::Object(document)
}

// —— storage helpers ———————————————————————————————————————————————

/// An authority row paired with its signing configuration.
type LoadedCa = (StoredCertificateAuthority, StoredCaSigningConfig);

/// What [`mint_authority`] produces: the chain (leaf first, empty while the
/// certificate is still to be signed externally), the key, the pending CSR,
/// and the row status.
type MintedAuthority = (Vec<String>, KeyPair, Option<String>, &'static str);

/// Loads one authority owned by this module, org-scoped.
///
/// Returns `Ok(None)` for a missing id, an id in another organization, and an
/// authority written by a different issuer — all of which the caller reports
/// as 404.
async fn load_ca(
    st: &AppState,
    organization: &str,
    authority_id: &str,
) -> Result<Option<LoadedCa>, Response> {
    let authority = st
        .db
        .get_certificate_authority(organization, authority_id)
        .await
        .map_err(|error| internal(error, "read certificate authority"))?;
    let Some(authority) = authority.filter(|row| row.issuer_kind == CERTMGR_ISSUER) else {
        return Ok(None);
    };
    let config = st
        .db
        .get_signing_config(organization, authority_id)
        .await
        .map_err(|error| internal(error, "read certificate authority signing config"))?;
    let Some(config) = config else {
        return Ok(None);
    };
    Ok(Some((authority, config)))
}

/// The chain stored for an authority, leaf first.
fn stored_chain(authority: &StoredCertificateAuthority) -> Vec<String> {
    string_list(&metadata_of(authority), "chain")
}

/// The authority's own certificate, if it has been signed.
fn stored_certificate(authority: &StoredCertificateAuthority) -> Option<String> {
    metadata_of(authority)
        .get("certificate")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// Everything one CA insert needs, so the persistence step is one call.
struct NewAuthority {
    id: String,
    display_name: String,
    metadata: Value,
    sealed: SealedCertificateMaterial,
    status: &'static str,
    key_algorithm: KeyAlgorithm,
    path_len: Option<u8>,
    crl_enabled: bool,
    crl_mirrors: Vec<String>,
    pending_csr: Option<String>,
    parent_id: Option<String>,
}

/// Persists a new authority row and its signing configuration.
///
/// `Db::insert_certificate_authority` writes the 0013 columns only, so the
/// 0016 columns (`key_algorithm`, `path_len`, `crl_*`) are applied immediately
/// after through `Db::update_signing_config`, and the parent link — which also
/// stamps `kind` — through `Db::insert_ca_link`.
async fn persist_authority(
    st: &AppState,
    organization: &str,
    new: NewAuthority,
) -> Result<LoadedCa, Response> {
    let stamp = Utc::now().to_rfc3339();
    let authority = StoredCertificateAuthority {
        id: new.id.clone(),
        organization_id: organization.to_owned(),
        issuer_kind: CERTMGR_ISSUER.into(),
        issuer_connection_id: None,
        display_name: new.display_name,
        public_metadata_json: new.metadata.to_string(),
        sealed_material: new.sealed,
        // The certmgr hierarchy never claims the legacy `is_default` slot; the
        // 0013 single-default index belongs to `routes::certs`.
        is_default: false,
        status: new.status.into(),
        version: 1,
        created_at: stamp.clone(),
        updated_at: stamp,
    };
    st.db
        .insert_certificate_authority(&authority)
        .await
        .map_err(|error| internal(error, "persist certificate authority"))?;

    let crl_mirrors_json = serde_json::to_string(&new.crl_mirrors)
        .map_err(|error| internal(error, "encode CRL mirrors"))?;
    let applied = st
        .db
        .update_signing_config(&StoredCaSigningConfig {
            certificate_authority_id: new.id.clone(),
            organization_id: organization.to_owned(),
            kind: "root".into(),
            key_algorithm: new.key_algorithm.as_str().to_owned(),
            key_source: "sealed".into(),
            hsm_connector_id: None,
            hsm_key_label: None,
            path_len: new.path_len.map(i64::from),
            crl_enabled: new.crl_enabled,
            crl_mirrors_json: Some(crl_mirrors_json),
            parent_id: new.parent_id.clone(),
            pending_csr_pem: None,
            version: 1,
        })
        .await
        .map_err(|error| internal(error, "write certificate authority signing config"))?;
    if !applied {
        return Err(internal(
            "signing config compare-and-swap failed",
            "write certificate authority signing config",
        ));
    }

    if let Some(csr_pem) = &new.pending_csr {
        st.db
            .set_ca_pending_csr(organization, &new.id, csr_pem)
            .await
            .map_err(|error| internal(error, "record pending certificate signing request"))?;
    }
    if let Some(parent_id) = &new.parent_id {
        st.db
            .insert_ca_link(organization, &new.id, parent_id)
            .await
            .map_err(|error| internal(error, "link certificate authority to its parent"))?;
    }

    load_ca(st, organization, &new.id).await?.ok_or_else(|| {
        internal(
            "authority missing after insert",
            "reload certificate authority",
        )
    })
}

async fn append_audit(st: &AppState, event: &'static str, payload: String) -> Result<(), Response> {
    st.db
        .append_outbox(event, &payload)
        .await
        .map(|_| ())
        .map_err(|error| internal(error, "append certificate authority audit event"))
}

// —— request bodies ————————————————————————————————————————————————

/// `POST /api/v1/certmgr/cas`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateCaBody {
    /// `root` or `intermediate`.
    pub kind: String,
    /// Required for an internally signed `intermediate`; refused for a `root`.
    #[serde(default)]
    pub parent_id: Option<String>,
    /// Set on an `intermediate` with no `parent_id` to mint a CSR for an
    /// external authority to sign.
    #[serde(default)]
    pub external_signing: bool,
    #[serde(default)]
    pub display_name: Option<String>,
    /// At least one attribute is required.
    pub subject: SubjectDn,
    /// One of `rsa-2048`, `rsa-4096`, `ecdsa-p256` (default), `ecdsa-p384`.
    #[serde(default)]
    pub key_algorithm: Option<String>,
    #[serde(default)]
    pub validity_days: Option<i64>,
    /// RFC3339; mutually exclusive with `validity_days`.
    #[serde(default)]
    pub not_after: Option<String>,
    /// `basicConstraints` `pathLenConstraint`; omit for unconstrained.
    #[serde(default)]
    pub path_len: Option<u8>,
    /// CRL distribution points embedded in the authority certificate.
    #[serde(default)]
    pub crl_distribution_points: Option<Vec<String>>,
    #[serde(default)]
    pub crl_enabled: Option<bool>,
    /// Mirror URLs advertised for the authority's CRL (at most four).
    #[serde(default)]
    pub crl_mirrors: Option<Vec<String>>,
}

/// `PATCH /api/v1/certmgr/cas/{id}`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PatchCaBody {
    /// `active` or `disabled`.
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub crl_enabled: Option<bool>,
    /// At most four `http(s)` URLs.
    #[serde(default)]
    pub crl_mirrors: Option<Vec<String>>,
}

/// `POST /api/v1/certmgr/cas/{id}/import-chain`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportChainBody {
    /// The signed authority certificate, PEM.
    pub certificate_pem: String,
    /// Issuers above it, leaf-first, PEM.
    #[serde(default)]
    pub chain_pem: Option<String>,
    /// The in-organization authority that signed it, when there is one.
    #[serde(default)]
    pub parent_id: Option<String>,
}

/// `POST /api/v1/certmgr/cas/{id}/renew`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenewCaBody {
    /// `same-key` or `new-key`.
    pub mode: String,
    #[serde(default)]
    pub validity_days: Option<i64>,
    /// RFC3339; mutually exclusive with `validity_days`.
    #[serde(default)]
    pub not_after: Option<String>,
}

/// `PATCH /api/v1/certmgr/cas/{id}/signing-config`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PatchSigningConfigBody {
    /// `sealed` or `hsm`.
    #[serde(default)]
    pub key_source: Option<String>,
    #[serde(default)]
    pub hsm_connector_id: Option<String>,
    #[serde(default)]
    pub hsm_key_label: Option<String>,
    #[serde(default)]
    pub crl_enabled: Option<bool>,
    /// At most four `http(s)` URLs.
    #[serde(default)]
    pub crl_mirrors: Option<Vec<String>>,
    /// Optimistic concurrency; defaults to the version just read.
    #[serde(default)]
    pub expected_version: Option<i64>,
}

// —— handlers ——————————————————————————————————————————————————————

/// `GET /api/v1/certmgr/cas` — every authority this module owns, org-scoped.
pub async fn list_cas(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization = match resolve_caller_organization(&st, &who, &headers) {
        Ok(organization) => organization.to_string(),
        Err(response) => return response,
    };
    let authorities = match st.db.list_certificate_authorities(&organization).await {
        Ok(rows) => rows,
        Err(error) => return internal(error, "list certificate authorities"),
    };
    let mut views = Vec::new();
    for authority in authorities
        .into_iter()
        .filter(|row| row.issuer_kind == CERTMGR_ISSUER)
    {
        match st.db.get_signing_config(&organization, &authority.id).await {
            Ok(Some(config)) => views.push(ca_view(&authority, &config)),
            Ok(None) => {}
            Err(error) => return internal(error, "read certificate authority signing config"),
        }
    }
    (
        StatusCode::OK,
        Json(json!({"certificate_authorities": views})),
    )
        .into_response()
}

/// `GET /api/v1/certmgr/cas/{id}`.
pub async fn get_ca(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(authority_id): Path<String>,
) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization = match resolve_caller_organization(&st, &who, &headers) {
        Ok(organization) => organization.to_string(),
        Err(response) => return response,
    };
    match load_ca(&st, &organization, &authority_id).await {
        Ok(Some((authority, config))) => (
            StatusCode::OK,
            Json(json!({"certificate_authority": ca_view(&authority, &config)})),
        )
            .into_response(),
        Ok(None) => not_found(),
        Err(response) => response,
    }
}

/// A validated `create_ca` request, resolved before any key is generated.
struct CreatePlan {
    intermediate: bool,
    parent_id: Option<String>,
    external_signing: bool,
    display_name: String,
    key_algorithm: KeyAlgorithm,
    params: CaParams,
    crl_enabled: bool,
    crl_mirrors: Vec<String>,
}

/// Validates a create request without touching the database.
fn plan_create(body: &CreateCaBody) -> Result<CreatePlan, Response> {
    let intermediate = match body.kind.as_str() {
        "root" => false,
        "intermediate" => true,
        _ => {
            return Err(bad_request(
                "invalid_kind",
                "kind must be \"root\" or \"intermediate\"",
            ))
        }
    };
    if !intermediate && (body.parent_id.is_some() || body.external_signing) {
        return Err(bad_request(
            "invalid_request",
            "a root authority is self-signed; parent_id and external_signing apply to intermediates",
        ));
    }
    if intermediate && body.parent_id.is_none() && !body.external_signing {
        return Err(bad_request(
            "parent_required",
            "an intermediate needs parent_id, or external_signing=true to export a CSR instead",
        ));
    }
    if intermediate && body.parent_id.is_some() && body.external_signing {
        return Err(bad_request(
            "invalid_request",
            "supply parent_id for in-host signing or external_signing=true, not both",
        ));
    }
    validate_subject(&body.subject)?;
    let display_name = body
        .display_name
        .clone()
        .or_else(|| body.subject.cn.clone())
        .unwrap_or_else(|| "Certificate Authority".into());
    validate_display_name(&display_name)?;
    let key_algorithm = parse_key_algorithm(body.key_algorithm.as_deref().unwrap_or("ecdsa-p256"))?;
    let distribution_points = body.crl_distribution_points.clone().unwrap_or_default();
    validate_urls(
        &distribution_points,
        MAX_DISTRIBUTION_POINTS,
        "invalid_crl_distribution_point",
    )?;
    let mirrors = body.crl_mirrors.clone().unwrap_or_default();
    validate_urls(&mirrors, MAX_CRL_MIRRORS, "invalid_crl_mirror")?;
    let default_days = if intermediate {
        DEFAULT_INTERMEDIATE_DAYS
    } else {
        DEFAULT_ROOT_DAYS
    };
    let not_after = resolve_not_after(body.validity_days, body.not_after.as_deref(), default_days)?;
    let params = build_params(
        body.subject.clone(),
        key_algorithm,
        not_after,
        body.path_len,
        distribution_points,
    )?;
    Ok(CreatePlan {
        intermediate,
        parent_id: body.parent_id.clone(),
        external_signing: body.external_signing,
        display_name,
        key_algorithm,
        params,
        crl_enabled: body.crl_enabled.unwrap_or(true),
        crl_mirrors: mirrors,
    })
}

/// `POST /api/v1/certmgr/cas` — mint a root, or a subordinate under a parent
/// in the same organization, or a subordinate awaiting an external signature.
///
/// Ordering: authorize → resolve organization → validate → load parent →
/// generate → seal → persist → audit.
#[expect(
    clippy::too_many_lines,
    reason = "one linear generate-then-commit path; splitting it would hide the ordering the ADR pins"
)]
pub async fn create_ca(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<CreateCaBody>,
) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization = match resolve_caller_organization(&st, &who, &headers) {
        Ok(organization) => organization.to_string(),
        Err(response) => return response,
    };
    let plan = match plan_create(&body) {
        Ok(plan) => plan,
        Err(response) => return response,
    };
    let sealing = match sealing_key(&st) {
        Ok(key) => key,
        Err(response) => return response,
    };

    let parent = match &plan.parent_id {
        Some(parent_id) => match load_ca(&st, &organization, parent_id).await {
            Ok(Some(loaded)) => Some(loaded),
            Ok(None) => return not_found(),
            Err(response) => return response,
        },
        None => None,
    };
    if let Some((parent_authority, _)) = &parent {
        if parent_authority.status != "active" {
            return conflict(
                "parent_not_active",
                "the parent certificate authority is not active",
            );
        }
    }

    let authority_id = format!("ca:certmgr:{}", uuid::Uuid::now_v7());
    let (chain, key, pending_csr, status) = match mint_authority(&plan, parent.as_ref(), &sealing) {
        Ok(minted) => minted,
        Err(response) => return response,
    };

    let facts = match chain.first() {
        Some(certificate) => match ca::validate_ca(certificate, Some(&key)) {
            Ok(facts) => Some(facts),
            Err(error) => return pki_response(&error, "validate new certificate authority"),
        },
        None => None,
    };
    let kind = if plan.intermediate {
        "intermediate"
    } else {
        "root"
    };
    let metadata = metadata_document(
        kind,
        &plan.params.subject,
        &chain,
        facts.as_ref(),
        &[
            (
                "crl_distribution_points",
                json!(plan.params.crl_distribution_points),
            ),
            ("parent_id", json!(plan.parent_id)),
            ("external_signing", json!(plan.external_signing)),
        ],
    );
    let sealed = match seal_ca_key(&sealing, &authority_id, &organization, &key) {
        Ok(sealed) => sealed,
        Err(response) => return response,
    };
    drop(key);

    let persisted = persist_authority(
        &st,
        &organization,
        NewAuthority {
            id: authority_id,
            display_name: plan.display_name,
            metadata,
            sealed,
            status,
            key_algorithm: plan.key_algorithm,
            path_len: plan.params.path_len,
            crl_enabled: plan.crl_enabled,
            crl_mirrors: plan.crl_mirrors,
            pending_csr,
            parent_id: plan.parent_id,
        },
    )
    .await;
    let (authority, config) = match persisted {
        Ok(pair) => pair,
        Err(response) => return response,
    };
    let payload = audit_payload(&organization, &authority, &config, &[]);
    if let Err(response) = append_audit(&st, EVENT_CREATED, payload).await {
        return response;
    }
    (
        StatusCode::CREATED,
        Json(json!({"certificate_authority": ca_view(&authority, &config)})),
    )
        .into_response()
}

/// Generates the key and, where possible, the certificate for a new authority.
///
/// Returns the chain (leaf first, empty when the certificate is still to be
/// signed externally), the key, the pending CSR, and the row status.
fn mint_authority(
    plan: &CreatePlan,
    parent: Option<&LoadedCa>,
    sealing: &[u8; 32],
) -> Result<MintedAuthority, Response> {
    if !plan.intermediate {
        let generated = ca::generate_root(&plan.params)
            .map_err(|error| pki_response(&error, "generate root authority"))?;
        return Ok((
            vec![generated.certificate_pem],
            generated.key,
            None,
            "active",
        ));
    }
    let (csr_pem, key) = ca::generate_intermediate_csr(&plan.params)
        .map_err(|error| pki_response(&error, "generate subordinate request"))?;
    let Some((parent_authority, parent_config)) = parent else {
        // Awaiting an external signature: the CSR is the deliverable.
        return Ok((Vec::new(), key, Some(csr_pem), "pending"));
    };
    let Some(parent_certificate) = stored_certificate(parent_authority) else {
        return Err(conflict(
            "parent_unsigned",
            "the parent authority has no certificate yet; import its signed chain first",
        ));
    };
    let parent_key = open_ca_key(sealing, parent_authority, parent_config)?;
    let certificate =
        ca::sign_intermediate(&parent_certificate, &parent_key, &csr_pem, &plan.params)
            .map_err(|error| pki_response(&error, "sign subordinate authority"))?;
    drop(parent_key);
    let mut chain = vec![certificate];
    chain.extend(stored_chain(parent_authority));
    Ok((chain, key, None, "active"))
}

/// `PATCH /api/v1/certmgr/cas/{id}` — status transitions and CRL mirrors.
#[expect(
    clippy::too_many_lines,
    reason = "two independent compare-and-swap steps plus their re-read, kept in one auditable path"
)]
pub async fn patch_ca(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(authority_id): Path<String>,
    Json(body): Json<PatchCaBody>,
) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization = match resolve_caller_organization(&st, &who, &headers) {
        Ok(organization) => organization.to_string(),
        Err(response) => return response,
    };
    if body.status.is_none() && body.crl_mirrors.is_none() && body.crl_enabled.is_none() {
        return bad_request(
            "empty_patch",
            "supply at least one of status, crl_enabled or crl_mirrors",
        );
    }
    if let Some(mirrors) = &body.crl_mirrors {
        if let Err(response) = validate_urls(mirrors, MAX_CRL_MIRRORS, "invalid_crl_mirror") {
            return response;
        }
    }
    let status = match body.status.as_deref() {
        None => None,
        Some(value @ ("active" | "disabled")) => Some(value),
        Some(_) => {
            return bad_request(
                "invalid_status",
                "status must be \"active\" or \"disabled\"",
            )
        }
    };

    let (authority, config) = match load_ca(&st, &organization, &authority_id).await {
        Ok(Some(loaded)) => loaded,
        Ok(None) => return not_found(),
        Err(response) => return response,
    };
    if status == Some("active") && authority.status == "pending" {
        return conflict(
            "awaiting_external_signature",
            "import the signed chain before activating this authority",
        );
    }

    if let Some(status) = status {
        match st
            .db
            .update_certificate_authority_status(
                &organization,
                &authority_id,
                config.version,
                status,
            )
            .await
        {
            Ok(true) => {}
            Ok(false) => return conflict("version_conflict", "the authority changed; re-read it"),
            Err(error) => return internal(error, "update certificate authority status"),
        }
    }

    if body.crl_mirrors.is_some() || body.crl_enabled.is_some() {
        let current = match st.db.get_signing_config(&organization, &authority_id).await {
            Ok(Some(current)) => current,
            Ok(None) => return not_found(),
            Err(error) => return internal(error, "read certificate authority signing config"),
        };
        let mirrors = body
            .crl_mirrors
            .clone()
            .unwrap_or_else(|| crl_mirrors(&current));
        let encoded = match serde_json::to_string(&mirrors) {
            Ok(encoded) => encoded,
            Err(error) => return internal(error, "encode CRL mirrors"),
        };
        let next = StoredCaSigningConfig {
            crl_enabled: body.crl_enabled.unwrap_or(current.crl_enabled),
            crl_mirrors_json: Some(encoded),
            ..current
        };
        match st.db.update_signing_config(&next).await {
            Ok(true) => {}
            Ok(false) => return conflict("version_conflict", "the authority changed; re-read it"),
            Err(error) => return internal(error, "write certificate authority signing config"),
        }
    }

    let (authority, config) = match load_ca(&st, &organization, &authority_id).await {
        Ok(Some(loaded)) => loaded,
        Ok(None) => return not_found(),
        Err(response) => return response,
    };
    let payload = audit_payload(
        &organization,
        &authority,
        &config,
        &[("crl_mirror_count", json!(crl_mirrors(&config).len()))],
    );
    if let Err(response) = append_audit(&st, EVENT_UPDATED, payload).await {
        return response;
    }
    (
        StatusCode::OK,
        Json(json!({"certificate_authority": ca_view(&authority, &config)})),
    )
        .into_response()
}

/// `GET /api/v1/certmgr/cas/{id}/csr` — the PKCS#10 request an externally
/// signed subordinate is waiting on. Public material.
pub async fn export_csr(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(authority_id): Path<String>,
) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization = match resolve_caller_organization(&st, &who, &headers) {
        Ok(organization) => organization.to_string(),
        Err(response) => return response,
    };
    let (_, config) = match load_ca(&st, &organization, &authority_id).await {
        Ok(Some(loaded)) => loaded,
        Ok(None) => return not_found(),
        Err(response) => return response,
    };
    match config.pending_csr_pem {
        Some(csr_pem) => (
            StatusCode::OK,
            Json(json!({
                "certificate_authority_id": authority_id,
                "csr_pem": csr_pem,
            })),
        )
            .into_response(),
        None => conflict(
            "no_pending_csr",
            "this authority is not awaiting an external signature; create it with external_signing=true",
        ),
    }
}

/// `POST /api/v1/certmgr/cas/{id}/import-chain` — complete an externally
/// signed subordinate.
///
/// The imported certificate must certify the authority's *stored* key and the
/// supplied chain must actually link up: to the named in-organization parent
/// when one is given, otherwise to a self-signed root included in the upload.
#[expect(
    clippy::too_many_lines,
    reason = "one linear validate-then-commit path; splitting it would hide the ordering the ADR pins"
)]
pub async fn import_chain(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(authority_id): Path<String>,
    Json(body): Json<ImportChainBody>,
) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization = match resolve_caller_organization(&st, &who, &headers) {
        Ok(organization) => organization.to_string(),
        Err(response) => return response,
    };
    let sealing = match sealing_key(&st) {
        Ok(key) => key,
        Err(response) => return response,
    };
    let (authority, config) = match load_ca(&st, &organization, &authority_id).await {
        Ok(Some(loaded)) => loaded,
        Ok(None) => return not_found(),
        Err(response) => return response,
    };
    if config.pending_csr_pem.is_none() {
        return conflict(
            "no_pending_csr",
            "this authority is not awaiting an external signature",
        );
    }

    let key = match open_ca_key(&sealing, &authority, &config) {
        Ok(key) => key,
        Err(response) => return response,
    };
    // The imported certificate must certify the key we already hold, or the
    // authority would be left with a certificate it cannot sign under.
    let facts = match ca::validate_ca(&body.certificate_pem, Some(&key)) {
        Ok(facts) => facts,
        Err(error) => return pki_response(&error, "validate imported authority"),
    };
    drop(key);

    let mut document = body.certificate_pem.trim().to_owned();
    if let Some(rest) = &body.chain_pem {
        document.push('\n');
        document.push_str(rest.trim());
    }
    let chain = match bundle::normalize_chain(&document) {
        Ok(chain) => chain,
        Err(error) => return pki_response(&error, "normalize imported chain"),
    };

    let parent = match &body.parent_id {
        Some(parent_id) => match load_ca(&st, &organization, parent_id).await {
            Ok(Some(loaded)) => Some(loaded),
            Ok(None) => return not_found(),
            Err(response) => return response,
        },
        None => None,
    };
    if let Some((parent_authority, _)) = &parent {
        let Some(parent_certificate) = stored_certificate(parent_authority) else {
            return conflict("parent_unsigned", "the named parent has no certificate yet");
        };
        let expected = match bundle::fingerprint_sha256(&parent_certificate) {
            Ok(fingerprint) => fingerprint,
            Err(error) => return pki_response(&error, "fingerprint parent certificate"),
        };
        let reaches_parent = chain.iter().skip(1).any(|link| {
            bundle::fingerprint_sha256(link).is_ok_and(|fingerprint| fingerprint == expected)
        });
        if !reaches_parent {
            return bad_request(
                "chain_does_not_reach_parent",
                "append the named parent's certificate so the uploaded chain links to it",
            );
        }
    } else {
        let anchored = chain
            .last()
            .and_then(|root| ca::validate_ca(root, None).ok())
            .is_some_and(|root| root.is_self_signed);
        if !anchored {
            return bad_request(
                "chain_not_anchored",
                "name parent_id, or append the self-signed root that terminates the chain",
            );
        }
    }

    let metadata = metadata_document(
        "intermediate",
        &facts.subject,
        &chain,
        Some(&facts),
        &[
            (
                "crl_distribution_points",
                json!(string_list(
                    &metadata_of(&authority),
                    "crl_distribution_points"
                )),
            ),
            ("parent_id", json!(body.parent_id)),
            ("external_signing", json!(true)),
        ],
    );
    match st
        .db
        .complete_ca_import(
            &organization,
            &authority_id,
            config.version,
            &metadata.to_string(),
        )
        .await
    {
        Ok(true) => {}
        Ok(false) => return conflict("version_conflict", "the authority changed; re-read it"),
        Err(error) => return internal(error, "complete certificate authority import"),
    }
    if let Some(parent_id) = &body.parent_id {
        if let Err(error) = st
            .db
            .insert_ca_link(&organization, &authority_id, parent_id)
            .await
        {
            return internal(error, "link imported authority to its parent");
        }
    }

    let (authority, config) = match load_ca(&st, &organization, &authority_id).await {
        Ok(Some(loaded)) => loaded,
        Ok(None) => return not_found(),
        Err(response) => return response,
    };
    let payload = audit_payload(
        &organization,
        &authority,
        &config,
        &[
            ("fingerprint_sha256", json!(facts.fingerprint_sha256)),
            ("chain_length", json!(chain.len())),
        ],
    );
    if let Err(response) = append_audit(&st, EVENT_IMPORTED, payload).await {
        return response;
    }
    (
        StatusCode::OK,
        Json(json!({"certificate_authority": ca_view(&authority, &config)})),
    )
        .into_response()
}

/// `POST /api/v1/certmgr/cas/{id}/renew` — mint a successor authority.
///
/// Renewal never touches the predecessor's issued certificates: they remain
/// valid under the certificate that signed them, which is exactly why the
/// predecessor row is kept active and only annotated with `renewed_by`.
#[expect(
    clippy::too_many_lines,
    reason = "one linear mint-then-link path; splitting it would hide the ordering the ADR pins"
)]
pub async fn renew_ca(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(authority_id): Path<String>,
    Json(body): Json<RenewCaBody>,
) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization = match resolve_caller_organization(&st, &who, &headers) {
        Ok(organization) => organization.to_string(),
        Err(response) => return response,
    };
    let same_key = match body.mode.as_str() {
        "same-key" => true,
        "new-key" => false,
        _ => return bad_request("invalid_mode", "mode must be \"same-key\" or \"new-key\""),
    };
    let sealing = match sealing_key(&st) {
        Ok(key) => key,
        Err(response) => return response,
    };
    let (authority, config) = match load_ca(&st, &organization, &authority_id).await {
        Ok(Some(loaded)) => loaded,
        Ok(None) => return not_found(),
        Err(response) => return response,
    };
    if authority.status != "active" {
        return conflict(
            "authority_not_active",
            "only an active certificate authority can be renewed",
        );
    }
    let Some(current_certificate) = stored_certificate(&authority) else {
        return conflict(
            "authority_unsigned",
            "import the signed chain before renewing this authority",
        );
    };
    let current_facts = match ca::validate_ca(&current_certificate, None) {
        Ok(facts) => facts,
        Err(error) => return pki_response(&error, "read current authority"),
    };
    let key_algorithm = match parse_key_algorithm(&config.key_algorithm) {
        Ok(algorithm) => algorithm,
        Err(response) => return response,
    };
    let metadata = metadata_of(&authority);
    let distribution_points = string_list(&metadata, "crl_distribution_points");
    let default_days = if config.parent_id.is_some() {
        DEFAULT_INTERMEDIATE_DAYS
    } else {
        DEFAULT_ROOT_DAYS
    };
    let not_after =
        match resolve_not_after(body.validity_days, body.not_after.as_deref(), default_days) {
            Ok(moment) => moment,
            Err(response) => return response,
        };
    let params = match build_params(
        current_facts.subject.clone(),
        key_algorithm,
        not_after,
        current_facts.path_len,
        distribution_points.clone(),
    ) {
        Ok(params) => params,
        Err(response) => return response,
    };

    let parent = match &config.parent_id {
        Some(parent_id) => match load_ca(&st, &organization, parent_id).await {
            Ok(Some(loaded)) => Some(loaded),
            Ok(None) => return not_found(),
            Err(response) => return response,
        },
        None => None,
    };

    let successor_id = format!("ca:certmgr:{}", uuid::Uuid::now_v7());
    let renewed = renew_material(
        &sealing,
        &RenewInputs {
            same_key,
            params: &params,
            authority: &authority,
            config: &config,
            certificate_pem: &current_certificate,
            parent: parent.as_ref(),
        },
    );
    let (chain, key) = match renewed {
        Ok(pair) => pair,
        Err(response) => return response,
    };
    let facts = match chain.first().map(|pem| ca::validate_ca(pem, Some(&key))) {
        Some(Ok(facts)) => facts,
        Some(Err(error)) => return pki_response(&error, "validate renewed authority"),
        None => return internal("renewal produced no certificate", "renew authority"),
    };
    let successor_metadata = metadata_document(
        &ca_kind(&metadata, &config),
        &facts.subject,
        &chain,
        Some(&facts),
        &[
            ("crl_distribution_points", json!(distribution_points)),
            ("parent_id", json!(config.parent_id)),
            ("renewed_from", json!(authority.id)),
        ],
    );
    let sealed = match seal_ca_key(&sealing, &successor_id, &organization, &key) {
        Ok(sealed) => sealed,
        Err(response) => return response,
    };
    drop(key);

    let persisted = persist_authority(
        &st,
        &organization,
        NewAuthority {
            id: successor_id.clone(),
            display_name: authority.display_name.clone(),
            metadata: successor_metadata,
            sealed,
            status: "active",
            key_algorithm,
            path_len: current_facts.path_len,
            crl_enabled: config.crl_enabled,
            crl_mirrors: crl_mirrors(&config),
            pending_csr: None,
            parent_id: config.parent_id.clone(),
        },
    )
    .await;
    let (successor, successor_config) = match persisted {
        Ok(pair) => pair,
        Err(response) => return response,
    };

    // Annotate the predecessor. `complete_ca_import` is the only compare-and-
    // swap accessor for `public_metadata_json`; the authority is already
    // active and has no pending CSR, so the rest of its effect is a no-op.
    let mut predecessor_metadata = metadata;
    predecessor_metadata.insert("renewed_by".into(), json!(successor_id));
    match st
        .db
        .complete_ca_import(
            &organization,
            &authority_id,
            config.version,
            &Value::Object(predecessor_metadata).to_string(),
        )
        .await
    {
        Ok(true) => {}
        Ok(false) => return conflict("version_conflict", "the authority changed; re-read it"),
        Err(error) => return internal(error, "annotate renewed certificate authority"),
    }

    let payload = audit_payload(
        &organization,
        &successor,
        &successor_config,
        &[
            ("renewed_from", json!(authority.id)),
            ("mode", json!(body.mode)),
        ],
    );
    if let Err(response) = append_audit(&st, EVENT_RENEWED, payload).await {
        return response;
    }
    (
        StatusCode::CREATED,
        Json(json!({
            "certificate_authority": ca_view(&successor, &successor_config),
            "renewed_from": authority.id,
        })),
    )
        .into_response()
}

/// Everything [`renew_material`] needs, kept in one struct so the signature
/// stays inside the argument budget.
struct RenewInputs<'a> {
    same_key: bool,
    params: &'a CaParams,
    authority: &'a StoredCertificateAuthority,
    config: &'a StoredCaSigningConfig,
    certificate_pem: &'a str,
    parent: Option<&'a LoadedCa>,
}

/// Produces the successor's chain and key.
fn renew_material(
    sealing: &[u8; 32],
    inputs: &RenewInputs<'_>,
) -> Result<(Vec<String>, KeyPair), Response> {
    let key = if inputs.same_key {
        open_ca_key(sealing, inputs.authority, inputs.config)?
    } else {
        keys::generate(inputs.params.key_algorithm)
            .map_err(|error| pki_response(&error, "generate successor key"))?
    };

    match inputs.parent {
        Some((parent_authority, parent_config)) => {
            let Some(parent_certificate) = stored_certificate(parent_authority) else {
                return Err(conflict(
                    "parent_unsigned",
                    "the parent authority has no certificate yet",
                ));
            };
            let request = csr::generate_csr(&inputs.params.subject, &[], &key)
                .map_err(|error| pki_response(&error, "build successor request"))?;
            let parent_key = open_ca_key(sealing, parent_authority, parent_config)?;
            let certificate =
                ca::sign_intermediate(&parent_certificate, &parent_key, &request, inputs.params)
                    .map_err(|error| pki_response(&error, "sign successor authority"))?;
            drop(parent_key);
            let mut chain = vec![certificate];
            chain.extend(stored_chain(parent_authority));
            Ok((chain, key))
        }
        None if inputs.same_key => {
            // Self-renewal: the predecessor certificate is the issuer and the
            // key is unchanged, so the successor is again self-signed.
            // `ca::sign_intermediate` enforces the *issuer's* pathLen budget,
            // which a constrained root cannot satisfy against itself; that case
            // is reported rather than worked around.
            if inputs.config.path_len.is_some() {
                return Err(conflict(
                    "same_key_renewal_unsupported",
                    "a root with a pathLenConstraint cannot self-sign a successor; renew with mode=new-key",
                ));
            }
            let request = csr::generate_csr(&inputs.params.subject, &[], &key)
                .map_err(|error| pki_response(&error, "build successor request"))?;
            let certificate =
                ca::sign_intermediate(inputs.certificate_pem, &key, &request, inputs.params)
                    .map_err(|error| pki_response(&error, "self-sign successor authority"))?;
            Ok((vec![certificate], key))
        }
        None => {
            let generated = ca::generate_root(inputs.params)
                .map_err(|error| pki_response(&error, "generate successor root"))?;
            Ok((vec![generated.certificate_pem], generated.key))
        }
    }
}

/// `GET /api/v1/certmgr/cas/{id}/signing-config`.
pub async fn get_signing_config(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(authority_id): Path<String>,
) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization = match resolve_caller_organization(&st, &who, &headers) {
        Ok(organization) => organization.to_string(),
        Err(response) => return response,
    };
    match load_ca(&st, &organization, &authority_id).await {
        Ok(Some((authority, config))) => {
            let kind = ca_kind(&metadata_of(&authority), &config);
            (
                StatusCode::OK,
                Json(json!({"signing_config": signing_config_view(&config, &kind)})),
            )
                .into_response()
        }
        Ok(None) => not_found(),
        Err(response) => response,
    }
}

/// `PATCH /api/v1/certmgr/cas/{id}/signing-config`.
///
/// `key_algorithm` and `path_len` are deliberately not patchable: both are
/// facts of the certificate that was already issued, and rewriting the row
/// would leave the record disagreeing with the certificate.
pub async fn patch_signing_config(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(authority_id): Path<String>,
    Json(body): Json<PatchSigningConfigBody>,
) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization = match resolve_caller_organization(&st, &who, &headers) {
        Ok(organization) => organization.to_string(),
        Err(response) => return response,
    };
    if let Some(mirrors) = &body.crl_mirrors {
        if let Err(response) = validate_urls(mirrors, MAX_CRL_MIRRORS, "invalid_crl_mirror") {
            return response;
        }
    }
    let key_source = match body.key_source.as_deref() {
        None => None,
        Some(value @ ("sealed" | "hsm")) => Some(value),
        Some(_) => {
            return bad_request(
                "invalid_key_source",
                "key_source must be \"sealed\" or \"hsm\"",
            )
        }
    };
    if key_source == Some("hsm")
        && (body.hsm_connector_id.is_none() || body.hsm_key_label.is_none())
    {
        return bad_request(
            "hsm_reference_required",
            "an hsm key_source needs hsm_connector_id and hsm_key_label",
        );
    }

    let (_, config) = match load_ca(&st, &organization, &authority_id).await {
        Ok(Some(loaded)) => loaded,
        Ok(None) => return not_found(),
        Err(response) => return response,
    };
    let expected_version = body.expected_version.unwrap_or(config.version);
    let mirrors = body
        .crl_mirrors
        .clone()
        .unwrap_or_else(|| crl_mirrors(&config));
    let encoded = match serde_json::to_string(&mirrors) {
        Ok(encoded) => encoded,
        Err(error) => return internal(error, "encode CRL mirrors"),
    };
    let (hsm_connector_id, hsm_key_label) = match key_source {
        Some("hsm") => (body.hsm_connector_id.clone(), body.hsm_key_label.clone()),
        Some("sealed") => (None, None),
        _ => (
            body.hsm_connector_id
                .clone()
                .or(config.hsm_connector_id.clone()),
            body.hsm_key_label.clone().or(config.hsm_key_label.clone()),
        ),
    };
    let next = StoredCaSigningConfig {
        key_source: key_source.unwrap_or(&config.key_source).to_owned(),
        hsm_connector_id,
        hsm_key_label,
        crl_enabled: body.crl_enabled.unwrap_or(config.crl_enabled),
        crl_mirrors_json: Some(encoded),
        version: expected_version,
        ..config.clone()
    };
    match st.db.update_signing_config(&next).await {
        Ok(true) => {}
        Ok(false) => return conflict("version_conflict", "the authority changed; re-read it"),
        Err(error) => return internal(error, "write certificate authority signing config"),
    }

    let (authority, config) = match load_ca(&st, &organization, &authority_id).await {
        Ok(Some(loaded)) => loaded,
        Ok(None) => return not_found(),
        Err(response) => return response,
    };
    let kind = ca_kind(&metadata_of(&authority), &config);
    let payload = audit_payload(
        &organization,
        &authority,
        &config,
        &[("crl_enabled", json!(config.crl_enabled))],
    );
    if let Err(response) = append_audit(&st, EVENT_SIGNING_CONFIG, payload).await {
        return response;
    }
    (
        StatusCode::OK,
        Json(json!({"signing_config": signing_config_view(&config, &kind)})),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::{to_bytes, Body};
    use axum::extract::DefaultBodyLimit;
    use axum::http::Request;
    use axum::routing::{get, post};
    use axum::Router;
    use opensesame_domain::{OrganizationId, OrganizationRole};
    use proptest::prelude::*;
    use tower::ServiceExt;

    use crate::app_state::{self, test_env, test_session_headers};
    use crate::config::Args;

    const TEST_SEALING_KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        test_env::lock()
    }

    /// The exact wiring staged for the Assembler (§5.20), so the tests drive
    /// the same paths, methods and body limits the router will mount.
    fn router(state: AppState) -> Router {
        Router::new()
            .route(
                "/api/v1/certmgr/cas",
                get(super::list_cas)
                    .post(super::create_ca)
                    .layer(DefaultBodyLimit::max(MAX_BODY)),
            )
            .route(
                "/api/v1/certmgr/cas/{id}",
                get(super::get_ca)
                    .patch(super::patch_ca)
                    .layer(DefaultBodyLimit::max(MAX_BODY)),
            )
            .route("/api/v1/certmgr/cas/{id}/csr", get(super::export_csr))
            .route(
                "/api/v1/certmgr/cas/{id}/import-chain",
                post(super::import_chain).layer(DefaultBodyLimit::max(MAX_IMPORT_BODY)),
            )
            .route(
                "/api/v1/certmgr/cas/{id}/renew",
                post(super::renew_ca).layer(DefaultBodyLimit::max(MAX_BODY)),
            )
            .route(
                "/api/v1/certmgr/cas/{id}/signing-config",
                get(super::get_signing_config)
                    .patch(super::patch_signing_config)
                    .layer(DefaultBodyLimit::max(MAX_BODY)),
            )
            .with_state(state)
    }

    async fn sealed_state() -> AppState {
        std::env::set_var("OPENSESAME_CONNECTION_KEY", TEST_SEALING_KEY);
        std::env::set_var("OPENSESAME_TASKBUS", "memory");
        let state = app_state::build(Args {
            listen: "127.0.0.1:0".parse().unwrap(),
            resource: "https://opensesame.local".into(),
            issuer: "https://issuer.local".into(),
            database_url: "sqlite::memory:".into(),
            task_database_url: String::new(),
        })
        .await
        .unwrap();
        std::env::remove_var("OPENSESAME_CONNECTION_KEY");
        state
    }

    fn owner(state: &AppState) -> axum::http::HeaderMap {
        test_session_headers(
            state,
            "prn_owner",
            state.connection_organization,
            OrganizationRole::Owner,
        )
    }

    fn member(state: &AppState) -> axum::http::HeaderMap {
        test_session_headers(
            state,
            "prn_member",
            state.connection_organization,
            OrganizationRole::Member,
        )
    }

    fn stranger(state: &AppState) -> axum::http::HeaderMap {
        test_session_headers(
            state,
            "prn_stranger",
            OrganizationId::new(),
            OrganizationRole::Owner,
        )
    }

    async fn call(
        state: &AppState,
        method: &str,
        path: &str,
        headers: &axum::http::HeaderMap,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder().method(method).uri(path);
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let request = match body {
            Some(value) => request
                .header("content-type", "application/json")
                .body(Body::from(value.to_string()))
                .unwrap(),
            None => request.body(Body::empty()).unwrap(),
        };
        let response = router(state.clone()).oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap();
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }

    async fn call_raw(
        state: &AppState,
        method: &str,
        path: &str,
        headers: &axum::http::HeaderMap,
        body: String,
    ) -> StatusCode {
        let mut request = Request::builder().method(method).uri(path);
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let request = request
            .header("content-type", "application/json")
            .body(Body::from(body))
            .unwrap();
        router(state.clone())
            .oneshot(request)
            .await
            .unwrap()
            .status()
    }

    /// `call` with owned arguments, so a concurrency test can hand one whole
    /// request to `tokio::spawn` without an extra nested async block.
    async fn call_owned(
        state: AppState,
        method: &'static str,
        path: String,
        headers: axum::http::HeaderMap,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        call(&state, method, &path, &headers, body).await
    }

    fn root_body(cn: &str) -> Value {
        json!({
            "kind": "root",
            "subject": {"cn": cn, "o": "OpenSesame"},
            "key_algorithm": "ecdsa-p256",
            "validity_days": 3650,
        })
    }

    async fn create_root(state: &AppState, headers: &axum::http::HeaderMap, cn: &str) -> Value {
        let (status, body) = call(
            state,
            "POST",
            "/api/v1/certmgr/cas",
            headers,
            Some(root_body(cn)),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        body["certificate_authority"].clone()
    }

    fn id_of(view: &Value) -> String {
        view["id"].as_str().unwrap().to_owned()
    }

    /// No projection anywhere in this module may render key material.
    fn assert_no_key_material(body: &Value) {
        let rendered = body.to_string();
        // Field names are matched with their quotes so a base64 certificate
        // body cannot raise a false positive.
        for forbidden in [
            "BEGIN PRIVATE KEY",
            "BEGIN RSA PRIVATE KEY",
            "BEGIN EC PRIVATE KEY",
            "\"private_key",
            "\"sealed_",
            "\"ciphertext\"",
            "\"nonce\"",
            "\"aad_digest\"",
            "\"key_id\"",
        ] {
            assert!(
                !rendered.contains(forbidden),
                "response leaked {forbidden}: {body}"
            );
        }
    }

    // —— unit / behavior ————————————————————————————————————————————

    #[tokio::test]
    async fn given_an_owner_when_creating_a_root_then_it_is_self_signed_and_active() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let headers = owner(&state);
        let view = create_root(&state, &headers, "Behavior Root").await;
        assert_eq!(view["kind"], "root");
        assert_eq!(view["status"], "active");
        assert_eq!(view["subject"]["cn"], "Behavior Root");
        assert_eq!(view["is_self_signed"], Value::Null); // not projected
        assert!(view["certificate"]
            .as_str()
            .unwrap()
            .contains("BEGIN CERTIFICATE"));
        assert_eq!(view["chain"].as_array().unwrap().len(), 1);
        assert_no_key_material(&view);
    }

    #[tokio::test]
    async fn given_a_root_when_creating_an_intermediate_then_the_chain_reaches_the_parent() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let headers = owner(&state);
        let (status, root) = call(
            &state,
            "POST",
            "/api/v1/certmgr/cas",
            &headers,
            Some(json!({
                "kind": "root",
                "subject": {"cn": "Chain Root"},
                "path_len": 1,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{root}");
        let root_id = id_of(&root["certificate_authority"]);

        let (status, child) = call(
            &state,
            "POST",
            "/api/v1/certmgr/cas",
            &headers,
            Some(json!({
                "kind": "intermediate",
                "parent_id": root_id,
                "subject": {"cn": "Chain Intermediate"},
                "path_len": 0,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{child}");
        let view = &child["certificate_authority"];
        assert_eq!(view["kind"], "intermediate");
        assert_eq!(view["parent_id"], root_id);
        assert_eq!(view["path_len"], 0);
        let chain: Vec<String> = serde_json::from_value(view["chain"].clone()).unwrap();
        assert_eq!(chain.len(), 2, "leaf then root");
        bundle::normalize_chain(&chain.join("\n")).expect("chain links up");
        assert_no_key_material(view);
    }

    #[tokio::test]
    async fn given_a_two_level_hierarchy_when_adding_a_third_then_all_three_link() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let headers = owner(&state);
        let (_, root) = call(
            &state,
            "POST",
            "/api/v1/certmgr/cas",
            &headers,
            Some(json!({"kind":"root","subject":{"cn":"Depth Root"},"path_len":2})),
        )
        .await;
        let root_id = id_of(&root["certificate_authority"]);
        let (_, middle) = call(
            &state,
            "POST",
            "/api/v1/certmgr/cas",
            &headers,
            Some(json!({
                "kind":"intermediate","parent_id":root_id,
                "subject":{"cn":"Depth Middle"},"path_len":1
            })),
        )
        .await;
        let middle_id = id_of(&middle["certificate_authority"]);
        let (status, leaf) = call(
            &state,
            "POST",
            "/api/v1/certmgr/cas",
            &headers,
            Some(json!({
                "kind":"intermediate","parent_id":middle_id,
                "subject":{"cn":"Depth Issuing"},"path_len":0
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{leaf}");
        let chain: Vec<String> =
            serde_json::from_value(leaf["certificate_authority"]["chain"].clone()).unwrap();
        assert_eq!(chain.len(), 3);
        bundle::normalize_chain(&chain.join("\n")).expect("three-level chain links up");
    }

    #[tokio::test]
    async fn given_an_unconstrained_root_when_renewing_same_key_then_the_key_is_preserved() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let headers = owner(&state);
        let original = create_root(&state, &headers, "Same Key Root").await;
        let original_id = id_of(&original);
        let (status, renewed) = call(
            &state,
            "POST",
            &format!("/api/v1/certmgr/cas/{original_id}/renew"),
            &headers,
            Some(json!({"mode": "same-key", "validity_days": 400})),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{renewed}");
        let successor = &renewed["certificate_authority"];
        assert_eq!(renewed["renewed_from"], original_id);
        assert_ne!(successor["id"], original["id"]);
        assert_ne!(successor["certificate"], original["certificate"]);
        assert_eq!(successor["renewed_from"], original_id);
        assert_no_key_material(successor);

        // The predecessor is annotated, still active, and still readable.
        let (status, before) = call(
            &state,
            "GET",
            &format!("/api/v1/certmgr/cas/{original_id}"),
            &headers,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{before}");
        assert_eq!(
            before["certificate_authority"]["renewed_by"],
            successor["id"]
        );
        assert_eq!(before["certificate_authority"]["status"], "active");
    }

    #[tokio::test]
    async fn given_certificates_issued_under_a_ca_when_renewing_new_key_then_they_stay_valid() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let headers = owner(&state);
        let organization = state.connection_organization.to_string();
        let original = create_root(&state, &headers, "New Key Root").await;
        let original_id = id_of(&original);

        let now = Utc::now().to_rfc3339();
        let san_json = json!({"dns_names": ["app.example.com"], "ip_addrs": []}).to_string();
        let request = opensesame_storage::StoredCertificateIssuanceRequest {
            id: "req:under-old-ca".into(),
            organization_id: organization.clone(),
            authority_id: original_id.clone(),
            request_digest: "digest".into(),
            idempotency_key: "idem:under-old-ca".into(),
            created_by: "prn_owner".into(),
            state: "created".into(),
            common_name: "app.example.com".into(),
            san_json: san_json.clone(),
            delivery: None,
            expires_at: (Utc::now() + Duration::minutes(5)).to_rfc3339(),
            version: 1,
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        assert!(state
            .db
            .insert_certificate_issuance_request(&request)
            .await
            .unwrap());
        let issued = opensesame_storage::StoredManagedCertificate {
            id: "cert:under-old-ca".into(),
            organization_id: organization.clone(),
            authority_id: original_id.clone(),
            request_id: "req:under-old-ca".into(),
            certificate_digest: "digest".into(),
            serial_number: "01".into(),
            common_name: "app.example.com".into(),
            san_json,
            not_before: now.clone(),
            expires_at: (Utc::now() + Duration::days(30)).to_rfc3339(),
            status: "active".into(),
            application_id: None,
            profile_id: None,
            source: "issued".into(),
            enrollment_method: Some("api".into()),
            metadata_json: "{}".into(),
            key_algorithm: Some("ecdsa-p256".into()),
            signature_algorithm: Some("sha256-ecdsa".into()),
            fingerprint_sha256: None,
            chain_pem: None,
            renewed_from_id: None,
            renewed_by_id: None,
            auto_renew_enabled: false,
            renew_before_seconds: None,
            revocation_reason: None,
            revoked_at: None,
            version: 1,
            created_at: now.clone(),
            updated_at: now,
        };
        state.db.insert_managed_certificate(&issued).await.unwrap();

        let (status, renewed) = call(
            &state,
            "POST",
            &format!("/api/v1/certmgr/cas/{original_id}/renew"),
            &headers,
            Some(json!({"mode": "new-key"})),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{renewed}");

        // Old-issued certificates are untouched: same CA, same status, not revoked.
        let stored = state
            .db
            .get_certificate(&organization, "cert:under-old-ca")
            .await
            .unwrap()
            .expect("certificate survives CA renewal");
        assert_eq!(stored.status, "active");
        assert_eq!(stored.authority_id, original_id);
        assert!(stored.revoked_at.is_none());
        assert!(stored.revocation_reason.is_none());

        // The predecessor authority itself is still there and still active.
        let (status, before) = call(
            &state,
            "GET",
            &format!("/api/v1/certmgr/cas/{original_id}"),
            &headers,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{before}");
        assert_eq!(before["certificate_authority"]["status"], "active");
    }

    #[tokio::test]
    async fn given_an_external_intermediate_when_exporting_and_importing_then_it_activates() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let headers = owner(&state);
        let signer = create_root(&state, &headers, "External Signer Root").await;
        let signer_id = id_of(&signer);

        let (status, pending) = call(
            &state,
            "POST",
            "/api/v1/certmgr/cas",
            &headers,
            Some(json!({
                "kind": "intermediate",
                "external_signing": true,
                "subject": {"cn": "Externally Signed Intermediate"},
                "path_len": 0,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{pending}");
        let pending_view = &pending["certificate_authority"];
        assert_eq!(pending_view["status"], "pending");
        assert_eq!(pending_view["kind"], "intermediate");
        assert_eq!(pending_view["awaiting_external_signature"], true);
        assert_eq!(pending_view["certificate"], Value::Null);
        let pending_id = id_of(pending_view);

        let (status, csr) = call(
            &state,
            "GET",
            &format!("/api/v1/certmgr/cas/{pending_id}/csr"),
            &headers,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{csr}");
        let csr_pem = csr["csr_pem"].as_str().unwrap().to_owned();
        assert!(csr_pem.contains("BEGIN CERTIFICATE REQUEST"));
        assert_no_key_material(&csr);

        let leaf_ca_pem = sign_csr_with(&state, &signer_id, &csr_pem, Some(0)).await;
        let signer_certificate = signer["certificate"].as_str().unwrap().to_owned();
        let (status, imported) = call(
            &state,
            "POST",
            &format!("/api/v1/certmgr/cas/{pending_id}/import-chain"),
            &headers,
            Some(json!({
                "certificate_pem": leaf_ca_pem,
                "chain_pem": signer_certificate,
                "parent_id": signer_id,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{imported}");
        let view = &imported["certificate_authority"];
        assert_eq!(view["status"], "active");
        assert_eq!(view["kind"], "intermediate");
        assert_eq!(view["parent_id"], signer_id);
        assert_eq!(view["awaiting_external_signature"], false);
        assert_no_key_material(view);
    }

    /// Signs `csr_pem` with the sealed key of the authority `signer_id`,
    /// standing in for whatever external CA an operator would use.
    async fn sign_csr_with(
        state: &AppState,
        signer_id: &str,
        csr_pem: &str,
        path_len: Option<u8>,
    ) -> String {
        let organization = state.connection_organization.to_string();
        let sealing = sealing_key(state).unwrap();
        let (authority, config) = load_ca(state, &organization, signer_id)
            .await
            .unwrap()
            .unwrap();
        let key = open_ca_key(&sealing, &authority, &config).unwrap();
        let certificate = stored_certificate(&authority).unwrap();
        let facts = ca::validate_ca(&certificate, None).unwrap();
        let params = CaParams {
            subject: csr::parse_csr(csr_pem).unwrap().subject,
            key_algorithm: KeyAlgorithm::EcdsaP256,
            not_before: facts.not_before,
            not_after: facts.not_after,
            path_len,
            crl_distribution_points: Vec::new(),
        };
        ca::sign_intermediate(&certificate, &key, csr_pem, &params).unwrap()
    }

    #[tokio::test]
    async fn given_four_mirrors_when_patching_then_they_are_stored_and_projected() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let headers = owner(&state);
        let view = create_root(&state, &headers, "Mirror Root").await;
        let id = id_of(&view);
        let mirrors = json!([
            "https://crl-a.example.com/a.crl",
            "https://crl-b.example.com/b.crl",
            "http://crl-c.example.com/c.crl",
            "https://crl-d.example.com/d.crl",
        ]);
        let (status, patched) = call(
            &state,
            "PATCH",
            &format!("/api/v1/certmgr/cas/{id}"),
            &headers,
            Some(json!({"crl_mirrors": mirrors})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{patched}");
        assert_eq!(patched["certificate_authority"]["crl_mirrors"], mirrors);

        let (status, disabled) = call(
            &state,
            "PATCH",
            &format!("/api/v1/certmgr/cas/{id}"),
            &headers,
            Some(json!({"status": "disabled"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{disabled}");
        assert_eq!(disabled["certificate_authority"]["status"], "disabled");
    }

    #[tokio::test]
    async fn given_an_authority_when_patching_signing_config_then_hsm_custody_is_recorded() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let headers = owner(&state);
        let id = id_of(&create_root(&state, &headers, "Signing Config Root").await);

        let (status, read) = call(
            &state,
            "GET",
            &format!("/api/v1/certmgr/cas/{id}/signing-config"),
            &headers,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{read}");
        assert_eq!(read["signing_config"]["key_source"], "sealed");

        let (status, patched) = call(
            &state,
            "PATCH",
            &format!("/api/v1/certmgr/cas/{id}/signing-config"),
            &headers,
            Some(json!({
                "key_source": "hsm",
                "hsm_connector_id": "hsm:one",
                "hsm_key_label": "ca-signing",
                "crl_enabled": false,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{patched}");
        let view = &patched["signing_config"];
        assert_eq!(view["key_source"], "hsm");
        assert_eq!(view["hsm_connector_id"], "hsm:one");
        assert_eq!(view["crl_enabled"], false);
        assert_no_key_material(view);
    }

    #[tokio::test]
    async fn given_authorities_when_listing_then_only_this_organization_is_projected() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let headers = owner(&state);
        create_root(&state, &headers, "Listed Root").await;
        let (status, list) = call(&state, "GET", "/api/v1/certmgr/cas", &headers, None).await;
        assert_eq!(status, StatusCode::OK, "{list}");
        assert_eq!(list["certificate_authorities"].as_array().unwrap().len(), 1);
        assert_no_key_material(&list);

        let (status, foreign) = call(
            &state,
            "GET",
            "/api/v1/certmgr/cas",
            &stranger(&state),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{foreign}");
        assert_eq!(foreign["certificate_authorities"], json!([]));
    }

    #[tokio::test]
    async fn given_a_mutation_when_it_succeeds_then_an_audit_event_is_appended() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let headers = owner(&state);
        let before = state.db.count_unpublished_outbox().await.unwrap();
        let id = id_of(&create_root(&state, &headers, "Audited Root").await);
        let after_create = state.db.count_unpublished_outbox().await.unwrap();
        assert_eq!(after_create, before + 1);
        let (status, _) = call(
            &state,
            "PATCH",
            &format!("/api/v1/certmgr/cas/{id}"),
            &headers,
            Some(json!({"crl_enabled": false})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            state.db.count_unpublished_outbox().await.unwrap(),
            after_create + 1
        );
    }

    // —— adversarial ————————————————————————————————————————————————

    #[tokio::test]
    async fn adversarial_member_cannot_create_a_certificate_authority() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let (status, body) = call(
            &state,
            "POST",
            "/api/v1/certmgr/cas",
            &member(&state),
            Some(root_body("Forbidden Root")),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(body["error"], "forbidden");
        // The gate ran before any state was touched.
        assert!(state
            .db
            .list_certificate_authorities(&state.connection_organization.to_string())
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn adversarial_a_member_cannot_read_or_mutate_any_ca_route() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let id = id_of(&create_root(&state, &owner(&state), "Gated Root").await);
        let headers = member(&state);
        for (method, path, body) in [
            ("GET", "/api/v1/certmgr/cas".to_owned(), None),
            ("GET", format!("/api/v1/certmgr/cas/{id}"), None),
            (
                "PATCH",
                format!("/api/v1/certmgr/cas/{id}"),
                Some(json!({"status":"disabled"})),
            ),
            ("GET", format!("/api/v1/certmgr/cas/{id}/csr"), None),
            (
                "POST",
                format!("/api/v1/certmgr/cas/{id}/import-chain"),
                Some(json!({"certificate_pem":"x"})),
            ),
            (
                "POST",
                format!("/api/v1/certmgr/cas/{id}/renew"),
                Some(json!({"mode":"new-key"})),
            ),
            (
                "GET",
                format!("/api/v1/certmgr/cas/{id}/signing-config"),
                None,
            ),
            (
                "PATCH",
                format!("/api/v1/certmgr/cas/{id}/signing-config"),
                Some(json!({"crl_enabled":false})),
            ),
        ] {
            let (status, _) = call(&state, method, &path, &headers, body).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}");
        }
    }

    #[tokio::test]
    async fn adversarial_a_ca_in_another_organization_is_invisible_not_forbidden() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let id = id_of(&create_root(&state, &owner(&state), "Tenant A Root").await);
        let foreign = stranger(&state);
        for (method, path, body) in [
            ("GET", format!("/api/v1/certmgr/cas/{id}"), None),
            (
                "PATCH",
                format!("/api/v1/certmgr/cas/{id}"),
                Some(json!({"status":"disabled"})),
            ),
            ("GET", format!("/api/v1/certmgr/cas/{id}/csr"), None),
            (
                "POST",
                format!("/api/v1/certmgr/cas/{id}/renew"),
                Some(json!({"mode":"new-key"})),
            ),
            (
                "GET",
                format!("/api/v1/certmgr/cas/{id}/signing-config"),
                None,
            ),
            (
                "PATCH",
                format!("/api/v1/certmgr/cas/{id}/signing-config"),
                Some(json!({"crl_enabled":false})),
            ),
        ] {
            let (status, response) = call(&state, method, &path, &foreign, body).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}");
            assert_eq!(response["error"], "not_found");
        }
    }

    #[tokio::test]
    async fn adversarial_a_path_len_zero_parent_refuses_another_authority_with_400() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let headers = owner(&state);
        let (_, root) = call(
            &state,
            "POST",
            "/api/v1/certmgr/cas",
            &headers,
            Some(json!({"kind":"root","subject":{"cn":"Terminal Root"},"path_len":0})),
        )
        .await;
        let root_id = id_of(&root["certificate_authority"]);
        let (status, body) = call(
            &state,
            "POST",
            "/api/v1/certmgr/cas",
            &headers,
            Some(json!({
                "kind":"intermediate","parent_id":root_id,
                "subject":{"cn":"Refused Intermediate"},"path_len":0
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["error"], "path_len_exceeded");
        assert!(body["hint"].as_str().unwrap().contains("path_len"));
    }

    #[tokio::test]
    async fn adversarial_a_child_may_not_widen_its_parents_path_len_budget() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let headers = owner(&state);
        let (_, root) = call(
            &state,
            "POST",
            "/api/v1/certmgr/cas",
            &headers,
            Some(json!({"kind":"root","subject":{"cn":"Budget Root"},"path_len":1})),
        )
        .await;
        let root_id = id_of(&root["certificate_authority"]);
        let (status, body) = call(
            &state,
            "POST",
            "/api/v1/certmgr/cas",
            &headers,
            Some(json!({
                "kind":"intermediate","parent_id":root_id,
                "subject":{"cn":"Unconstrained Child"}
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["error"], "path_len_exceeded");
    }

    #[tokio::test]
    async fn adversarial_import_chain_refuses_a_certificate_for_a_different_key() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let headers = owner(&state);
        let signer = create_root(&state, &headers, "Mismatch Signer").await;
        let signer_id = id_of(&signer);
        let (_, pending) = call(
            &state,
            "POST",
            "/api/v1/certmgr/cas",
            &headers,
            Some(json!({
                "kind":"intermediate","external_signing":true,
                "subject":{"cn":"Mismatch Target"},"path_len":0
            })),
        )
        .await;
        let pending_id = id_of(&pending["certificate_authority"]);

        // A CSR minted for a *different* key, signed by the same root.
        let other_key = keys::generate(KeyAlgorithm::EcdsaP256).unwrap();
        let foreign_csr =
            csr::generate_csr(&SubjectDn::common_name("Mismatch Target"), &[], &other_key).unwrap();
        let foreign_certificate = sign_csr_with(&state, &signer_id, &foreign_csr, Some(0)).await;

        let (status, body) = call(
            &state,
            "POST",
            &format!("/api/v1/certmgr/cas/{pending_id}/import-chain"),
            &headers,
            Some(json!({
                "certificate_pem": foreign_certificate,
                "chain_pem": signer["certificate"],
                "parent_id": signer_id,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["error"], "key_mismatch");
    }

    #[tokio::test]
    async fn adversarial_import_chain_refuses_a_chain_that_misses_the_named_parent() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let headers = owner(&state);
        let signer = create_root(&state, &headers, "Real Signer").await;
        let signer_id = id_of(&signer);
        let decoy = create_root(&state, &headers, "Decoy Signer").await;
        let decoy_id = id_of(&decoy);

        let (_, pending) = call(
            &state,
            "POST",
            "/api/v1/certmgr/cas",
            &headers,
            Some(json!({
                "kind":"intermediate","external_signing":true,
                "subject":{"cn":"Wrong Parent Target"},"path_len":0
            })),
        )
        .await;
        let pending_id = id_of(&pending["certificate_authority"]);
        let (_, csr_body) = call(
            &state,
            "GET",
            &format!("/api/v1/certmgr/cas/{pending_id}/csr"),
            &headers,
            None,
        )
        .await;
        let csr_pem = csr_body["csr_pem"].as_str().unwrap().to_owned();
        let leaf_ca_pem = sign_csr_with(&state, &signer_id, &csr_pem, Some(0)).await;

        // Signed by `signer`, but the caller names `decoy` as the parent.
        let (status, body) = call(
            &state,
            "POST",
            &format!("/api/v1/certmgr/cas/{pending_id}/import-chain"),
            &headers,
            Some(json!({
                "certificate_pem": leaf_ca_pem,
                "chain_pem": signer["certificate"],
                "parent_id": decoy_id,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["error"], "chain_does_not_reach_parent");
    }

    #[tokio::test]
    async fn adversarial_import_chain_refuses_an_unanchored_chain() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let headers = owner(&state);
        let signer_id = id_of(&create_root(&state, &headers, "Anchor Signer").await);
        let (_, pending) = call(
            &state,
            "POST",
            "/api/v1/certmgr/cas",
            &headers,
            Some(json!({
                "kind":"intermediate","external_signing":true,
                "subject":{"cn":"Unanchored Target"},"path_len":0
            })),
        )
        .await;
        let pending_id = id_of(&pending["certificate_authority"]);
        let (_, csr_body) = call(
            &state,
            "GET",
            &format!("/api/v1/certmgr/cas/{pending_id}/csr"),
            &headers,
            None,
        )
        .await;
        let signed = sign_csr_with(
            &state,
            &signer_id,
            csr_body["csr_pem"].as_str().unwrap(),
            Some(0),
        )
        .await;
        // No parent named and no root appended: nothing anchors the chain.
        let (status, body) = call(
            &state,
            "POST",
            &format!("/api/v1/certmgr/cas/{pending_id}/import-chain"),
            &headers,
            Some(json!({"certificate_pem": signed})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["error"], "chain_not_anchored");
    }

    #[tokio::test]
    async fn adversarial_a_fifth_crl_mirror_is_refused() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let headers = owner(&state);
        let id = id_of(&create_root(&state, &headers, "Mirror Cap Root").await);
        let (status, body) = call(
            &state,
            "PATCH",
            &format!("/api/v1/certmgr/cas/{id}"),
            &headers,
            Some(json!({"crl_mirrors":[
                "https://a.example.com/a.crl",
                "https://b.example.com/b.crl",
                "https://c.example.com/c.crl",
                "https://d.example.com/d.crl",
                "https://e.example.com/e.crl"
            ]})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["error"], "invalid_crl_mirror");
    }

    #[tokio::test]
    async fn adversarial_a_non_http_crl_mirror_is_refused() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let headers = owner(&state);
        let id = id_of(&create_root(&state, &headers, "Scheme Root").await);
        for hostile in [
            "file:///etc/passwd",
            "ldap://directory.example.com/crl",
            "javascript:alert(1)",
            "https://exa mple.com/a.crl",
        ] {
            let (status, body) = call(
                &state,
                "PATCH",
                &format!("/api/v1/certmgr/cas/{id}"),
                &headers,
                Some(json!({"crl_mirrors": [hostile]})),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{hostile} → {body}");
            assert_eq!(body["error"], "invalid_crl_mirror");
        }
    }

    #[tokio::test]
    async fn adversarial_an_ed25519_certificate_authority_is_refused() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let (status, body) = call(
            &state,
            "POST",
            "/api/v1/certmgr/cas",
            &owner(&state),
            Some(json!({
                "kind":"root","subject":{"cn":"Ed Root"},"key_algorithm":"ed25519"
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["error"], "unsupported_ca_key_algorithm");
        assert!(body["hint"].as_str().unwrap().contains("ed25519"));
    }

    #[tokio::test]
    async fn adversarial_export_csr_on_a_signed_authority_is_a_conflict() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let headers = owner(&state);
        let id = id_of(&create_root(&state, &headers, "No CSR Root").await);
        let (status, body) = call(
            &state,
            "GET",
            &format!("/api/v1/certmgr/cas/{id}/csr"),
            &headers,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["error"], "no_pending_csr");
    }

    #[tokio::test]
    async fn adversarial_a_foreign_parent_id_cannot_be_borrowed_across_organizations() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let parent_id = id_of(&create_root(&state, &owner(&state), "Borrowed Parent").await);
        let (status, body) = call(
            &state,
            "POST",
            "/api/v1/certmgr/cas",
            &stranger(&state),
            Some(json!({
                "kind":"intermediate","parent_id":parent_id,
                "subject":{"cn":"Borrowing Child"},"path_len":0
            })),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    }

    #[tokio::test]
    async fn adversarial_unknown_body_fields_are_refused() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let headers = owner(&state);
        let status = call_raw(
            &state,
            "POST",
            "/api/v1/certmgr/cas",
            &headers,
            json!({
                "kind":"root","subject":{"cn":"Sneaky"},
                "sealed_ciphertext":"AAAA"
            })
            .to_string(),
        )
        .await;
        assert!(status.is_client_error(), "{status}");
        assert_ne!(status, StatusCode::INTERNAL_SERVER_ERROR);
    }

    // —— chaos ——————————————————————————————————————————————————————

    #[tokio::test]
    async fn chaos_oversized_subject_fields_are_refused_without_a_500() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let headers = owner(&state);
        for subject in [
            json!({"cn": "x".repeat(65)}),
            json!({"o": "y".repeat(4096)}),
            json!({"cn": "  "}),
            json!({}),
            json!({"dc": ["a", "b", "c", "d", "e"]}),
        ] {
            let (status, body) = call(
                &state,
                "POST",
                "/api/v1/certmgr/cas",
                &headers,
                Some(json!({"kind":"root","subject":subject})),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
            assert_eq!(body["error"], "invalid_subject");
        }
    }

    #[tokio::test]
    async fn chaos_a_giant_or_garbage_chain_is_refused_without_a_500() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let headers = owner(&state);
        let (_, pending) = call(
            &state,
            "POST",
            "/api/v1/certmgr/cas",
            &headers,
            Some(json!({
                "kind":"intermediate","external_signing":true,
                "subject":{"cn":"Chaos Target"},"path_len":0
            })),
        )
        .await;
        let id = id_of(&pending["certificate_authority"]);

        // Over the 512 KiB route limit: the layer rejects it, not the handler.
        let oversized = call_raw(
            &state,
            "POST",
            &format!("/api/v1/certmgr/cas/{id}/import-chain"),
            &headers,
            json!({"certificate_pem":"x", "chain_pem":"A".repeat(1024 * 1024)}).to_string(),
        )
        .await;
        assert_ne!(oversized, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(oversized.is_client_error(), "{oversized}");

        // Under the route limit but over the engine's chain bound, plus a
        // grab-bag of malformed and deeply nested PEM.
        for hostile in [
            "A".repeat(400 * 1024),
            "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----".into(),
            "-----BEGIN CERTIFICATE-----\n".repeat(2048),
            String::new(),
            "\u{0}\u{0}\u{0}".into(),
            format!(
                "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----",
                "e".repeat(70_000)
            ),
        ] {
            let (status, body) = call(
                &state,
                "POST",
                &format!("/api/v1/certmgr/cas/{id}/import-chain"),
                &headers,
                Some(json!({"certificate_pem": hostile})),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        }
    }

    #[tokio::test]
    async fn chaos_a_path_len_of_255_is_accepted_and_reported() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let (status, body) = call(
            &state,
            "POST",
            "/api/v1/certmgr/cas",
            &owner(&state),
            Some(json!({
                "kind":"root","subject":{"cn":"Deep Root"},"path_len":255
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        assert_eq!(body["certificate_authority"]["path_len"], 255);
    }

    #[tokio::test]
    async fn chaos_a_path_len_above_the_encoding_bound_is_refused() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let status = call_raw(
            &state,
            "POST",
            "/api/v1/certmgr/cas",
            &owner(&state),
            json!({"kind":"root","subject":{"cn":"Too Deep"},"path_len":256}).to_string(),
        )
        .await;
        assert!(status.is_client_error(), "{status}");
        assert_ne!(status, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn chaos_concurrent_creates_for_one_subject_all_succeed_with_distinct_ids() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let headers = owner(&state);
        let mut tasks = Vec::new();
        for _ in 0..4 {
            tasks.push(tokio::spawn(call_owned(
                state.clone(),
                "POST",
                "/api/v1/certmgr/cas".to_owned(),
                headers.clone(),
                Some(root_body("Racing Root")),
            )));
        }
        let mut ids = std::collections::BTreeSet::new();
        for task in tasks {
            let (status, body) = task.await.unwrap();
            assert_eq!(status, StatusCode::CREATED, "{body}");
            ids.insert(id_of(&body["certificate_authority"]));
        }
        assert_eq!(ids.len(), 4, "each create claims its own identity");
    }

    #[tokio::test]
    async fn chaos_concurrent_patches_leave_exactly_one_winner_per_version() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let headers = owner(&state);
        let id = id_of(&create_root(&state, &headers, "Racing Patch Root").await);
        let (_, config) = call(
            &state,
            "GET",
            &format!("/api/v1/certmgr/cas/{id}/signing-config"),
            &headers,
            None,
        )
        .await;
        let version = config["signing_config"]["version"].as_i64().unwrap();

        let mut tasks = Vec::new();
        for index in 0..4 {
            tasks.push(tokio::spawn(call_owned(
                state.clone(),
                "PATCH",
                format!("/api/v1/certmgr/cas/{id}/signing-config"),
                headers.clone(),
                Some(json!({
                    "expected_version": version,
                    "crl_mirrors": [format!("https://mirror-{index}.example.com/a.crl")]
                })),
            )));
        }
        let mut winners = 0;
        for task in tasks {
            let (status, body) = task.await.unwrap();
            assert_ne!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
            assert!(
                status == StatusCode::OK || status == StatusCode::CONFLICT,
                "{body}"
            );
            winners += usize::from(status == StatusCode::OK);
        }
        assert_eq!(winners, 1, "compare-and-swap admits exactly one writer");
    }

    // —— contract / pact ————————————————————————————————————————————

    /// The textual key-algorithm values this module accepts must be exactly
    /// the ones migration 0016's `CHECK` constraint allows, minus the
    /// deliberately excluded `ed25519`.
    #[test]
    fn pact_accepted_key_algorithms_match_the_ddl_check_set() {
        let ddl: Vec<&str> = vec![
            "rsa-2048",
            "rsa-4096",
            "ecdsa-p256",
            "ecdsa-p384",
            "ed25519",
        ];
        for value in &ddl {
            let accepted = parse_key_algorithm(value).is_ok();
            assert_eq!(
                accepted,
                *value != "ed25519",
                "{value} acceptance drifted from the DDL contract"
            );
        }
        for algorithm in KeyAlgorithm::ALL {
            assert!(
                ddl.contains(&algorithm.as_str()),
                "{algorithm} is not in the 0016 CHECK set"
            );
        }
        assert!(parse_key_algorithm("secp256k1").is_err());
    }

    /// The seal scope is part of the AAD of every stored CA key; renaming it
    /// makes existing ciphertext unopenable.
    #[test]
    fn pact_seal_scope_and_key_id_are_pinned() {
        assert_eq!(CA_SCOPE, "certificate_authority");
        assert_eq!(KEY_ID, "opensesame-connection-key:v1");
        assert_eq!(CERTMGR_ISSUER, "opensesame_certmgr");
    }

    /// Audit event names are consumed by the outbox; they are a contract.
    #[test]
    fn pact_audit_event_names_are_namespaced_under_certmgr_ca() {
        for event in [
            EVENT_CREATED,
            EVENT_UPDATED,
            EVENT_IMPORTED,
            EVENT_RENEWED,
            EVENT_SIGNING_CONFIG,
        ] {
            assert!(event.starts_with("certmgr.ca."), "{event}");
        }
        assert_eq!(EVENT_CREATED, "certmgr.ca.created");
        assert_eq!(EVENT_RENEWED, "certmgr.ca.renewed");
    }

    /// Body limits are part of the route table the Assembler mounts.
    #[test]
    fn pact_body_limits_match_the_route_table() {
        assert_eq!(MAX_BODY, 16 * 1024);
        assert_eq!(MAX_IMPORT_BODY, 512 * 1024);
    }

    /// Every mutating body refuses fields it does not model, so a caller
    /// cannot smuggle a sealed column in.
    #[test]
    fn pact_every_body_denies_unknown_fields() {
        assert!(serde_json::from_value::<CreateCaBody>(
            json!({"kind":"root","subject":{"cn":"a"},"sealed_ciphertext":"x"})
        )
        .is_err());
        assert!(
            serde_json::from_value::<PatchCaBody>(json!({"status":"active","extra":1})).is_err()
        );
        assert!(serde_json::from_value::<ImportChainBody>(
            json!({"certificate_pem":"x","private_key_pem":"y"})
        )
        .is_err());
        assert!(
            serde_json::from_value::<RenewCaBody>(json!({"mode":"new-key","force":true})).is_err()
        );
        assert!(serde_json::from_value::<PatchSigningConfigBody>(
            json!({"key_algorithm":"rsa-4096"})
        )
        .is_err());
    }

    // —— snapshot ———————————————————————————————————————————————————

    /// Redacts everything that is nondeterministic or is a PEM body, so the
    /// snapshot pins the *shape* and never carries certificate bytes.
    macro_rules! ca_redactions {
        () => {{
            let mut settings = insta::Settings::clone_current();
            settings.add_redaction(".**.id", "[id]");
            settings.add_redaction(".**.certificate_authority_id", "[id]");
            settings.add_redaction(".**.certificate", "[certificate-pem]");
            settings.add_redaction(".**.chain", "[chain-pem]");
            settings.add_redaction(".**.csr_pem", "[csr-pem]");
            settings.add_redaction(".**.serial_hex", "[serial]");
            settings.add_redaction(".**.fingerprint_sha256", "[fingerprint]");
            settings.add_redaction(".**.not_before", "[timestamp]");
            settings.add_redaction(".**.not_after", "[timestamp]");
            settings.add_redaction(".**.created_at", "[timestamp]");
            settings.add_redaction(".**.updated_at", "[timestamp]");
            settings
        }};
    }

    #[tokio::test]
    async fn snapshot_create_get_and_list_response_shapes_are_pinned() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let headers = owner(&state);
        let (status, created) = call(
            &state,
            "POST",
            "/api/v1/certmgr/cas",
            &headers,
            Some(json!({
                "kind":"root",
                "display_name":"Snapshot Root",
                "subject":{"cn":"Snapshot Root","o":"OpenSesame","c":"US"},
                "key_algorithm":"ecdsa-p256",
                "validity_days":365,
                "path_len":1,
                "crl_distribution_points":["https://crl.example.com/root.crl"],
                "crl_mirrors":["https://mirror.example.com/root.crl"]
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{created}");
        assert_no_key_material(&created);
        let id = id_of(&created["certificate_authority"]);

        let (_, fetched) = call(
            &state,
            "GET",
            &format!("/api/v1/certmgr/cas/{id}"),
            &headers,
            None,
        )
        .await;
        let (_, listed) = call(&state, "GET", "/api/v1/certmgr/cas", &headers, None).await;
        let (_, config) = call(
            &state,
            "GET",
            &format!("/api/v1/certmgr/cas/{id}/signing-config"),
            &headers,
            None,
        )
        .await;

        let settings = ca_redactions!();
        settings.bind(|| {
            insta::assert_json_snapshot!("certmgr_ca_create", created);
            insta::assert_json_snapshot!("certmgr_ca_get", fetched);
            insta::assert_json_snapshot!("certmgr_ca_list", listed);
            insta::assert_json_snapshot!("certmgr_ca_signing_config", config);
        });
    }

    #[tokio::test]
    async fn snapshot_error_bodies_are_pinned() {
        let _guard = env_lock();
        let state = sealed_state().await;
        let owner_headers = owner(&state);
        let id = id_of(&create_root(&state, &owner_headers, "Error Shape Root").await);

        let (_, forbidden) = call(
            &state,
            "POST",
            "/api/v1/certmgr/cas",
            &member(&state),
            Some(root_body("Nope")),
        )
        .await;
        let (_, missing) = call(
            &state,
            "GET",
            "/api/v1/certmgr/cas/ca:certmgr:absent",
            &owner_headers,
            None,
        )
        .await;
        let (_, bad_kind) = call(
            &state,
            "POST",
            "/api/v1/certmgr/cas",
            &owner_headers,
            Some(json!({"kind":"leaf","subject":{"cn":"x"}})),
        )
        .await;
        let (_, bad_algorithm) = call(
            &state,
            "POST",
            "/api/v1/certmgr/cas",
            &owner_headers,
            Some(json!({"kind":"root","subject":{"cn":"x"},"key_algorithm":"ed25519"})),
        )
        .await;
        let (_, no_csr) = call(
            &state,
            "GET",
            &format!("/api/v1/certmgr/cas/{id}/csr"),
            &owner_headers,
            None,
        )
        .await;
        let (_, mirrors) = call(
            &state,
            "PATCH",
            &format!("/api/v1/certmgr/cas/{id}"),
            &owner_headers,
            Some(json!({"crl_mirrors":["ftp://x.example.com/a.crl"]})),
        )
        .await;

        insta::assert_json_snapshot!("certmgr_ca_error_forbidden", forbidden);
        insta::assert_json_snapshot!("certmgr_ca_error_not_found", missing);
        insta::assert_json_snapshot!("certmgr_ca_error_invalid_kind", bad_kind);
        insta::assert_json_snapshot!("certmgr_ca_error_bad_algorithm", bad_algorithm);
        insta::assert_json_snapshot!("certmgr_ca_error_no_pending_csr", no_csr);
        insta::assert_json_snapshot!("certmgr_ca_error_invalid_mirror", mirrors);
    }

    // —— property ———————————————————————————————————————————————————

    fn attribute() -> impl Strategy<Value = String> {
        "[A-Za-z0-9][A-Za-z0-9 .-]{0,31}".prop_map(|value| value.trim().to_owned())
    }

    proptest! {
        #![proptest_config(ProptestConfig { cases: 8, failure_persistence: None, ..ProptestConfig::default() })]

        /// Any distinguished name this module accepts round-trips through the
        /// certificate it issues: create → get returns the same attributes.
        #[test]
        fn property_subject_round_trips_through_create_and_get(
            cn in attribute(),
            o in attribute(),
            ou in attribute(),
            country in "[A-Z]{2}",
        ) {
            prop_assume!(!cn.is_empty() && !o.is_empty() && !ou.is_empty());
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async {
                let _guard = env_lock();
                let state = sealed_state().await;
                let headers = owner(&state);
                let subject = json!({"cn": cn, "o": o, "ou": ou, "c": country});
                let (status, created) = call(
                    &state,
                    "POST",
                    "/api/v1/certmgr/cas",
                    &headers,
                    Some(json!({"kind":"root","subject": subject})),
                )
                .await;
                prop_assert_eq!(status, StatusCode::CREATED, "{}", created);
                let id = id_of(&created["certificate_authority"]);
                let (status, fetched) = call(
                    &state,
                    "GET",
                    &format!("/api/v1/certmgr/cas/{id}"),
                    &headers,
                    None,
                )
                .await;
                prop_assert_eq!(status, StatusCode::OK);
                prop_assert_eq!(&fetched["certificate_authority"]["subject"], &subject);
                assert_no_key_material(&fetched);
                Ok(())
            })?;
        }

        /// No hostile create body ever produces a 500.
        #[test]
        fn property_rejected_create_bodies_never_produce_a_500(
            kind in "[a-z]{0,12}",
            cn in ".{0,200}",
            algorithm in "[a-z0-9-]{0,20}",
            days in -5i64..100_000i64,
            path_len in 0u16..300,
        ) {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async {
                let _guard = env_lock();
                let state = sealed_state().await;
                let headers = owner(&state);
                let body = json!({
                    "kind": kind,
                    "subject": {"cn": cn},
                    "key_algorithm": algorithm,
                    "validity_days": days,
                    "path_len": path_len,
                });
                let status = call_raw(
                    &state,
                    "POST",
                    "/api/v1/certmgr/cas",
                    &headers,
                    body.to_string(),
                )
                .await;
                prop_assert_ne!(status, StatusCode::INTERNAL_SERVER_ERROR);
                Ok(())
            })?;
        }
    }
}
