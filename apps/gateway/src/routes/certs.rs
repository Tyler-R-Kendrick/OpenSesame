//! Host-owned certificate issuance.
//!
//! `OpenSesame` generates keys and acts as the private CA by default. Persisted
//! authority and one-time delivery material is always sealed; development may
//! use a clearly labeled process-ephemeral CA when no sealing key exists.

use std::time::Duration as StdDuration;
use std::{collections::BTreeMap, net::IpAddr};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use base64::{engine::general_purpose::URL_SAFE, engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{Duration, Utc};
use opensesame_connection_broker::{
    crypto::{open_scoped, seal_scoped, SealedBlob},
    ConnectionStatus, ConnectionView,
};
use opensesame_storage::{
    SealedCertificateDelivery, SealedCertificateMaterial, StoredCertificateAuthority,
    StoredCertificateIssuanceRequest, StoredIssuedCertificate,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use x509_parser::{pem::parse_x509_pem, prelude::parse_x509_certificate};

use crate::app_state::AppState;
use crate::cert_issuers::{
    AcmeAccount, AcmeAccountCredentials, AcmeEnvironment, AcmeProvider, CertificateRequest,
    CertificateRequestInput, ChallengeKind, CloudflareDns01, CloudflareOriginApiResponse,
    CloudflareOriginRequest, CloudflareOriginValidity, ExternalAccountBinding,
    GeneratedLeafRequest, IssuedCertificate, IssuerKind, TrustClass,
};
use crate::dev_pki::{self, DevCa, IssuedRecord, DEFAULT_TTL, DEV_CA_CN};
use crate::middleware::auth::{resolve_caller, resolve_caller_organization, Caller};

const KV_CA: &str = "certs.dev_ca";
const KV_ISSUED: &str = "certs.issued";
const MAX_ISSUED: usize = 256;
const CA_SCOPE: &str = "certificate_authority";
const DELIVERY_SCOPE: &str = "certificate_delivery";
const KEY_ID: &str = "opensesame-connection-key:v1";
const INTERNAL_ISSUER: &str = "opensesame_private_ca";
const REQUEST_TTL_MINUTES: i64 = 5;
const DELIVERY_TTL_MINUTES: i64 = 10;

fn issued_kv_key(organization: &opensesame_domain::OrganizationId) -> String {
    format!("{KV_ISSUED}:{organization}")
}

enum ResolvedCa {
    Persisted { authority_id: String, ca: DevCa },
    Ephemeral(DevCa),
}

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
                "hint": "owner or admin role required to issue certificates"
            })),
        )
            .into_response());
    }
    Ok(who)
}

fn delivery_actor(caller: &Caller) -> String {
    match caller {
        Caller::Operator => "operator".into(),
        Caller::Session { subject, .. } => subject.clone(),
    }
}

fn internal(error: impl std::fmt::Display, context: &'static str) -> Response {
    tracing::error!(%error, %context, "certificate operation failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error":"internal","hint":"certificate operation failed"})),
    )
        .into_response()
}

fn sealing_unavailable(hint: &'static str) -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({"error":"certificate_key_protection_unavailable","hint":hint})),
    )
        .into_response()
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

async fn persisted_internal_ca(
    st: &AppState,
    organization: &str,
    key: &[u8; 32],
) -> Result<Option<(String, DevCa)>, Response> {
    let authorities = st
        .db
        .list_certificate_authorities(organization)
        .await
        .map_err(|error| internal(error, "list certificate authorities"))?;
    let Some(authority) = authorities
        .into_iter()
        .find(|authority| authority.issuer_kind == INTERNAL_ISSUER && authority.status == "active")
    else {
        return Ok(None);
    };
    if authority.sealed_material.key_id != KEY_ID {
        return Err(sealing_unavailable(
            "certificate authority uses an unsupported sealing key id",
        ));
    }
    let plaintext = open_scoped(
        key,
        CA_SCOPE,
        &authority.id,
        organization,
        &sealed_blob(&authority.sealed_material),
    )
    .map_err(|error| internal(error, "open certificate authority"))?;
    let ca = serde_json::from_slice(&plaintext)
        .map_err(|error| internal(error, "decode certificate authority"))?;
    dev_pki::validate_ca(&ca).map_err(|error| internal(error, "validate certificate authority"))?;
    Ok(Some((authority.id, ca)))
}

async fn persist_internal_ca(
    st: &AppState,
    organization: &str,
    key: &[u8; 32],
    ca: &DevCa,
) -> Result<String, Response> {
    let authority_id = format!("ca:opensesame:{organization}");
    let plaintext =
        serde_json::to_vec(ca).map_err(|error| internal(error, "encode certificate authority"))?;
    let sealed = seal_scoped(key, CA_SCOPE, &authority_id, organization, &plaintext)
        .map_err(|error| internal(error, "seal certificate authority"))?;
    let now = Utc::now().to_rfc3339();
    let is_default = st
        .db
        .get_default_certificate_authority(organization)
        .await
        .map_err(|error| internal(error, "read default certificate authority"))?
        .is_none();
    let authority = StoredCertificateAuthority {
        id: authority_id.clone(),
        organization_id: organization.into(),
        issuer_kind: INTERNAL_ISSUER.into(),
        issuer_connection_id: None,
        display_name: "OpenSesame Private CA".into(),
        public_metadata_json: json!({
            "certificate": ca.cert_pem,
            "trust_scope": "private_local",
            "purpose": "local_tls"
        })
        .to_string(),
        sealed_material: stored_material(sealed),
        is_default,
        status: "active".into(),
        version: 1,
        created_at: now.clone(),
        updated_at: now,
    };
    match st.db.insert_certificate_authority(&authority).await {
        Ok(()) => Ok(authority_id),
        Err(error) => {
            if let Some((existing_id, _)) = persisted_internal_ca(st, organization, key).await? {
                Ok(existing_id)
            } else {
                Err(internal(error, "persist certificate authority"))
            }
        }
    }
}

