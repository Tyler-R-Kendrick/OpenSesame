use axum::extract::{Path, Query, State};
use axum::http::{Extensions, HeaderMap, StatusCode};
use axum::Json;
use opensesame_domain::transport::operations;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::config::constant_time_eq;

use super::admit::{
    address, claimed_by_other, digest_hex, lock, member_allows, owner_kind_conflict, owner_kind_of,
    presented_key, publish_allows, registration_binds, remember, snapshot_ok, MemberAction,
};
use super::identity::resolve_identity;
use super::{DirEntry, RelayState, Slot, MAX_SNAPSHOT_BYTES};

pub(crate) async fn get_snapshot(
    State(state): State<RelayState>,
    Path((owner, slug)): Path<(String, String)>,
    headers: HeaderMap,
    extensions: Extensions,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if state.mtls.is_some() {
        if super::service_admit::require_vault_relay_caller(
            &state,
            &extensions,
            operations::VAULT_RELAY_SNAPSHOT_READ,
        )
        .is_err()
        {
            return Err(forbidden());
        }
    }
    let address = address(&owner, &slug).ok_or(not_found())?;
    let key = presented_key(&headers).ok_or(unauthorized())?;
    let digest = digest_hex(&key);
    let guard = lock(&state.store);
    let slot = guard.slots.get(&address).ok_or(not_found())?;
    if !constant_time_eq(&slot.key_sha256, &digest) {
        return Err(unauthorized());
    }
    Ok(Json(json!({
        "generation": slot.generation,
        "snapshot": slot.snapshot,
    })))
}

#[derive(Deserialize)]
pub(crate) struct PutBody {
    expected_generation: u64,
    snapshot: Value,
}

pub(crate) async fn put_snapshot(
    State(state): State<RelayState>,
    Path((owner, slug)): Path<(String, String)>,
    headers: HeaderMap,
    extensions: Extensions,
    Json(body): Json<PutBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if state.mtls.is_some() {
        if super::service_admit::require_vault_relay_caller(
            &state,
            &extensions,
            operations::VAULT_RELAY_SNAPSHOT_WRITE,
        )
        .is_err()
        {
            return Err(forbidden());
        }
    }
    let address = address(&owner, &slug).ok_or(not_found())?;
    let owner_kind = owner_kind_of(&headers)
        .map_err(|status| (status, Json(json!({ "error": "malformed" }))))?;
    let key = presented_key(&headers).ok_or(unauthorized())?;
    if !snapshot_ok(&body.snapshot) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "malformed" })),
        ));
    }
    let encoded = serde_json::to_vec(&body.snapshot).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "malformed" })),
        )
    })?;
    if encoded.len() > MAX_SNAPSHOT_BYTES {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({ "error": "too_large" })),
        ));
    }
    let digest = digest_hex(&key);
    let now = unix_now();
    let identity = resolve_identity(&headers, state.registration.as_ref(), now)?;
    if !registration_binds(
        state.registration.is_some(),
        identity.owner.as_deref(),
        &owner,
    ) {
        return Err(forbidden());
    }
    if !publish_allows(owner_kind, &identity.principal, &owner, identity.role) {
        return Err(forbidden());
    }
    let mut guard = lock(&state.store);
    if owner_kind_conflict(&guard, &owner, owner_kind) {
        return Err((StatusCode::CONFLICT, Json(json!({ "error": "owner_kind" }))));
    }
    if claimed_by_other(&guard, &address, &identity.principal) {
        return Err((StatusCode::CONFLICT, Json(json!({ "error": "claimed" }))));
    }
    if guard.slots.contains_key(&address) {
        let generation = {
            let slot = guard.slots.get_mut(&address).expect("slot");
            if !constant_time_eq(&slot.key_sha256, &digest) {
                return Err(unauthorized());
            }
            if slot.generation != body.expected_generation {
                let generation = slot.generation;
                return Err((
                    StatusCode::CONFLICT,
                    Json(json!({ "generation": generation })),
                ));
            }
            slot.generation += 1;
            slot.snapshot = body.snapshot;
            slot.generation
        };
        remember(&mut guard, &address, owner_kind, &identity.principal);
        return Ok(Json(json!({ "generation": generation })));
    }
    if body.expected_generation != 0 {
        return Err(not_found());
    }
    let generation = 1;
    guard.slots.insert(
        address.clone(),
        Slot {
            key_sha256: digest,
            generation,
            snapshot: body.snapshot,
        },
    );
    remember(&mut guard, &address, owner_kind, &identity.principal);
    Ok(Json(json!({ "generation": generation })))
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

