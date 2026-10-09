//! Certificate profile routes (ADR 0066 §2 — a profile is `(issuer, policy,
//! defaults)`, the issuable unit).
//!
//! `GET|POST /api/v1/certmgr/profiles` and
//! `GET|PATCH|DELETE /api/v1/certmgr/profiles/{id}`.
//!
//! The load-bearing rule here is the write-time check: a profile's
//! [`ProfileDefaults`] are evaluated against its own policy with
//! [`policy::validate_defaults_against_policy`] before the row is stored, and a
//! failure returns the engine's [`PolicyViolation`] list. A profile whose
//! defaults its own policy forbids is a latent issuance failure — every
//! enrollment through it would be refused at issue time, far from the operator
//! who typed the defaults — so it must not be storable at all.
//!
//! Secrecy invariant: a profile row references a CA by id and carries public
//! default field values. No sealed authority material is read or projected
//! here; `certificate_authority_id` is validated by an org-scoped existence
//! check that never touches the sealed columns.

use axum::{
    extract::{rejection::JsonRejection, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use opensesame_pki_core::{policy, types::ProfileDefaults, PolicyRules, PolicyViolation};
use opensesame_storage::{StoredCertificatePolicy, StoredCertificateProfile};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::app_state::AppState;
use crate::routes::certmgr_policy::{
    append_audit, bad_request, caller_organization, check_name, conflict, internal, json_body,
    not_found, require_configurator, storage_write_error,
};

/// How a profile obtains a signature.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum IssuerType {
    /// Signed by a certificate authority in the same organization.
    Ca,
    /// Self-signed; there is no issuing authority to name.
    SelfSigned,
}

impl IssuerType {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Ca => "ca",
            Self::SelfSigned => "self_signed",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "ca" => Some(Self::Ca),
            "self_signed" => Some(Self::SelfSigned),
            _ => None,
        }
    }
}

/// `POST /api/v1/certmgr/profiles`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateProfileBody {
    pub name: String,
    pub issuer_type: IssuerType,
    #[serde(default)]
    pub certificate_authority_id: Option<String>,
    pub policy_id: String,
    #[serde(default)]
    pub defaults: Option<ProfileDefaults>,
}

/// `PATCH /api/v1/certmgr/profiles/{id}`.
///
/// Absent fields are left alone. `version`, when present, is the version the
/// caller read; a mismatch is a 409 rather than a lost update. Whatever
/// changes, the effective defaults are re-validated against the effective
/// policy before anything is written.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateProfileBody {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub issuer_type: Option<IssuerType>,
    #[serde(default)]
    pub certificate_authority_id: Option<String>,
    #[serde(default)]
    pub policy_id: Option<String>,
    #[serde(default)]
    pub defaults: Option<ProfileDefaults>,
    #[serde(default)]
    pub version: Option<i64>,
}

/// Whitelist projection of a stored profile. `defaults` is re-serialized from
/// the typed document so a read is exactly what the evaluator validated.
fn profile_view(row: &StoredCertificateProfile) -> Result<Value, Response> {
    let defaults: ProfileDefaults = serde_json::from_str(&row.defaults_json)
        .map_err(|error| internal(error, "decode stored profile defaults"))?;
    Ok(json!({
        "id": row.id,
        "name": row.name,
        "issuer_type": row.issuer_type,
        "certificate_authority_id": row.certificate_authority_id,
        "policy_id": row.policy_id,
        "defaults": defaults,
        "version": row.version,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }))
}

/// The 400 body carrying the engine's violation list. This wording reaches
/// operators, so it is snapshot-pinned in the tests below.
fn policy_violation_response(violations: &[PolicyViolation]) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({
            "error": "policy_violation",
            "hint": "the profile defaults are forbidden by the policy this profile references",
            "violations": violations,
        })),
    )
        .into_response()
}

/// `certificate_authority_id` is required for a `ca` profile and refused for a
/// `self_signed` one — the DDL enforces the first half, and a stray id on a
/// self-signed profile would silently claim an authority it never uses.
fn resolve_issuer(
    issuer_type: IssuerType,
    certificate_authority_id: Option<String>,
) -> Result<Option<String>, Response> {
    match (issuer_type, certificate_authority_id) {
        (IssuerType::Ca, Some(id)) if !id.is_empty() => Ok(Some(id)),
        (IssuerType::Ca, _) => Err(bad_request(
            "invalid_request",
            "certificate_authority_id is required when issuer_type is \"ca\"",
        )),
        (IssuerType::SelfSigned, None) => Ok(None),
        (IssuerType::SelfSigned, Some(_)) => Err(bad_request(
            "invalid_request",
            "certificate_authority_id must be omitted when issuer_type is \"self_signed\"",
        )),
    }
}

/// Load the referenced policy, scoped to the caller's organization.
///
/// A policy in another organization is indistinguishable from one that does not
/// exist: both produce `unknown_policy`, and neither query ever joins across
/// tenants.
async fn load_referenced_policy(
    st: &AppState,
    organization: &str,
    policy_id: &str,
) -> Result<StoredCertificatePolicy, Response> {
    match st.db.get_certificate_policy(organization, policy_id).await {
        Ok(Some(row)) => Ok(row),
        Ok(None) => Err(bad_request(
            "unknown_policy",
            "policy_id does not name a policy in this organization",
        )),
        Err(error) => Err(internal(error, "get referenced certificate policy")),
    }
}