async fn load_or_create_ca(
    st: &AppState,
    organization: &opensesame_domain::OrganizationId,
) -> Result<ResolvedCa, Response> {
    let organization = organization.to_string();
    let key = st.connection_broker.config().key().copied();
    if let Some(key) = key {
        if let Some((authority_id, ca)) = persisted_internal_ca(st, &organization, &key).await? {
            if let Some(raw) = st
                .db
                .get_host_kv(KV_CA)
                .await
                .map_err(|error| internal(error, "read legacy certificate authority"))?
            {
                let legacy: DevCa = serde_json::from_str(&raw)
                    .map_err(|error| internal(error, "decode legacy certificate authority"))?;
                reject_conflicting_legacy_ca(&legacy, &ca)?;
                st.db
                    .delete_host_kv(KV_CA)
                    .await
                    .map_err(|error| internal(error, "remove migrated certificate authority"))?;
            }
            return Ok(ResolvedCa::Persisted { authority_id, ca });
        }
        let ca = match st
            .db
            .get_host_kv(KV_CA)
            .await
            .map_err(|error| internal(error, "read legacy certificate authority"))?
        {
            Some(raw) => serde_json::from_str(&raw)
                .map_err(|error| internal(error, "decode legacy certificate authority"))?,
            None => dev_pki::generate_dev_ca()
                .map_err(|error| internal(error, "generate certificate authority"))?,
        };
        dev_pki::validate_ca(&ca)
            .map_err(|error| internal(error, "validate certificate authority"))?;
        let authority_id = persist_internal_ca(st, &organization, &key, &ca).await?;
        let (_, persisted) = persisted_internal_ca(st, &organization, &key)
            .await?
            .ok_or_else(|| {
                internal(
                    "authority missing after insert",
                    "verify certificate authority",
                )
            })?;
        if persisted.cert_pem != ca.cert_pem || persisted.key_pem != ca.key_pem {
            return Err(sealing_unavailable(
                "certificate authority changed concurrently; retry issuance",
            ));
        }
        if st
            .db
            .get_host_kv(KV_CA)
            .await
            .map_err(|error| internal(error, "verify legacy certificate authority"))?
            .is_some()
        {
            st.db
                .delete_host_kv(KV_CA)
                .await
                .map_err(|error| internal(error, "remove migrated certificate authority"))?;
        }
        return Ok(ResolvedCa::Persisted {
            authority_id,
            ca: persisted,
        });
    }

    if st
        .db
        .get_host_kv(KV_CA)
        .await
        .map_err(|error| internal(error, "inspect legacy certificate authority"))?
        .is_some()
    {
        return Err(sealing_unavailable(
            "set OPENSESAME_CONNECTION_KEY to migrate the existing certificate authority",
        ));
    }
    if crate::config::is_production_env() {
        return Err(sealing_unavailable(
            "set OPENSESAME_CONNECTION_KEY before issuing certificates in production",
        ));
    }
    let mut ephemeral = st
        .ephemeral_certificate_ca
        .lock()
        .map_err(|error| internal(error, "lock development certificate authority"))?;
    if ephemeral.is_none() {
        *ephemeral = Some(
            dev_pki::generate_dev_ca()
                .map_err(|error| internal(error, "generate development certificate authority"))?,
        );
    }
    Ok(ResolvedCa::Ephemeral(
        ephemeral
            .as_ref()
            .expect("ephemeral CA initialized")
            .clone(),
    ))
}

fn reject_conflicting_legacy_ca(legacy: &DevCa, sealed: &DevCa) -> Result<(), Response> {
    if legacy.cert_pem != sealed.cert_pem || legacy.key_pem != sealed.key_pem {
        return Err(sealing_unavailable(
            "legacy and sealed certificate authorities conflict; operator review required",
        ));
    }
    Ok(())
}

async fn load_issued(
    st: &AppState,
    organization: &opensesame_domain::OrganizationId,
) -> Result<Vec<IssuedRecord>, Response> {
    let key = issued_kv_key(organization);
    let Some(raw) = st
        .db
        .get_host_kv(&key)
        .await
        .map_err(|error| internal(error, "read legacy issued certificate metadata"))?
    else {
        return Ok(Vec::new());
    };
    serde_json::from_str(&raw)
        .map_err(|error| internal(error, "decode legacy issued certificate metadata"))
}

async fn save_issued(
    st: &AppState,
    organization: &opensesame_domain::OrganizationId,
    rows: &[IssuedRecord],
) -> Result<(), Response> {
    let encoded = serde_json::to_string(rows)
        .map_err(|error| internal(error, "encode legacy issued certificate metadata"))?;
    let key = issued_kv_key(organization);
    st.db
        .set_host_kv(&key, &encoded)
        .await
        .map_err(|error| internal(error, "write legacy issued certificate metadata"))
}

pub async fn get_ca(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization = match resolve_caller_organization(&st, &who, &headers) {
        Ok(organization) => organization,
        Err(response) => return response,
    };
    match load_or_create_ca(&st, &organization).await {
        Ok(ResolvedCa::Persisted { ca, .. }) => (
            StatusCode::OK,
            Json(json!({
                "ca": {
                    "common_name": DEV_CA_CN,
                    "certificate": ca.cert_pem,
                    "purpose": "local_tls",
                    "trust_scope": "private_local",
                    "persistent": true,
                }
            })),
        )
            .into_response(),
        Ok(ResolvedCa::Ephemeral(ca)) => (
            StatusCode::OK,
            Json(json!({
                "ca": {
                    "common_name": DEV_CA_CN,
                    "certificate": ca.cert_pem,
                    "purpose": "local_tls",
                    "trust_scope": "private_local",
                    "persistent": false,
                }
            })),
        )
            .into_response(),
        Err(resp) => resp,
    }
}

pub async fn list_issued(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization = match resolve_caller_organization(&st, &who, &headers) {
        Ok(organization) => organization,
        Err(response) => return response,
    };
    let authorities = match st
        .db
        .list_certificate_authorities(&organization.to_string())
        .await
    {
        Ok(authorities) => authorities
            .into_iter()
            .map(|authority| (authority.id.clone(), authority))
            .collect::<BTreeMap<_, _>>(),
        Err(error) => return internal(error, "list certificate authorities"),
    };
    let current = match st
        .db
        .list_issued_certificates_expiring_before(&organization.to_string(), "9999-12-31T23:59:59Z")
        .await
    {
        Ok(certificates) => certificates,
        Err(error) => return internal(error, "list issued certificates"),
    };
    let legacy = match load_issued(&st, &organization).await {
        Ok(certificates) => certificates,
        Err(response) => return response,
    };
    let mut certificates: Vec<Value> = current
        .into_iter()
        .map(|certificate| {
            let authority = authorities.get(&certificate.authority_id);
            let metadata = authority
                .and_then(|authority| serde_json::from_str::<Value>(&authority.public_metadata_json).ok())
                .unwrap_or_else(|| json!({}));
            json!({
                "id": certificate.id,
                "serial": certificate.serial_number,
                "common_name": certificate.common_name,
                "dns_names": serde_json::from_str::<Value>(&certificate.san_json)
                    .ok()
                    .and_then(|sans| sans.get("dns_names").cloned())
                    .unwrap_or_else(|| json!([])),
                "not_before": certificate.not_before,
                "not_after": certificate.expires_at,
                "issued_at": certificate.created_at,
                "issuer": authority.map_or("Unknown issuer", |authority| authority.display_name.as_str()),
                "issuer_kind": authority.map_or("unknown", |authority| authority.issuer_kind.as_str()),
                "trust_scope": metadata.get("trust_scope").and_then(Value::as_str).unwrap_or("unknown"),
            })
        })
        .collect();
    certificates.extend(
        legacy
            .into_iter()
            .filter_map(|certificate| serde_json::to_value(certificate).ok()),
    );
    (
        StatusCode::OK,
        Json(json!({ "certificates": certificates })),
    )
        .into_response()
}