pub(crate) fn unauthorized() -> (StatusCode, Json<Value>) {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "unauthorized" })),
    )
}

pub(crate) fn forbidden() -> (StatusCode, Json<Value>) {
    (StatusCode::FORBIDDEN, Json(json!({ "error": "forbidden" })))
}

pub(crate) fn not_found() -> (StatusCode, Json<Value>) {
    (StatusCode::NOT_FOUND, Json(json!({ "error": "not_found" })))
}

#[derive(Deserialize)]
pub(crate) struct ListQuery {
    principal: Option<String>,
    owner: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct CreateBody {
    #[serde(rename = "ownerKind")]
    owner_kind: String,
    owner: String,
    slug: String,
}

pub(crate) fn vault_json(entry: &DirEntry) -> Value {
    json!({
        "ownerKind": entry.owner_kind,
        "owner": entry.owner,
        "slug": entry.slug,
    })
}

pub(crate) async fn list_org_vaults(
    State(state): State<RelayState>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let now = unix_now();
    let identity = resolve_identity(&headers, state.registration.as_ref(), now)?;
    let principal = query.principal.filter(|value| !value.is_empty());
    let owner = query.owner.filter(|value| !value.is_empty());
    if state.registration.is_some() {
        let Some(bound) = identity.owner.as_deref().filter(|value| !value.is_empty()) else {
            return Err(forbidden());
        };
        if owner.as_ref().is_some_and(|value| value != bound) {
            return Err(forbidden());
        }
    }
    // A member may list. With no role the owner and principal filters stand.
    let listed_as = principal.as_deref().unwrap_or("");
    let listed_owner = owner.as_deref().unwrap_or("");
    if !member_allows(
        MemberAction::List,
        "organization",
        listed_as,
        listed_owner,
        identity.role,
    ) {
        return Err(forbidden());
    }
    if principal.is_none() && owner.is_none() {
        return Ok(Json(json!({ "vaults": [] })));
    }
    let guard = lock(&state.store);
    let mut vaults = Vec::new();
    for entry in guard.directory.values() {
        if principal
            .as_ref()
            .is_some_and(|value| entry.principal != *value)
        {
            continue;
        }
        if owner.as_ref().is_some_and(|value| entry.owner != *value) {
            continue;
        }
        if state.registration.is_some()
            && identity
                .owner
                .as_ref()
                .is_some_and(|bound| entry.owner != *bound)
        {
            continue;
        }
        vaults.push(vault_json(entry));
    }
    Ok(Json(json!({ "vaults": vaults })))
}

pub(crate) async fn create_org_vault(
    State(state): State<RelayState>,
    headers: HeaderMap,
    Json(body): Json<CreateBody>,
) -> Result<(StatusCode, Json<Value>), (StatusCode, Json<Value>)> {
    if body.owner_kind != "user" && body.owner_kind != "organization" {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "malformed" })),
        ));
    }
    let address = address(&body.owner, &body.slug).ok_or((
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": "malformed" })),
    ))?;
    let now = unix_now();
    let identity = resolve_identity(&headers, state.registration.as_ref(), now)?;
    if !registration_binds(
        state.registration.is_some(),
        identity.owner.as_deref(),
        &body.owner,
    ) {
        return Err(forbidden());
    }
    if identity.principal.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "malformed" })),
        ));
    }
    if !member_allows(
        MemberAction::Create,
        &body.owner_kind,
        &identity.principal,
        &body.owner,
        identity.role,
    ) {
        return Err(forbidden());
    }
    let mut guard = lock(&state.store);
    if owner_kind_conflict(&guard, &body.owner, &body.owner_kind) {
        return Err((StatusCode::CONFLICT, Json(json!({ "error": "owner_kind" }))));
    }
    if let Some(entry) = guard.directory.get(&address) {
        if entry.principal != identity.principal {
            return Err((StatusCode::CONFLICT, Json(json!({ "error": "claimed" }))));
        }
        return Ok((StatusCode::OK, Json(json!({ "vault": vault_json(entry) }))));
    }
    remember(&mut guard, &address, &body.owner_kind, &identity.principal);
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "vault": {
                "ownerKind": body.owner_kind,
                "owner": body.owner,
                "slug": body.slug,
            }
        })),
    ))
}