/// Confirm the referenced authority exists in the caller's organization. Only
/// the id is used; the sealed authority material is never opened here.
async fn check_referenced_authority(
    st: &AppState,
    organization: &str,
    authority_id: &str,
) -> Result<(), Response> {
    match st
        .db
        .get_certificate_authority(organization, authority_id)
        .await
    {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(bad_request(
            "unknown_certificate_authority",
            "certificate_authority_id does not name an authority in this organization",
        )),
        Err(error) => Err(internal(error, "get referenced certificate authority")),
    }
}

/// The write-time gate: defaults must satisfy the policy they will be merged
/// into at issue time.
fn check_defaults(
    defaults: &ProfileDefaults,
    stored_policy: &StoredCertificatePolicy,
) -> Result<(), Response> {
    let rules: PolicyRules = serde_json::from_str(&stored_policy.rules_json)
        .map_err(|error| internal(error, "decode referenced policy rules"))?;
    policy::validate_defaults_against_policy(defaults, &rules)
        .map_err(|violations| policy_violation_response(&violations))
}

/// Count the enrollment configurations still pointing at a profile.
async fn enrollment_referrers(
    st: &AppState,
    organization: &str,
    profile_id: &str,
) -> Result<usize, Response> {
    let applications = st
        .db
        .list_pki_applications(organization)
        .await
        .map_err(|error| internal(error, "list pki applications"))?;
    let mut referrers = 0;
    for application in &applications {
        let configs = st
            .db
            .list_enrollment_configs(organization, &application.id)
            .await
            .map_err(|error| internal(error, "list enrollment configs"))?;
        referrers += configs
            .iter()
            .filter(|config| config.profile_id == profile_id)
            .count();
    }
    Ok(referrers)
}

// —— handlers ——————————————————————————————————————————————————————

/// `GET /api/v1/certmgr/profiles` — every profile in the caller's organization.
pub async fn list(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization = match caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let rows = match st.db.list_certificate_profiles(&organization).await {
        Ok(rows) => rows,
        Err(error) => return internal(error, "list certificate profiles"),
    };
    let mut profiles = Vec::with_capacity(rows.len());
    for row in &rows {
        match profile_view(row) {
            Ok(view) => profiles.push(view),
            Err(response) => return response,
        }
    }
    (StatusCode::OK, Json(json!({"profiles": profiles}))).into_response()
}

/// `POST /api/v1/certmgr/profiles` — create one profile, defaults validated
/// against its policy before anything is stored.
pub async fn create(
    State(st): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<CreateProfileBody>, JsonRejection>,
) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization = match caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let body = match json_body(body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    if let Err(response) = check_name(&body.name) {
        return response;
    }
    let authority_id = match resolve_issuer(body.issuer_type, body.certificate_authority_id) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let stored_policy = match load_referenced_policy(&st, &organization, &body.policy_id).await {
        Ok(row) => row,
        Err(response) => return response,
    };
    if let Some(authority_id) = authority_id.as_deref() {
        if let Err(response) = check_referenced_authority(&st, &organization, authority_id).await {
            return response;
        }
    }
    let defaults = body.defaults.unwrap_or_default();
    if let Err(response) = check_defaults(&defaults, &stored_policy) {
        return response;
    }
    let defaults_json = match serde_json::to_string(&defaults) {
        Ok(text) => text,
        Err(error) => return internal(error, "serialize profile defaults"),
    };

    let now = chrono::Utc::now().to_rfc3339();
    let row = StoredCertificateProfile {
        id: format!("certificate-profile:{}", uuid::Uuid::now_v7()),
        organization_id: organization.clone(),
        name: body.name,
        issuer_type: body.issuer_type.as_str().to_string(),
        certificate_authority_id: authority_id,
        policy_id: body.policy_id,
        defaults_json,
        external_template: None,
        version: 1,
        created_at: now.clone(),
        updated_at: now,
    };
    if let Err(error) = st.db.insert_certificate_profile(&row).await {
        return storage_write_error(
            &error,
            "a profile with that name already exists in this organization",
            "insert certificate profile",
        );
    }
    let view = match profile_view(&row) {
        Ok(view) => view,
        Err(response) => return response,
    };
    if let Err(error) = append_audit(
        &st,
        "certmgr.profile.created",
        &json!({
            "organization_id": organization,
            "profile_id": row.id,
            "name": row.name,
            "policy_id": row.policy_id,
            "issuer_type": row.issuer_type,
        }),
    )
    .await
    {
        // Compensate: an unaudited profile must not survive the request.
        if let Err(rollback) = st
            .db
            .delete_certificate_profile(&organization, &row.id)
            .await
        {
            tracing::error!(%rollback, "certificate profile rollback failed");
        }
        return internal(error, "append profile audit event");
    }
    (StatusCode::CREATED, Json(view)).into_response()
}