pub async fn acknowledge_delivery(
    State(st): State<AppState>,
    Path(request_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization = match resolve_caller_organization(&st, &who, &headers) {
        Ok(organization) => organization,
        Err(response) => return response,
    };
    let actor = delivery_actor(&who);
    match st
        .db
        .acknowledge_certificate_delivery(&organization.to_string(), &request_id, &actor)
        .await
    {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"delivery_not_found"})),
        )
            .into_response(),
        Err(error) => internal(error, "acknowledge certificate delivery"),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IssueBody {
    pub common_name: String,
    #[serde(default)]
    pub dns_names: Vec<String>,
    #[serde(default)]
    pub ip_addrs: Vec<String>,
    #[serde(default)]
    pub ttl_hours: Option<u64>,
    #[serde(default)]
    pub issuer_connection_id: Option<String>,
}

fn issue_response(
    issued: &dev_pki::IssuedCert,
    delivery_id: Option<&str>,
    persistent: bool,
    issuer_label: &str,
    issuer_kind: &str,
    trust_scope: &str,
) -> Response {
    (
        StatusCode::OK,
        Json(json!({
            "certificate": issued.certificate,
            "private_key": issued.private_key,
            "ca_certificate": issued.ca_certificate,
            "serial": issued.serial,
            "common_name": issued.common_name,
            "dns_names": issued.dns_names,
            "not_before": issued.not_before,
            "not_after": issued.not_after,
            "delivery_id": delivery_id,
            "issuer": issuer_label,
            "issuer_kind": issuer_kind,
            "purpose": "local_tls",
            "trust_scope": trust_scope,
            "persistent": persistent,
        })),
    )
        .into_response()
}

fn idempotency_key(headers: &axum::http::HeaderMap) -> Result<String, Response> {
    let Some(raw) = headers.get("idempotency-key") else {
        return Ok(uuid::Uuid::new_v4().to_string());
    };
    let key = raw.to_str().unwrap_or_default().trim();
    if key.is_empty()
        || key.len() > 128
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_request","hint":"Idempotency-Key must be 1-128 URL-safe characters"})),
        )
            .into_response());
    }
    Ok(key.into())
}

fn request_digest(
    organization: &str,
    authority_id: &str,
    request: &dev_pki::IssueRequest,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"opensesame:certificate-request:v1\0");
    hasher.update(organization.as_bytes());
    hasher.update(b"\0");
    hasher.update(authority_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(request.common_name.as_bytes());
    for name in &request.dns_names {
        hasher.update(b"\0dns:");
        hasher.update(name.as_bytes());
    }
    for address in &request.ip_addrs {
        hasher.update(b"\0ip:");
        hasher.update(address.to_string().as_bytes());
    }
    hasher.update(b"\0ttl:");
    hasher.update(request.ttl.as_secs().to_be_bytes());
    hex::encode(hasher.finalize())
}

struct DeliveredCertificate {
    issued: dev_pki::IssuedCert,
    delivery_id: Option<String>,
}

async fn read_delivery(
    st: &AppState,
    organization: &str,
    request_id: &str,
    actor: &str,
    key: &[u8; 32],
) -> Result<DeliveredCertificate, Response> {
    let delivery = st
        .db
        .get_certificate_delivery(
            organization,
            request_id,
            actor,
            &Utc::now().to_rfc3339(),
        )
        .await
        .map_err(|error| internal(error, "take certificate delivery"))?
        .ok_or_else(|| {
            (
                StatusCode::CONFLICT,
                Json(json!({"error":"certificate_material_unavailable","hint":"certificate material was already delivered or expired; reissue the certificate"})),
            )
                .into_response()
        })?;
    if delivery.material.key_id != KEY_ID {
        return Err(sealing_unavailable(
            "certificate delivery uses an unsupported sealing key id",
        ));
    }
    let plaintext = open_scoped(
        key,
        DELIVERY_SCOPE,
        request_id,
        organization,
        &sealed_blob(&delivery.material),
    )
    .map_err(|error| internal(error, "open certificate delivery"))?;
    let issued = serde_json::from_slice(&plaintext)
        .map_err(|error| internal(error, "decode certificate delivery"))?;
    Ok(DeliveredCertificate {
        issued,
        delivery_id: Some(request_id.into()),
    })
}

enum PreparedIssuance {
    Delivered(DeliveredCertificate),
    New(PendingIssuance),
}

struct PendingIssuance {
    request_id: String,
    san_json: String,
    key: [u8; 32],
}

async fn prepare_persisted_issuance(
    st: &AppState,
    headers: &axum::http::HeaderMap,
    organization: &str,
    authority_id: &str,
    actor: &str,
    request: &dev_pki::IssueRequest,
) -> Result<PreparedIssuance, Response> {
    let key = st
        .connection_broker
        .config()
        .key()
        .copied()
        .ok_or_else(|| sealing_unavailable("certificate key protection is unavailable"))?;
    let digest = request_digest(organization, authority_id, request);
    let idempotency_key = idempotency_key(headers)?;
    if let Some(existing) = st
        .db
        .find_certificate_issuance_by_idempotency(organization, &idempotency_key)
        .await
        .map_err(|error| internal(error, "read certificate idempotency record"))?
    {
        if existing.created_by != actor {
            return Err((
                StatusCode::CONFLICT,
                Json(json!({"error":"idempotency_conflict"})),
            )
                .into_response());
        }
        if existing.request_digest != digest {
            return Err((
                StatusCode::CONFLICT,
                Json(json!({"error":"idempotency_mismatch","hint":"Idempotency-Key was already used for a different certificate request"})),
            )
                .into_response());
        }
        if existing.state != "completed" {
            return Err((
                StatusCode::CONFLICT,
                Json(json!({"error":"issuance_in_progress","hint":"the matching certificate request has not completed"})),
            )
                .into_response());
        }
        return read_delivery(st, organization, &existing.id, actor, &key)
            .await
            .map(PreparedIssuance::Delivered);
    }

    let request_id = format!("certificate-request:{}", uuid::Uuid::new_v4());
    let now = Utc::now();
    let san_json = json!({
        "dns_names": request.dns_names,
        "ip_addrs": request.ip_addrs.iter().map(ToString::to_string).collect::<Vec<_>>(),
    })
    .to_string();
    let stored_request = StoredCertificateIssuanceRequest {
        id: request_id.clone(),
        organization_id: organization.into(),
        authority_id: authority_id.into(),
        request_digest: digest,
        idempotency_key,
        created_by: actor.into(),
        state: "created".into(),
        common_name: request.common_name.clone(),
        san_json: san_json.clone(),
        delivery: None,
        expires_at: (now + Duration::minutes(REQUEST_TTL_MINUTES)).to_rfc3339(),
        version: 1,
        created_at: now.to_rfc3339(),
        updated_at: now.to_rfc3339(),
    };
    if !st
        .db
        .insert_certificate_issuance_request(&stored_request)
        .await
        .map_err(|error| internal(error, "create certificate issuance request"))?
    {
        return Err((
            StatusCode::CONFLICT,
            Json(json!({"error":"issuer_unavailable","hint":"the selected certificate authority is not active"})),
        )
            .into_response());
    }
    Ok(PreparedIssuance::New(PendingIssuance {
        request_id,
        san_json,
        key,
    }))
}