/// `GET /api/v1/certmgr/profiles/{id}` — one profile, org-scoped.
pub async fn get(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(profile_id): Path<String>,
) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization = match caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(response) => return response,
    };
    match st
        .db
        .get_certificate_profile(&organization, &profile_id)
        .await
    {
        Ok(Some(row)) => match profile_view(&row) {
            Ok(view) => (StatusCode::OK, Json(view)).into_response(),
            Err(response) => response,
        },
        Ok(None) => not_found("no such certificate profile"),
        Err(error) => internal(error, "get certificate profile"),
    }
}

/// `PATCH /api/v1/certmgr/profiles/{id}` — partial update under a
/// compare-and-swap on `version`, re-validated end to end.
#[expect(
    clippy::too_many_lines,
    clippy::cognitive_complexity,
    reason = "one linear validate-then-write path; splitting it would hide the ordering that keeps authz and referential checks ahead of the write"
)]
pub async fn update(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(profile_id): Path<String>,
    body: Result<Json<UpdateProfileBody>, JsonRejection>,
) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization = match caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let body = match json_body(body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let current = match st
        .db
        .get_certificate_profile(&organization, &profile_id)
        .await
    {
        Ok(Some(row)) => row,
        Ok(None) => return not_found("no such certificate profile"),
        Err(error) => return internal(error, "get certificate profile"),
    };

    let mut next = current.clone();
    if let Some(name) = body.name {
        if let Err(response) = check_name(&name) {
            return response;
        }
        next.name = name;
    }

    // The issuer pair moves together: a patch that names either half is
    // resolved against both, so a `self_signed` switch cannot leave a stale
    // authority id behind.
    if body.issuer_type.is_some() || body.certificate_authority_id.is_some() {
        let Some(issuer_type) = body
            .issuer_type
            .or_else(|| IssuerType::parse(&current.issuer_type))
        else {
            return internal("unrecognized stored issuer_type", "resolve issuer type");
        };
        let requested = body.certificate_authority_id.or_else(|| match issuer_type {
            // Keep the existing authority when only the type was restated.
            IssuerType::Ca => current.certificate_authority_id.clone(),
            IssuerType::SelfSigned => None,
        });
        match resolve_issuer(issuer_type, requested) {
            Ok(value) => {
                next.issuer_type = issuer_type.as_str().to_string();
                next.certificate_authority_id = value;
            }
            Err(response) => return response,
        }
    }
    if let Some(policy_id) = body.policy_id {
        next.policy_id = policy_id;
    }
    if let Some(defaults) = body.defaults {
        match serde_json::to_string(&defaults) {
            Ok(text) => next.defaults_json = text,
            Err(error) => return internal(error, "serialize profile defaults"),
        }
    }

    let stored_policy = match load_referenced_policy(&st, &organization, &next.policy_id).await {
        Ok(row) => row,
        Err(response) => return response,
    };
    if let Some(authority_id) = next.certificate_authority_id.as_deref() {
        if let Err(response) = check_referenced_authority(&st, &organization, authority_id).await {
            return response;
        }
    }
    let defaults: ProfileDefaults = match serde_json::from_str(&next.defaults_json) {
        Ok(value) => value,
        Err(error) => return internal(error, "decode stored profile defaults"),
    };
    if let Err(response) = check_defaults(&defaults, &stored_policy) {
        return response;
    }

    if let Some(expected) = body.version {
        next.version = expected;
    }
    match st.db.update_certificate_profile(&next).await {
        Ok(true) => {}
        Ok(false) => {
            return conflict(
                "version_conflict",
                "the profile changed since it was read; re-read it and retry",
            )
        }
        Err(error) => {
            return storage_write_error(
                &error,
                "a profile with that name already exists in this organization",
                "update certificate profile",
            )
        }
    }
    if let Err(error) = append_audit(
        &st,
        "certmgr.profile.updated",
        &json!({
            "organization_id": organization,
            "profile_id": next.id,
            "name": next.name,
            "policy_id": next.policy_id,
        }),
    )
    .await
    {
        tracing::error!(%error, "profile audit event append failed after update");
    }
    match st
        .db
        .get_certificate_profile(&organization, &profile_id)
        .await
    {
        Ok(Some(row)) => match profile_view(&row) {
            Ok(view) => (StatusCode::OK, Json(view)).into_response(),
            Err(response) => response,
        },
        Ok(None) => not_found("no such certificate profile"),
        Err(error) => internal(error, "re-read certificate profile"),
    }
}