async fn fail_issuance(st: &AppState, organization: &str, request_id: &str) {
    let _ = st
        .db
        .transition_certificate_issuance(organization, request_id, 1, "created", "failed")
        .await;
}

async fn complete_persisted_issuance(
    st: &AppState,
    organization: &str,
    authority_id: &str,
    actor: &str,
    pending: PendingIssuance,
    issued: &dev_pki::IssuedCert,
) -> Result<DeliveredCertificate, Response> {
    let PendingIssuance {
        request_id,
        san_json,
        key,
    } = pending;
    let plaintext = serde_json::to_vec(&issued)
        .map_err(|error| internal(error, "encode certificate delivery"))?;
    let delivery = SealedCertificateDelivery {
        material: stored_material(
            seal_scoped(&key, DELIVERY_SCOPE, &request_id, organization, &plaintext)
                .map_err(|error| internal(error, "seal certificate delivery"))?,
        ),
        expires_at: (Utc::now() + Duration::minutes(DELIVERY_TTL_MINUTES)).to_rfc3339(),
    };
    let certificate_digest = hex::encode(Sha256::digest(issued.certificate.as_bytes()));
    let completed_at = Utc::now().to_rfc3339();
    let record = StoredIssuedCertificate {
        id: format!("certificate:{}", uuid::Uuid::new_v4()),
        organization_id: organization.into(),
        authority_id: authority_id.into(),
        request_id: request_id.clone(),
        certificate_digest,
        serial_number: issued.serial.clone(),
        common_name: issued.common_name.clone(),
        san_json,
        not_before: issued.not_before.clone(),
        expires_at: issued.not_after.clone(),
        status: "active".into(),
        version: 1,
        created_at: completed_at.clone(),
        updated_at: completed_at,
    };
    if !st
        .db
        .complete_certificate_issuance(organization, &request_id, 1, "created", &delivery, &record)
        .await
        .map_err(|error| internal(error, "complete certificate issuance"))?
    {
        return Err((
            StatusCode::CONFLICT,
            Json(json!({"error":"issuance_conflict","hint":"certificate request changed before completion"})),
        )
            .into_response());
    }
    read_delivery(st, organization, &request_id, actor, &key).await
}

fn issuer_kind_name(kind: IssuerKind) -> &'static str {
    match kind {
        IssuerKind::OpenSesamePrivateCa => INTERNAL_ISSUER,
        IssuerKind::LetsEncrypt => "letsencrypt",
        IssuerKind::LetsEncryptStaging => "letsencrypt_staging",
        IssuerKind::ZeroSsl => "zerossl",
        IssuerKind::CloudflareOriginCa => "cloudflare_origin_ca",
    }
}

fn trust_name(trust: TrustClass) -> &'static str {
    match trust {
        TrustClass::PrivateLocal => "private_local",
        TrustClass::PublicWeb => "public_web",
        TrustClass::TestOnly => "test_only",
        TrustClass::OriginOnly => "origin_only",
    }
}

fn external_issuer_label(kind: IssuerKind) -> &'static str {
    match kind {
        IssuerKind::LetsEncrypt => "Let's Encrypt",
        IssuerKind::LetsEncryptStaging => "Let's Encrypt Staging",
        IssuerKind::ZeroSsl => "ZeroSSL",
        IssuerKind::CloudflareOriginCa => "Cloudflare Origin CA",
        IssuerKind::OpenSesamePrivateCa => "OpenSesame Private CA",
    }
}

fn eligible_issuer(connection: &ConnectionView) -> bool {
    connection.status == ConnectionStatus::Active
        && matches!(
            connection.provider_id.as_str(),
            "letsencrypt" | "zerossl" | "cloudflare-origin-ca"
        )
}

async fn select_external_issuer(
    st: &AppState,
    organization: &opensesame_domain::OrganizationId,
    requested: Option<&str>,
) -> Result<Option<ConnectionView>, Response> {
    let connections = st
        .connection_broker
        .list_connections(organization)
        .await
        .map_err(|error| internal(error, "list certificate issuer connections"))?;
    if let Some(id) = requested.map(str::trim).filter(|id| !id.is_empty()) {
        let connection = connections
            .into_iter()
            .find(|connection| connection.connection_id == id)
            .ok_or_else(|| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error":"issuer_not_found","hint":"the selected certificate issuer connection does not exist"})),
                )
                    .into_response()
            })?;
        if !eligible_issuer(&connection) {
            return Err((
                StatusCode::CONFLICT,
                Json(json!({"error":"issuer_unavailable","hint":"the selected certificate issuer connection is not active or does not support issuance"})),
            )
                .into_response());
        }
        return Ok(Some(connection));
    }
    if let Some(default) = st
        .db
        .get_default_certificate_authority(&organization.to_string())
        .await
        .map_err(|error| internal(error, "read default certificate authority"))?
        .filter(|authority| authority.issuer_connection_id.is_some())
    {
        let id = default.issuer_connection_id.as_deref().unwrap_or_default();
        let connection = connections
            .iter()
            .find(|connection| connection.connection_id == id)
            .ok_or_else(|| {
                (
                    StatusCode::CONFLICT,
                    Json(json!({"error":"issuer_unavailable","hint":"the configured default certificate issuer connection no longer exists"})),
                )
                    .into_response()
            })?;
        if !eligible_issuer(connection) {
            return Err((
                StatusCode::CONFLICT,
                Json(json!({"error":"issuer_unavailable","hint":"the configured default certificate issuer is not active"})),
            )
                .into_response());
        }
        return Ok(Some(connection.clone()));
    }
    for provider in ["letsencrypt", "zerossl", "cloudflare-origin-ca"] {
        if let Some(connection) = connections
            .iter()
            .find(|connection| eligible_issuer(connection) && connection.provider_id == provider)
        {
            return Ok(Some(connection.clone()));
        }
    }
    Ok(None)
}

async fn persist_external_authority(
    st: &AppState,
    organization: &opensesame_domain::OrganizationId,
    connection: &ConnectionView,
    kind: IssuerKind,
    sealed_plaintext: &[u8],
) -> Result<String, Response> {
    let organization_id = organization.to_string();
    let authority_id = format!("ca:{}:{}", issuer_kind_name(kind), connection.connection_id);
    if st
        .db
        .get_certificate_authority(&organization_id, &authority_id)
        .await
        .map_err(|error| internal(error, "read certificate authority"))?
        .is_some()
    {
        return Ok(authority_id);
    }
    let key = st
        .connection_broker
        .config()
        .key()
        .copied()
        .ok_or_else(|| sealing_unavailable("certificate key protection is unavailable"))?;
    let sealed = seal_scoped(
        &key,
        CA_SCOPE,
        &authority_id,
        &organization_id,
        sealed_plaintext,
    )
    .map_err(|error| internal(error, "seal certificate authority"))?;
    let now = Utc::now().to_rfc3339();
    let authority = StoredCertificateAuthority {
        id: authority_id.clone(),
        organization_id: organization_id.clone(),
        issuer_kind: issuer_kind_name(kind).into(),
        issuer_connection_id: Some(connection.connection_id.clone()),
        display_name: external_issuer_label(kind).into(),
        public_metadata_json: json!({
            "trust_scope": trust_name(kind.trust()),
            "provider_id": connection.provider_id,
        })
        .to_string(),
        sealed_material: stored_material(sealed),
        is_default: false,
        status: "active".into(),
        version: 1,
        created_at: now.clone(),
        updated_at: now,
    };
    st.db
        .insert_certificate_authority(&authority)
        .await
        .map_err(|error| internal(error, "persist certificate authority"))?;
    if !st
        .db
        .set_default_certificate_authority(&organization_id, &authority_id, 1)
        .await
        .map_err(|error| internal(error, "select certificate authority"))?
    {
        return Err(internal(
            "certificate authority changed concurrently",
            "select certificate authority",
        ));
    }
    Ok(authority_id)
}

fn acme_provider(
    connection: &ConnectionView,
    environment: Option<&str>,
) -> Result<AcmeProvider, Response> {
    match connection.provider_id.as_str() {
        "letsencrypt" => match environment.unwrap_or("production") {
            "production" => Ok(AcmeProvider::LetsEncrypt(AcmeEnvironment::Production)),
            "staging" if !crate::config::is_production_env() => {
                Ok(AcmeProvider::LetsEncrypt(AcmeEnvironment::Staging))
            }
            "staging" => Err((
                StatusCode::CONFLICT,
                Json(json!({"error":"issuer_unavailable","hint":"Let's Encrypt staging cannot issue production certificates"})),
            )
                .into_response()),
            _ => Err((
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"invalid_issuer_configuration","hint":"environment must be production or staging"})),
            )
                .into_response()),
        },
        "zerossl" => Ok(AcmeProvider::ZeroSsl),
        _ => Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_issuer_configuration","hint":"connection is not an ACME issuer"})),
        )
            .into_response()),
    }
}

async fn restore_acme_account(
    st: &AppState,
    organization_id: &str,
    authority_id: &str,
    provider: AcmeProvider,
) -> Result<Option<AcmeAccount>, Response> {
    let Some(authority) = st
        .db
        .get_certificate_authority(organization_id, authority_id)
        .await
        .map_err(|error| internal(error, "read ACME account"))?
    else {
        return Ok(None);
    };
    let key = st
        .connection_broker
        .config()
        .key()
        .copied()
        .ok_or_else(|| sealing_unavailable("certificate key protection is unavailable"))?;
    let plaintext = open_scoped(
        &key,
        CA_SCOPE,
        authority_id,
        organization_id,
        &sealed_blob(&authority.sealed_material),
    )
    .map_err(|error| internal(error, "open ACME account"))?;
    let credentials = String::from_utf8(plaintext)
        .map(AcmeAccountCredentials::from_unsealed)
        .map_err(|error| internal(error, "decode ACME account"))?;
    AcmeAccount::restore(provider, credentials)
        .await
        .map(Some)
        .map_err(|error| internal(error, "restore ACME account"))
}

fn external_account_binding(
    provider: AcmeProvider,
    values: &BTreeMap<String, String>,
) -> Result<Option<ExternalAccountBinding>, Response> {
    if provider != AcmeProvider::ZeroSsl {
        return Ok(None);
    }
    let key_id = values.get("eab_kid").cloned().unwrap_or_default();
    let encoded = values.get("eab_hmac_key").map_or("", String::as_str);
    let hmac_key = URL_SAFE_NO_PAD
        .decode(encoded)
        .or_else(|_| URL_SAFE.decode(encoded))
        .map_err(|_| {
            (
                StatusCode::CONFLICT,
                Json(json!({"error":"invalid_issuer_configuration","hint":"ZeroSSL eab_hmac_key must be base64url"})),
            )
                .into_response()
        })?;
    ExternalAccountBinding::new(key_id, hmac_key)
        .map(Some)
        .map_err(|error| {
            (
                StatusCode::CONFLICT,
                Json(json!({"error":"invalid_issuer_configuration","hint":error.to_string()})),
            )
                .into_response()
        })
}

async fn acme_account(
    st: &AppState,
    organization: &opensesame_domain::OrganizationId,
    connection: &ConnectionView,
) -> Result<(String, AcmeAccount), Response> {
    let configuration = st
        .connection_broker
        .certificate_issuer_configuration(organization, &connection.connection_id)
        .await
        .map_err(|error| {
            (
                StatusCode::CONFLICT,
                Json(json!({"error":"issuer_unavailable","hint":error.hint()})),
            )
                .into_response()
        })?;
    if configuration.values.get("accept_terms").map(String::as_str) != Some("true") {
        return Err((
            StatusCode::CONFLICT,
            Json(json!({"error":"invalid_issuer_configuration","hint":"accept_terms must be true before ACME account creation"})),
        )
            .into_response());
    }
    let provider = acme_provider(
        connection,
        configuration.values.get("environment").map(String::as_str),
    )?;
    let kind = provider.issuer();
    let authority_id = format!("ca:{}:{}", issuer_kind_name(kind), connection.connection_id);
    let organization_id = organization.to_string();
    if let Some(account) =
        restore_acme_account(st, &organization_id, &authority_id, provider).await?
    {
        return Ok((authority_id, account));
    }

    let contacts = configuration
        .values
        .get("contact_email")
        .map(|email| email.trim())
        .filter(|email| !email.is_empty())
        .map(|email| vec![format!("mailto:{email}")])
        .unwrap_or_default();
    let external_account = external_account_binding(provider, &configuration.values)?;
    let (account, credentials) = AcmeAccount::create(provider, &contacts, external_account)
        .await
        .map_err(|error| internal(error, "create ACME account"))?;
    let authority_id = persist_external_authority(
        st,
        organization,
        connection,
        kind,
        credentials.as_bytes_for_sealing(),
    )
    .await?;
    Ok((authority_id, account))
}