/// `DELETE /api/v1/certmgr/profiles/{id}` — refused while an enrollment config
/// still points at it. Nothing cascades: deleting the profile would strand
/// every ACME/EST/SCEP/API enrollment wired to it.
pub async fn delete(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(profile_id): Path<String>,
) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let organization = match caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(response) => return response,
    };
    match st
        .db
        .get_certificate_profile(&organization, &profile_id)
        .await
    {
        Ok(Some(_)) => {}
        Ok(None) => return not_found("no such certificate profile"),
        Err(error) => return internal(error, "get certificate profile"),
    }
    let referrers = match enrollment_referrers(&st, &organization, &profile_id).await {
        Ok(count) => count,
        Err(response) => return response,
    };
    if referrers > 0 {
        return conflict(
            "profile_in_use",
            format!(
                "{referrers} enrollment config(s) still reference this profile; remove them first"
            ),
        );
    }
    match st
        .db
        .delete_certificate_profile(&organization, &profile_id)
        .await
    {
        Ok(true) => {}
        Ok(false) => return not_found("no such certificate profile"),
        Err(error) => return internal(error, "delete certificate profile"),
    }
    if let Err(error) = append_audit(
        &st,
        "certmgr.profile.deleted",
        &json!({"organization_id": organization, "profile_id": profile_id}),
    )
    .await
    {
        tracing::error!(%error, "profile audit event append failed after delete");
    }
    StatusCode::NO_CONTENT.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_state::AppState;
    use crate::routes::certmgr_policy::tests::{call, foreign_owner, member, owner, state};
    use opensesame_pki_core::types::{
        BasicConstraints, ExtendedKeyUsage, KeyAlgorithm, KeyUsage, SignatureAlgorithm, SubjectDn,
    };
    use opensesame_storage::{SealedCertificateMaterial, StoredCertificateAuthority};

    async fn seed_policy(state: &AppState, headers: &HeaderMap, body: Value) -> String {
        let (status, created) = call(
            state,
            "POST",
            "/api/v1/certmgr/policies",
            headers,
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{created}");
        created["id"].as_str().unwrap().to_string()
    }

    /// Insert a certificate authority row directly. The sealed columns carry
    /// opaque bytes; no route in this module ever reads them.
    async fn seed_authority(state: &AppState, organization: &str, tag: &str) -> String {
        let id = format!("certificate-authority:{tag}");
        let now = chrono::Utc::now().to_rfc3339();
        state
            .db
            .insert_certificate_authority(&StoredCertificateAuthority {
                id: id.clone(),
                organization_id: organization.to_string(),
                issuer_kind: "opensesame_private_ca".into(),
                issuer_connection_id: None,
                display_name: format!("CA {tag}"),
                public_metadata_json: "{}".into(),
                sealed_material: SealedCertificateMaterial {
                    key_id: "opensesame-connection-key:v1".into(),
                    ciphertext: vec![1, 2, 3],
                    nonce: vec![4, 5, 6],
                    aad_digest: format!("sha256:{tag}"),
                },
                is_default: false,
                status: "active".into(),
                version: 1,
                created_at: now.clone(),
                updated_at: now,
            })
            .await
            .unwrap();
        id
    }

    // —— unit / behavior ——————————————————————————————————————————

    #[tokio::test]
    async fn given_defaults_that_satisfy_the_policy_when_created_then_the_profile_is_stored() {
        let state = state().await;
        let headers = owner(&state);
        let policy_id = seed_policy(
            &state,
            &headers,
            json!({"name": "tls-edge", "preset": "tls_server"}),
        )
        .await;
        let authority_id =
            seed_authority(&state, &state.connection_organization.to_string(), "one").await;
        let defaults = ProfileDefaults {
            ttl_seconds: Some(86_400),
            subject: Some(SubjectDn::common_name("edge.example.com")),
            key_algorithm: Some(KeyAlgorithm::EcdsaP256),
            signature_algorithm: Some(SignatureAlgorithm::Sha256Ecdsa),
            key_usages: vec![KeyUsage::DigitalSignature, KeyUsage::KeyEncipherment],
            ext_key_usages: vec![ExtendedKeyUsage::ServerAuth],
            basic_constraints: Some(BasicConstraints {
                ca: false,
                max_path_len: None,
            }),
        };
        let (status, created) = call(
            &state,
            "POST",
            "/api/v1/certmgr/profiles",
            &headers,
            Some(json!({
                "name": "edge",
                "issuer_type": "ca",
                "certificate_authority_id": authority_id,
                "policy_id": policy_id,
                "defaults": defaults,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{created}");
        assert_eq!(created["issuer_type"], json!("ca"));
        assert_eq!(created["certificate_authority_id"], json!(authority_id));

        let (status, fetched) = call(
            &state,
            "GET",
            &format!(
                "/api/v1/certmgr/profiles/{}",
                created["id"].as_str().unwrap()
            ),
            &headers,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{fetched}");
        let read_back: ProfileDefaults =
            serde_json::from_value(fetched["defaults"].clone()).unwrap();
        assert_eq!(read_back, defaults);
    }

    #[tokio::test]
    async fn given_a_self_signed_profile_when_an_authority_is_named_then_it_is_refused() {
        let state = state().await;
        let headers = owner(&state);
        let policy_id = seed_policy(&state, &headers, json!({"name": "selfsigned-policy"})).await;
        let authority_id =
            seed_authority(&state, &state.connection_organization.to_string(), "two").await;
        let (status, refused) = call(
            &state,
            "POST",
            "/api/v1/certmgr/profiles",
            &headers,
            Some(json!({
                "name": "confused",
                "issuer_type": "self_signed",
                "certificate_authority_id": authority_id,
                "policy_id": policy_id,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
        assert_eq!(refused["error"], json!("invalid_request"));

        // And a `ca` profile with no authority is refused symmetrically.
        let (status, refused) = call(
            &state,
            "POST",
            "/api/v1/certmgr/profiles",
            &headers,
            Some(json!({
                "name": "rootless",
                "issuer_type": "ca",
                "policy_id": policy_id,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    }

    #[tokio::test]
    async fn given_a_profile_when_repointed_at_a_stricter_policy_then_bad_defaults_are_refused() {
        let state = state().await;
        let headers = owner(&state);
        let permissive = seed_policy(&state, &headers, json!({"name": "permissive"})).await;
        let strict = seed_policy(
            &state,
            &headers,
            json!({"name": "ca-only", "preset": "intermediate_ca"}),
        )
        .await;
        let (status, created) = call(
            &state,
            "POST",
            "/api/v1/certmgr/profiles",
            &headers,
            Some(json!({
                "name": "movable",
                "issuer_type": "self_signed",
                "policy_id": permissive,
                "defaults": {"ext_key_usages": ["server_auth"], "basic_constraints": {"ca": false}},
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{created}");
        let id = created["id"].as_str().unwrap().to_string();

        let (status, refused) = call(
            &state,
            "PATCH",
            &format!("/api/v1/certmgr/profiles/{id}"),
            &headers,
            Some(json!({"policy_id": strict})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
        assert_eq!(refused["error"], json!("policy_violation"));
        assert!(!refused["violations"].as_array().unwrap().is_empty());

        // The stored row is unchanged: the refusal happened before the write.
        let (_, unchanged) = call(
            &state,
            "GET",
            &format!("/api/v1/certmgr/profiles/{id}"),
            &headers,
            None,
        )
        .await;
        assert_eq!(unchanged["policy_id"], json!(permissive));
        assert_eq!(unchanged["version"], json!(1));
    }

    #[tokio::test]
    async fn given_a_profile_with_no_referrers_when_deleted_then_it_is_gone() {
        let state = state().await;
        let headers = owner(&state);
        let policy_id = seed_policy(&state, &headers, json!({"name": "disposable"})).await;
        let (_, created) = call(
            &state,
            "POST",
            "/api/v1/certmgr/profiles",
            &headers,
            Some(
                json!({"name": "disposable", "issuer_type": "self_signed", "policy_id": policy_id}),
            ),
        )
        .await;
        let id = created["id"].as_str().unwrap().to_string();
        let (status, _) = call(
            &state,
            "DELETE",
            &format!("/api/v1/certmgr/profiles/{id}"),
            &headers,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (status, _) = call(
            &state,
            "GET",
            &format!("/api/v1/certmgr/profiles/{id}"),
            &headers,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn given_an_enrollment_config_when_the_profile_is_deleted_then_it_is_refused() {
        let state = state().await;
        let headers = owner(&state);
        let organization = state.connection_organization.to_string();
        let policy_id = seed_policy(&state, &headers, json!({"name": "enrolled"})).await;
        let (_, created) = call(
            &state,
            "POST",
            "/api/v1/certmgr/profiles",
            &headers,
            Some(json!({"name": "enrolled", "issuer_type": "self_signed", "policy_id": policy_id})),
        )
        .await;
        let profile_id = created["id"].as_str().unwrap().to_string();

        let now = chrono::Utc::now().to_rfc3339();
        state
            .db
            .insert_pki_application(&opensesame_storage::StoredPkiApplication {
                id: "pki-application:edge".into(),
                organization_id: organization.clone(),
                slug: "edge".into(),
                display_name: "Edge fleet".into(),
                description: None,
                version: 1,
                created_at: now.clone(),
                updated_at: now.clone(),
            })
            .await
            .unwrap();
        state
            .db
            .insert_enrollment_config(&opensesame_storage::StoredEnrollmentConfig {
                id: "enrollment-config:edge-api".into(),
                organization_id: organization.clone(),
                application_id: "pki-application:edge".into(),
                profile_id: profile_id.clone(),
                method: "api".into(),
                enabled: true,
                config_json: r#"{"mode":"csr","metadata_keys":[]}"#.into(),
                auto_renew_enabled: false,
                renew_before_seconds: None,
                sealed_secret: None,
                version: 1,
                created_at: now.clone(),
                updated_at: now,
            })
            .await
            .unwrap();

        let (status, refused) = call(
            &state,
            "DELETE",
            &format!("/api/v1/certmgr/profiles/{profile_id}"),
            &headers,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{refused}");
        assert_eq!(refused["error"], json!("profile_in_use"));
        assert!(
            refused["hint"]
                .as_str()
                .unwrap()
                .starts_with("1 enrollment config"),
            "the hint must name the referrer count: {refused}"
        );
    }

    // —— adversarial ————————————————————————————————————————————————

    /// Every rule class the evaluator knows, each with a policy that forbids
    /// the default the profile carries. Each must be refused with a violation
    /// naming that field.
    #[tokio::test]
    async fn adversarial_defaults_violating_each_rule_class_are_refused_by_field() {
        let state = state().await;
        let headers = owner(&state);
        let cases: Vec<(&str, Value, Value, &str)> = vec![
            (
                "subject",
                json!({"subject": {"cn": {"mode": "allow", "values": ["*.example.com"]}}}),
                json!({"subject": {"cn": "intruder.evil.test"}}),
                "subject.cn",
            ),
            (
                "subject-dc",
                json!({"subject": {"dc": {"mode": "allow", "components": ["*", "example", "com"]}}}),
                json!({"subject": {"dc": ["evil", "test"]}}),
                "subject.dc",
            ),
            (
                "key-algorithm",
                json!({"key_algorithms": {"mode": "allow", "allowed": ["ecdsa-p256"]}}),
                json!({"key_algorithm": "rsa-2048"}),
                "key_algorithms",
            ),
            (
                "signature-algorithm",
                json!({"signature_algorithms": {"mode": "allow", "allowed": ["sha256-ecdsa"]}}),
                json!({"signature_algorithm": "sha256-rsa"}),
                "signature_algorithms",
            ),
            (
                "key-usage",
                json!({"key_usages": {"mode": "allow", "allowed": ["digital_signature"]}}),
                json!({"key_usages": ["key_cert_sign"]}),
                "key_usages",
            ),
            (
                "ext-key-usage",
                json!({"ext_key_usages": {"mode": "allow", "allowed": ["server_auth"]}}),
                json!({"ext_key_usages": ["code_signing"]}),
                "ext_key_usages",
            ),
            (
                "basic-constraints",
                json!({"basic_constraints": {"ca": "forbid"}}),
                json!({"basic_constraints": {"ca": true}}),
                "basic_constraints.ca",
            ),
        ];
        for (label, rules, defaults, expected_field) in cases {
            let policy_id = seed_policy(
                &state,
                &headers,
                json!({"name": format!("policy-{label}"), "rules": rules}),
            )
            .await;
            let (status, refused) = call(
                &state,
                "POST",
                "/api/v1/certmgr/profiles",
                &headers,
                Some(json!({
                    "name": format!("profile-{label}"),
                    "issuer_type": "self_signed",
                    "policy_id": policy_id,
                    "defaults": defaults,
                })),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{label}: {refused}");
            assert_eq!(refused["error"], json!("policy_violation"), "{label}");
            let fields: Vec<&str> = refused["violations"]
                .as_array()
                .unwrap()
                .iter()
                .map(|violation| violation["field"].as_str().unwrap())
                .collect();
            assert!(
                fields.contains(&expected_field),
                "{label}: expected a violation on {expected_field}, got {fields:?}"
            );

            // Nothing was stored.
            let (_, listed) = call(&state, "GET", "/api/v1/certmgr/profiles", &headers, None).await;
            assert_eq!(listed["profiles"], json!([]), "{label} left a row behind");
        }
    }

    /// The SAN rule class is the one class a profile's defaults cannot reach:
    /// [`ProfileDefaults`] carries no subject alternative names, so a policy
    /// that switches every SAN class off with the `allow`-with-no-values form
    /// still accepts a profile. That is not a gap — the SAN whitelist is
    /// enforced against the *request* at issue time, where the names actually
    /// arrive. This test pins that reasoning so a future default that does
    /// carry SANs fails here first.
    #[tokio::test]
    async fn given_a_policy_forbidding_every_san_class_when_a_profile_is_saved_then_it_is_accepted()
    {
        let state = state().await;
        let headers = owner(&state);
        let policy_id = seed_policy(
            &state,
            &headers,
            json!({"name": "no-sans", "preset": "intermediate_ca"}),
        )
        .await;
        let (status, created) = call(
            &state,
            "POST",
            "/api/v1/certmgr/profiles",
            &headers,
            Some(json!({
                "name": "no-sans",
                "issuer_type": "self_signed",
                "policy_id": policy_id,
                "defaults": {
                    "key_usages": ["digital_signature", "key_cert_sign", "crl_sign"],
                    "basic_constraints": {"ca": true, "max_path_len": 0},
                },
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{created}");
        let defaults: ProfileDefaults =
            serde_json::from_value(created["defaults"].clone()).unwrap();
        assert!(
            serde_json::to_value(&defaults)
                .unwrap()
                .get("san")
                .is_none(),
            "ProfileDefaults must not grow a SAN field without revisiting this test"
        );
    }

    #[tokio::test]
    async fn adversarial_a_profile_cannot_reference_another_organizations_ca_or_policy() {
        let state = state().await;
        let headers = owner(&state);
        let (foreign_headers, foreign_organization) = foreign_owner(&state);

        // A policy and an authority that exist, but in the other tenant.
        let foreign_policy = seed_policy(
            &state,
            &foreign_headers,
            json!({"name": "foreign-policy", "preset": "user"}),
        )
        .await;
        let foreign_authority =
            seed_authority(&state, &foreign_organization.to_string(), "foreign").await;
        let local_policy = seed_policy(&state, &headers, json!({"name": "local-policy"})).await;
        let local_authority =
            seed_authority(&state, &state.connection_organization.to_string(), "local").await;

        let (status, refused) = call(
            &state,
            "POST",
            "/api/v1/certmgr/profiles",
            &headers,
            Some(json!({
                "name": "cross-tenant-policy",
                "issuer_type": "ca",
                "certificate_authority_id": local_authority,
                "policy_id": foreign_policy,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
        assert_eq!(refused["error"], json!("unknown_policy"));

        let (status, refused) = call(
            &state,
            "POST",
            "/api/v1/certmgr/profiles",
            &headers,
            Some(json!({
                "name": "cross-tenant-ca",
                "issuer_type": "ca",
                "certificate_authority_id": foreign_authority,
                "policy_id": local_policy,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
        assert_eq!(refused["error"], json!("unknown_certificate_authority"));

        // A policy id that simply does not exist is indistinguishable from the
        // cross-tenant one — no existence leak.
        let (status, absent) = call(
            &state,
            "POST",
            "/api/v1/certmgr/profiles",
            &headers,
            Some(json!({
                "name": "absent-policy",
                "issuer_type": "self_signed",
                "policy_id": "certificate-policy:does-not-exist",
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{absent}");
        assert_eq!(absent["error"], json!("unknown_policy"));
    }

    #[tokio::test]
    async fn adversarial_a_profile_in_another_organization_is_not_found() {
        let state = state().await;
        let headers = owner(&state);
        let policy_id = seed_policy(&state, &headers, json!({"name": "hidden"})).await;
        let (_, created) = call(
            &state,
            "POST",
            "/api/v1/certmgr/profiles",
            &headers,
            Some(json!({"name": "hidden", "issuer_type": "self_signed", "policy_id": policy_id})),
        )
        .await;
        let id = created["id"].as_str().unwrap().to_string();
        let (foreign, _) = foreign_owner(&state);
        for (method, body) in [
            ("GET", None),
            ("PATCH", Some(json!({"name": "stolen"}))),
            ("DELETE", None),
        ] {
            let (status, response) = call(
                &state,
                method,
                &format!("/api/v1/certmgr/profiles/{id}"),
                &foreign,
                body,
            )
            .await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{method}: {response}");
        }
    }

    #[tokio::test]
    async fn adversarial_a_member_cannot_read_or_write_profiles() {
        let state = state().await;
        let member = member(&state);
        for (method, path, body) in [
            ("GET", "/api/v1/certmgr/profiles", None),
            (
                "POST",
                "/api/v1/certmgr/profiles",
                Some(json!({"name": "nope", "issuer_type": "self_signed", "policy_id": "p"})),
            ),
            ("GET", "/api/v1/certmgr/profiles/anything", None),
            (
                "PATCH",
                "/api/v1/certmgr/profiles/anything",
                Some(json!({"name": "nope"})),
            ),
            ("DELETE", "/api/v1/certmgr/profiles/anything", None),
        ] {
            let (status, response) = call(&state, method, path, &member, body).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}: {response}");
        }
    }

    #[tokio::test]
    async fn adversarial_unknown_body_fields_and_enum_values_are_rejected() {
        let state = state().await;
        let headers = owner(&state);
        let policy_id = seed_policy(&state, &headers, json!({"name": "strict-body"})).await;
        for body in [
            json!({"name": "a", "issuer_type": "self_signed", "policy_id": policy_id, "organization_id": "org:other"}),
            json!({"name": "b", "issuer_type": "external", "policy_id": policy_id}),
            json!({"name": "c", "issuer_type": "self_signed", "policy_id": policy_id, "defaults": {"ttl_seconds": 60, "surprise": 1}}),
            json!({"name": "d", "issuer_type": "self_signed", "policy_id": policy_id, "external_template": "v2-template"}),
            json!({"issuer_type": "self_signed", "policy_id": policy_id}),
        ] {
            let (status, response) = call(
                &state,
                "POST",
                "/api/v1/certmgr/profiles",
                &headers,
                Some(body),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{response}");
        }
    }

    // —— chaos ——————————————————————————————————————————————————————

    #[tokio::test]
    async fn chaos_concurrent_profile_patches_surface_one_clean_conflict() {
        let state = state().await;
        let headers = owner(&state);
        let policy_id = seed_policy(&state, &headers, json!({"name": "raced-profile"})).await;
        let (_, created) = call(
            &state,
            "POST",
            "/api/v1/certmgr/profiles",
            &headers,
            Some(json!({"name": "raced", "issuer_type": "self_signed", "policy_id": policy_id})),
        )
        .await;
        let id = created["id"].as_str().unwrap().to_string();
        let path = format!("/api/v1/certmgr/profiles/{id}");
        let first = call(
            &state,
            "PATCH",
            &path,
            &headers,
            Some(json!({"version": 1, "defaults": {"ttl_seconds": 3600}})),
        );
        let second = call(
            &state,
            "PATCH",
            &path,
            &headers,
            Some(json!({"version": 1, "defaults": {"ttl_seconds": 7200}})),
        );
        let ((first_status, first_body), (second_status, second_body)) =
            tokio::join!(first, second);
        let statuses = [first_status, second_status];
        assert!(
            statuses.contains(&StatusCode::OK) && statuses.contains(&StatusCode::CONFLICT),
            "{first_body} / {second_body}"
        );
        for status in statuses {
            assert!(!status.is_server_error(), "{status}");
        }
        let (_, final_state) = call(
            &state,
            "GET",
            &format!("/api/v1/certmgr/profiles/{id}"),
            &headers,
            None,
        )
        .await;
        assert_eq!(final_state["version"], json!(2));
        let ttl = final_state["defaults"]["ttl_seconds"].as_u64().unwrap();
        assert!(ttl == 3600 || ttl == 7200, "{final_state}");
    }

    #[tokio::test]
    async fn chaos_oversized_and_absurd_profile_bodies_degrade_cleanly() {
        let state = state().await;
        let headers = owner(&state);
        let policy_id = seed_policy(&state, &headers, json!({"name": "chaos-policy"})).await;

        // A mebibyte of subject text: past the body limit, never a 500.
        let huge = "n".repeat(1024 * 1024);
        let (status, body) = call(
            &state,
            "POST",
            "/api/v1/certmgr/profiles",
            &headers,
            Some(json!({
                "name": "huge",
                "issuer_type": "self_signed",
                "policy_id": policy_id,
                "defaults": {"subject": {"cn": huge}},
            })),
        )
        .await;
        assert!(status.is_client_error(), "{status}: {body}");

        // `u64::MAX` seconds of default lifetime parses and is stored as-is;
        // the policy's `max_validity_seconds` is what refuses it at issue time.
        let (status, body) = call(
            &state,
            "POST",
            "/api/v1/certmgr/profiles",
            &headers,
            Some(json!({
                "name": "forever",
                "issuer_type": "self_signed",
                "policy_id": policy_id,
                "defaults": {"ttl_seconds": u64::MAX},
            })),
        )
        .await;
        assert!(!status.is_server_error(), "{status}: {body}");

        // A defaults document nested far past any legitimate depth.
        let mut nested = String::new();
        for _ in 0..2_000 {
            nested.push_str("{\"subject\":");
        }
        let (status, body) = crate::routes::certmgr_policy::tests::call_raw(
            &state,
            "POST",
            "/api/v1/certmgr/profiles",
            &headers,
            Some(format!(
                "{{\"name\":\"nested\",\"issuer_type\":\"self_signed\",\"policy_id\":\"{policy_id}\",\"defaults\":{nested}null}}"
            )),
        )
        .await;
        assert!(status.is_client_error(), "{status}: {body}");
    }

    // —— snapshot (insta) ————————————————————————————————————————————

    #[tokio::test]
    async fn snapshot_profile_create_and_get_wire_shapes_are_pinned() {
        let state = state().await;
        let headers = owner(&state);
        let policy_id = seed_policy(
            &state,
            &headers,
            json!({"name": "snapshot-policy", "preset": "tls_server"}),
        )
        .await;
        let authority_id =
            seed_authority(&state, &state.connection_organization.to_string(), "snap").await;
        let (_, created) = call(
            &state,
            "POST",
            "/api/v1/certmgr/profiles",
            &headers,
            Some(json!({
                "name": "edge-tls",
                "issuer_type": "ca",
                "certificate_authority_id": authority_id,
                "policy_id": policy_id,
                "defaults": {
                    "ttl_seconds": 86400,
                    "key_algorithm": "ecdsa-p256",
                    "signature_algorithm": "sha256-ecdsa",
                    "key_usages": ["digital_signature"],
                    "ext_key_usages": ["server_auth"],
                },
            })),
        )
        .await;
        insta::assert_json_snapshot!(created, {
            ".id" => "[id]",
            ".policy_id" => "[policy_id]",
            ".created_at" => "[timestamp]",
            ".updated_at" => "[timestamp]",
        }, @r###"
        {
          "certificate_authority_id": "certificate-authority:snap",
          "created_at": "[timestamp]",
          "defaults": {
            "ext_key_usages": [
              "server_auth"
            ],
            "key_algorithm": "ecdsa-p256",
            "key_usages": [
              "digital_signature"
            ],
            "signature_algorithm": "sha256-ecdsa",
            "ttl_seconds": 86400
          },
          "id": "[id]",
          "issuer_type": "ca",
          "name": "edge-tls",
          "policy_id": "[policy_id]",
          "updated_at": "[timestamp]",
          "version": 1
        }
        "###);

        let (_, fetched) = call(
            &state,
            "GET",
            &format!(
                "/api/v1/certmgr/profiles/{}",
                created["id"].as_str().unwrap()
            ),
            &headers,
            None,
        )
        .await;
        assert_eq!(
            fetched, created,
            "GET must project exactly what POST returned"
        );
    }

    /// The most valuable snapshot in this module: the violation list an
    /// operator sees when a profile's defaults contradict its own policy.
    #[tokio::test]
    async fn snapshot_defaults_versus_policy_violation_list_is_pinned() {
        let state = state().await;
        let headers = owner(&state);
        let policy_id = seed_policy(
            &state,
            &headers,
            json!({"name": "violated", "preset": "tls_server"}),
        )
        .await;
        let (status, refused) = call(
            &state,
            "POST",
            "/api/v1/certmgr/profiles",
            &headers,
            Some(json!({
                "name": "contradiction",
                "issuer_type": "self_signed",
                "policy_id": policy_id,
                "defaults": {
                    "key_algorithm": "ed25519",
                    "signature_algorithm": "ed25519",
                    "ext_key_usages": ["code_signing"],
                    "basic_constraints": {"ca": true, "max_path_len": 3},
                },
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
        insta::assert_json_snapshot!(refused, @r###"
        {
          "error": "policy_violation",
          "hint": "the profile defaults are forbidden by the policy this profile references",
          "violations": [
            {
              "field": "signature_algorithms",
              "reason": "value \"ed25519\" is not permitted"
            },
            {
              "field": "key_algorithms",
              "reason": "value \"ed25519\" is not permitted"
            },
            {
              "field": "ext_key_usages",
              "reason": "value \"code_signing\" is not permitted"
            },
            {
              "field": "basic_constraints.ca",
              "reason": "certificate authority certificates are forbidden"
            }
          ]
        }
        "###);
    }
}