fn external_delivery(issued: IssuedCertificate) -> Result<dev_pki::IssuedCert, Response> {
    let (bundle, private_key) = issued.into_delivery();
    let (_, pem) = parse_x509_pem(bundle.certificate_chain_pem.as_bytes())
        .map_err(|error| internal(error, "parse issued certificate"))?;
    let (_, certificate) = parse_x509_certificate(&pem.contents)
        .map_err(|error| internal(error, "parse issued certificate"))?;
    let not_before =
        chrono::DateTime::<Utc>::from_timestamp(certificate.validity().not_before.timestamp(), 0)
            .ok_or_else(|| internal("invalid not-before timestamp", "parse issued certificate"))?
            .to_rfc3339();
    let not_after =
        chrono::DateTime::<Utc>::from_timestamp(certificate.validity().not_after.timestamp(), 0)
            .ok_or_else(|| internal("invalid not-after timestamp", "parse issued certificate"))?
            .to_rfc3339();
    Ok(dev_pki::IssuedCert {
        certificate: bundle.certificate_chain_pem,
        private_key: private_key.to_string(),
        ca_certificate: bundle.issuer_certificate_pem.unwrap_or_default(),
        serial: certificate.raw_serial_as_string(),
        common_name: bundle.common_name,
        dns_names: bundle.dns_names,
        not_before,
        not_after,
    })
}

async fn issue_acme(
    st: &AppState,
    headers: &axum::http::HeaderMap,
    actor: &str,
    organization: &opensesame_domain::OrganizationId,
    connection: &ConnectionView,
    request: &CertificateRequest,
    stored_request: &dev_pki::IssueRequest,
) -> Result<(IssuerKind, DeliveredCertificate), Response> {
    let dns = st
        .connection_broker
        .list_connections(organization)
        .await
        .map_err(|error| internal(error, "list DNS challenge connections"))?
        .into_iter()
        .find(|candidate| {
            candidate.provider_id == "cloudflare" && candidate.status == ConnectionStatus::Active
        })
        .ok_or_else(|| {
            (
                StatusCode::CONFLICT,
                Json(json!({"error":"dns01_unavailable","hint":"connect an active Cloudflare account for ACME DNS-01 challenges"})),
            )
                .into_response()
        })?;
    let (authority_id, account) = acme_account(st, organization, connection).await?;
    let kind = account.provider_kind();
    let prepared = prepare_persisted_issuance(
        st,
        headers,
        &organization.to_string(),
        &authority_id,
        actor,
        stored_request,
    )
    .await?;
    let pending = match prepared {
        PreparedIssuance::Delivered(issued) => return Ok((kind, issued)),
        PreparedIssuance::New(pending) => pending,
    };
    let provisioner = CloudflareDns01::new(
        st.connection_broker.clone(),
        *organization,
        dns.connection_id,
    );
    let issued = account
        .issue_dns01(request, ChallengeKind::Dns01, &provisioner)
        .await
        .map_err(|error| internal(error, "issue ACME certificate"))
        .and_then(external_delivery);
    let issued = match issued {
        Ok(issued) => issued,
        Err(response) => {
            fail_issuance(st, &organization.to_string(), &pending.request_id).await;
            return Err(response);
        }
    };
    let issued = complete_persisted_issuance(
        st,
        &organization.to_string(),
        &authority_id,
        actor,
        pending,
        &issued,
    )
    .await?;
    Ok((kind, issued))
}

fn cloudflare_origin_validity(ttl: StdDuration) -> CloudflareOriginValidity {
    if ttl <= StdDuration::from_secs(7 * 24 * 60 * 60) {
        CloudflareOriginValidity::Days7
    } else if ttl <= StdDuration::from_secs(30 * 24 * 60 * 60) {
        CloudflareOriginValidity::Days30
    } else {
        CloudflareOriginValidity::Days90
    }
}

async fn issue_cloudflare_origin(
    st: &AppState,
    headers: &axum::http::HeaderMap,
    actor: &str,
    organization: &opensesame_domain::OrganizationId,
    connection: &ConnectionView,
    request: &CertificateRequest,
    stored_request: &dev_pki::IssueRequest,
) -> Result<(IssuerKind, DeliveredCertificate), Response> {
    st.connection_broker
        .certificate_issuer_configuration(organization, &connection.connection_id)
        .await
        .map_err(|error| {
            (
                StatusCode::CONFLICT,
                Json(json!({"error":"issuer_unavailable","hint":error.hint()})),
            )
                .into_response()
        })?;
    let kind = IssuerKind::CloudflareOriginCa;
    let authority_id =
        persist_external_authority(st, organization, connection, kind, b"{}").await?;
    let prepared = prepare_persisted_issuance(
        st,
        headers,
        &organization.to_string(),
        &authority_id,
        actor,
        stored_request,
    )
    .await?;
    let pending = match prepared {
        PreparedIssuance::Delivered(issued) => return Ok((kind, issued)),
        PreparedIssuance::New(pending) => pending,
    };
    let leaf = match GeneratedLeafRequest::generate(request) {
        Ok(leaf) => leaf,
        Err(error) => {
            fail_issuance(st, &organization.to_string(), &pending.request_id).await;
            return Err(internal(error, "generate certificate request"));
        }
    };
    let provider_request = match CloudflareOriginRequest::from_generated(
        request,
        &leaf,
        cloudflare_origin_validity(request.ttl()),
    ) {
        Ok(request) => request,
        Err(error) => {
            fail_issuance(st, &organization.to_string(), &pending.request_id).await;
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"invalid_request","hint":error.to_string()})),
            )
                .into_response());
        }
    };
    let response = st
        .connection_broker
        .authorized_json(
            organization,
            &connection.connection_id,
            "POST",
            "https://api.cloudflare.com/client/v4/certificates",
            serde_json::to_value(provider_request).ok(),
        )
        .await
        .map_err(|error| internal(error, "issue Cloudflare Origin certificate"));
    let normalized = response
        .and_then(|response| {
            serde_json::from_value::<CloudflareOriginApiResponse>(response)
                .map_err(|error| internal(error, "decode Cloudflare Origin certificate"))
        })
        .and_then(|response| {
            response
                .normalize(request, leaf)
                .map_err(|error| internal(error, "validate Cloudflare Origin certificate"))
        })
        .and_then(external_delivery);
    let issued = match normalized {
        Ok(issued) => issued,
        Err(response) => {
            fail_issuance(st, &organization.to_string(), &pending.request_id).await;
            return Err(response);
        }
    };
    let issued = complete_persisted_issuance(
        st,
        &organization.to_string(),
        &authority_id,
        actor,
        pending,
        &issued,
    )
    .await?;
    Ok((kind, issued))
}

async fn issue_external(
    st: &AppState,
    headers: &axum::http::HeaderMap,
    actor: &str,
    organization: &opensesame_domain::OrganizationId,
    connection: &ConnectionView,
    request: &CertificateRequest,
    stored_request: &dev_pki::IssueRequest,
) -> Result<(IssuerKind, DeliveredCertificate), Response> {
    request.require_public_dns().map_err(|error| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_request","hint":error.to_string()})),
        )
            .into_response()
    })?;
    match connection.provider_id.as_str() {
        "letsencrypt" | "zerossl" => {
            issue_acme(
                st,
                headers,
                actor,
                organization,
                connection,
                request,
                stored_request,
            )
            .await
        }
        "cloudflare-origin-ca" => {
            issue_cloudflare_origin(
                st,
                headers,
                actor,
                organization,
                connection,
                request,
                stored_request,
            )
            .await
        }
        _ => Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"issuer_unavailable","hint":"unsupported certificate issuer"})),
        )
            .into_response()),
    }
}

fn parse_issue_body(
    body: IssueBody,
) -> Result<(Option<String>, CertificateRequest, dev_pki::IssueRequest), Response> {
    let mut ips = Vec::new();
    for raw in &body.ip_addrs {
        match raw.parse::<IpAddr>() {
            Ok(ip) => ips.push(ip),
            Err(_) => {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error":"invalid_request","hint": format!("not an IP address: {raw}")})),
                )
                    .into_response());
            }
        }
    }
    let ttl = body.ttl_hours.map_or(DEFAULT_TTL, |hours| {
        StdDuration::from_secs(hours.saturating_mul(3600))
    });
    let requested_issuer = body.issuer_connection_id;
    let validated = CertificateRequest::try_from(CertificateRequestInput {
        common_name: body.common_name,
        dns_names: body.dns_names,
        ip_addrs: ips,
        ttl: Some(ttl),
    })
    .map_err(|error| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_request","hint":error.to_string()})),
        )
            .into_response()
    })?;
    let request = dev_pki::IssueRequest {
        common_name: validated.common_name().into(),
        dns_names: validated.dns_names().to_vec(),
        ip_addrs: validated.ip_addrs().to_vec(),
        ttl: validated.ttl(),
    };
    Ok((requested_issuer, validated, request))
}

async fn issue_private(
    st: &AppState,
    headers: &axum::http::HeaderMap,
    actor: &str,
    organization: &opensesame_domain::OrganizationId,
    request: &dev_pki::IssueRequest,
) -> Response {
    let resolved_ca = match load_or_create_ca(st, organization).await {
        Ok(ca) => ca,
        Err(response) => return response,
    };
    match resolved_ca {
        ResolvedCa::Persisted { authority_id, ca } => {
            let prepared = match prepare_persisted_issuance(
                st,
                headers,
                &organization.to_string(),
                &authority_id,
                actor,
                request,
            )
            .await
            {
                Ok(prepared) => prepared,
                Err(response) => return response,
            };
            let delivered = match prepared {
                PreparedIssuance::Delivered(delivered) => delivered,
                PreparedIssuance::New(pending) => {
                    let issued = match dev_pki::issue_leaf(&ca, request) {
                        Ok(issued) => issued,
                        Err(hint) => {
                            fail_issuance(st, &organization.to_string(), &pending.request_id).await;
                            return (
                                StatusCode::BAD_REQUEST,
                                Json(json!({"error":"invalid_request","hint":hint})),
                            )
                                .into_response();
                        }
                    };
                    match complete_persisted_issuance(
                        st,
                        &organization.to_string(),
                        &authority_id,
                        actor,
                        pending,
                        &issued,
                    )
                    .await
                    {
                        Ok(delivered) => delivered,
                        Err(response) => return response,
                    }
                }
            };
            issue_response(
                &delivered.issued,
                delivered.delivery_id.as_deref(),
                true,
                "OpenSesame Private CA",
                INTERNAL_ISSUER,
                "private_local",
            )
        }
        ResolvedCa::Ephemeral(ca) => {
            let issued = match dev_pki::issue_leaf(&ca, request) {
                Ok(issued) => issued,
                Err(hint) => {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(json!({"error":"invalid_request","hint":hint})),
                    )
                        .into_response();
                }
            };
            let mut rows = match load_issued(st, organization).await {
                Ok(rows) => rows,
                Err(response) => return response,
            };
            rows.insert(0, dev_pki::to_record(&issued));
            rows.truncate(MAX_ISSUED);
            if let Err(response) = save_issued(st, organization, &rows).await {
                return response;
            }
            issue_response(
                &issued,
                None,
                false,
                "OpenSesame Private CA",
                INTERNAL_ISSUER,
                "private_local",
            )
        }
    }
}

pub async fn issue(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<IssueBody>,
) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization = match resolve_caller_organization(&st, &who, &headers) {
        Ok(organization) => organization,
        Err(response) => return response,
    };
    let actor = delivery_actor(&who);
    let (requested_issuer, validated, request) = match parse_issue_body(body) {
        Ok(parsed) => parsed,
        Err(response) => return response,
    };
    let external =
        match select_external_issuer(&st, &organization, requested_issuer.as_deref()).await {
            Ok(external) => external,
            Err(response) => return response,
        };
    if let Some(connection) = external {
        return match issue_external(
            &st,
            &headers,
            &actor,
            &organization,
            &connection,
            &validated,
            &request,
        )
        .await
        {
            Ok((kind, delivered)) => issue_response(
                &delivered.issued,
                delivered.delivery_id.as_deref(),
                true,
                external_issuer_label(kind),
                issuer_kind_name(kind),
                trust_name(kind.trust()),
            ),
            Err(response) => response,
        };
    }
    issue_private(&st, &headers, &actor, &organization, &request).await
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::app_state::{self, test_env, test_session_headers, AppState};
    use crate::config::{Args, DEV_OPERATOR_TOKEN};
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use serde_json::{json, Value};
    use tower::ServiceExt;

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        test_env::lock()
    }

    async fn memory_state() -> AppState {
        app_state::build(Args {
            listen: "127.0.0.1:0".parse().unwrap(),
            resource: "https://opensesame.local".into(),
            issuer: "https://issuer.local".into(),
            database_url: "sqlite::memory:".into(),
            task_database_url: String::new(),
        })
        .await
        .unwrap()
    }

    async fn call(
        state: &AppState,
        method: &str,
        path: &str,
        headers: Option<axum::http::HeaderMap>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder().method(method).uri(path);
        match headers {
            Some(map) => {
                for (name, value) in &map {
                    request = request.header(name, value);
                }
            }
            None => {
                request = request.header(
                    "authorization",
                    format!("Bearer operator:{DEV_OPERATOR_TOKEN}"),
                );
            }
        }
        let request = match body {
            Some(value) => request
                .header("content-type", "application/json")
                .body(Body::from(value.to_string()))
                .unwrap(),
            None => request.body(Body::empty()).unwrap(),
        };
        let response = crate::routes::router(state.clone())
            .oneshot(request)
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }

    #[tokio::test]
    async fn owner_session_issues_a_localhost_dev_cert() {
        let _guard = env_lock();
        let state = memory_state().await;
        let headers = test_session_headers(
            &state,
            "prn_owner",
            state.connection_organization,
            opensesame_domain::OrganizationRole::Owner,
        );
        let (status, body) = call(
            &state,
            "POST",
            "/api/v1/certs/issue",
            Some(headers.clone()),
            Some(json!({
                "common_name": "localhost",
                "dns_names": ["localhost"],
                "ip_addrs": ["127.0.0.1"],
                "ttl_hours": 24
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body["certificate"]
            .as_str()
            .unwrap()
            .contains("BEGIN CERTIFICATE"));
        assert!(body["private_key"].as_str().unwrap().contains("BEGIN"));
        assert_eq!(body["common_name"], "localhost");
        assert_eq!(body["purpose"], "local_tls");
        assert_eq!(body["trust_scope"], "private_local");
        assert_eq!(body["persistent"], false);

        let (status, ca) = call(
            &state,
            "GET",
            "/api/v1/certs/ca",
            Some(headers.clone()),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{ca}");
        assert_eq!(ca["ca"]["certificate"], body["ca_certificate"]);

        let (status, list) = call(&state, "GET", "/api/v1/certs", Some(headers), None).await;
        assert_eq!(status, StatusCode::OK, "{list}");
        assert_eq!(list["certificates"][0]["common_name"], "localhost");
        assert!(list["certificates"][0]["private_key"].is_null());
    }

    #[tokio::test]
    async fn adversarial_ephemeral_history_isolated_between_organizations() {
        let _guard = env_lock();
        let state = memory_state().await;
        let issuing_headers = test_session_headers(
            &state,
            "prn_issuing_owner",
            state.connection_organization,
            opensesame_domain::OrganizationRole::Owner,
        );
        let (status, body) = call(
            &state,
            "POST",
            "/api/v1/certs/issue",
            Some(issuing_headers),
            Some(json!({"common_name": "tenant-a.local"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");

        let foreign_headers = test_session_headers(
            &state,
            "prn_foreign_owner",
            opensesame_domain::OrganizationId::new(),
            opensesame_domain::OrganizationRole::Owner,
        );
        let (status, list) =
            call(&state, "GET", "/api/v1/certs", Some(foreign_headers), None).await;
        assert_eq!(status, StatusCode::OK, "{list}");
        assert_eq!(list["certificates"], json!([]));
    }

    #[tokio::test]
    async fn member_cannot_issue() {
        let _guard = env_lock();
        let state = memory_state().await;
        let headers = test_session_headers(
            &state,
            "prn_member",
            state.connection_organization,
            opensesame_domain::OrganizationRole::Member,
        );
        let (status, _) = call(
            &state,
            "POST",
            "/api/v1/certs/issue",
            Some(headers),
            Some(json!({"common_name": "localhost"})),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn contract_persisted_delivery_retries_until_ack_without_plaintext_ca() {
        let _guard = env_lock();
        let _ = tracing_subscriber::fmt().with_test_writer().try_init();
        std::env::set_var(
            "OPENSESAME_CONNECTION_KEY",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        );
        let state = memory_state().await;
        std::env::remove_var("OPENSESAME_CONNECTION_KEY");
        let mut headers = test_session_headers(
            &state,
            "prn_owner",
            state.connection_organization,
            opensesame_domain::OrganizationRole::Owner,
        );
        headers.insert("idempotency-key", "cert-test-one".parse().unwrap());
        let request = json!({
            "common_name": "localhost",
            "dns_names": ["localhost"],
            "ip_addrs": ["127.0.0.1"],
            "ttl_hours": 24
        });
        let (status, first) = call(
            &state,
            "POST",
            "/api/v1/certs/issue",
            Some(headers.clone()),
            Some(request.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{first}");
        assert_eq!(first["persistent"], true);
        let delivery_id = first["delivery_id"].as_str().unwrap();

        let (status, retry) = call(
            &state,
            "POST",
            "/api/v1/certs/issue",
            Some(headers.clone()),
            Some(request.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{retry}");
        assert_eq!(retry["private_key"], first["private_key"]);

        let other_headers = test_session_headers(
            &state,
            "prn_other_owner",
            state.connection_organization,
            opensesame_domain::OrganizationRole::Owner,
        );
        let (status, _) = call(
            &state,
            "POST",
            &format!("/api/v1/certs/deliveries/{delivery_id}/ack"),
            Some(other_headers),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let (status, _) = call(
            &state,
            "POST",
            &format!("/api/v1/certs/deliveries/{delivery_id}/ack"),
            Some(headers.clone()),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (status, body) = call(
            &state,
            "POST",
            "/api/v1/certs/issue",
            Some(headers),
            Some(request),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert!(state.db.get_host_kv(super::KV_CA).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn adversarial_external_issuer_failure_never_downgrades_to_private_ca() {
        let _guard = env_lock();
        std::env::set_var(
            "OPENSESAME_CONNECTION_KEY",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        );
        let state = memory_state().await;
        std::env::remove_var("OPENSESAME_CONNECTION_KEY");
        let connection = state
            .connection_broker
            .create_connection(
                &state.connection_organization,
                opensesame_connection_broker::CreateConnection {
                    provider_id: "letsencrypt".into(),
                    integration_id: None,
                    owner_subject: None,
                    display_name: None,
                    logical_name: None,
                    project_id: None,
                    scopes: None,
                    shareability: None,
                },
            )
            .await
            .unwrap();
        state
            .connection_broker
            .set_connection_configuration(
                &state.connection_organization,
                &connection.connection_id,
                BTreeMap::from([
                    ("accept_terms".into(), "true".into()),
                    ("environment".into(), "staging".into()),
                ]),
                Vec::new(),
            )
            .await
            .unwrap();
        let headers = test_session_headers(
            &state,
            "prn_owner",
            state.connection_organization,
            opensesame_domain::OrganizationRole::Owner,
        );
        let (status, body) = call(
            &state,
            "POST",
            "/api/v1/certs/issue",
            Some(headers),
            Some(json!({"common_name":"www.example.com"})),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["error"], "dns01_unavailable");
        assert!(state
            .db
            .list_certificate_authorities(&state.connection_organization.to_string())
            .await
            .unwrap()
            .is_empty());
    }
}
