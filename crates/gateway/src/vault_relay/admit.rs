use axum::http::{HeaderMap, StatusCode};
use base64::Engine;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{DirEntry, Shared, Store, ORG_ROLE, OWNER_KIND, PRINCIPAL, SLOT_KEY, SNAPSHOT_FORMAT};

pub(crate) fn valid_segment(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=63).contains(&bytes.len())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        && !value.starts_with('-')
        && !value.ends_with('-')
        && value != "guest"
}

pub(crate) fn address(owner: &str, slug: &str) -> Option<String> {
    if valid_segment(owner) && valid_segment(slug) {
        Some(format!("{owner}/{slug}"))
    } else {
        None
    }
}

pub(crate) fn digest_hex(key: &str) -> String {
    hex::encode(Sha256::digest(key.as_bytes()))
}

pub(crate) fn presented_key(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(SLOT_KEY)?.to_str().ok()?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(raw)
        .ok()?;
    if bytes.len() == 32 {
        Some(raw.to_string())
    } else {
        None
    }
}

pub(crate) fn owner_kind_of(headers: &HeaderMap) -> Result<&'static str, StatusCode> {
    match headers
        .get(OWNER_KIND)
        .and_then(|value| value.to_str().ok())
    {
        None | Some("" | "user") => Ok("user"),
        Some("organization") => Ok("organization"),
        Some(_) => Err(StatusCode::BAD_REQUEST),
    }
}

pub(crate) fn principal_of(headers: &HeaderMap) -> String {
    headers
        .get(PRINCIPAL)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .chars()
        .take(128)
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OrgRole {
    Owner,
    Admin,
    Member,
}

pub(crate) enum MemberAction {
    List,
    Create,
}

pub(crate) fn org_role_of(headers: &HeaderMap) -> Result<Option<OrgRole>, StatusCode> {
    match headers.get(ORG_ROLE).and_then(|value| value.to_str().ok()) {
        None | Some("") => Ok(None),
        Some("owner") => Ok(Some(OrgRole::Owner)),
        Some("admin") => Ok(Some(OrgRole::Admin)),
        Some("member") => Ok(Some(OrgRole::Member)),
        Some(_) => Err(StatusCode::BAD_REQUEST),
    }
}

/// Who may list or create a directory row (ADR 0181 §3 and §4).
///
/// A user address belongs to that principal's handle. An organization
/// address may be created by an owner or an admin. A member may list and
/// may not create. With no role, no issuer is configured, and the first
/// principal to claim the address is the admission.
pub(crate) fn member_allows(
    action: MemberAction,
    owner_kind: &str,
    principal: &str,
    owner: &str,
    role: Option<OrgRole>,
) -> bool {
    if owner_kind == "user" {
        return match action {
            MemberAction::List => principal.is_empty() || principal == owner,
            MemberAction::Create => principal == owner,
        };
    }
    if owner_kind != "organization" {
        return false;
    }
    match (action, role) {
        (MemberAction::List, _)
        | (MemberAction::Create, None | Some(OrgRole::Owner | OrgRole::Admin)) => true,
        (MemberAction::Create, Some(OrgRole::Member)) => false,
    }
}

/// A configured issuer binds the registration to one owner handle.
///
/// Absent issuer keeps slot-key admission. Present issuer requires the JWT
/// `owner` claim to be that handle — a token minted for one org does not
/// open another.
pub(crate) fn registration_binds(
    issuer_configured: bool,
    bound_owner: Option<&str>,
    resource_owner: &str,
) -> bool {
    if !issuer_configured {
        return true;
    }
    bound_owner == Some(resource_owner)
}

/// Who may push a snapshot (ADR 0181 §4).
///
/// The handle's principal may publish a user address. An organization owner
/// or admin may publish. A member may not. With no role, the slot key is
/// the admission.
pub(crate) fn publish_allows(
    owner_kind: &str,
    principal: &str,
    owner: &str,
    role: Option<OrgRole>,
) -> bool {
    if owner_kind == "user" {
        return principal.is_empty() || principal == owner;
    }
    if owner_kind != "organization" {
        return false;
    }
    match role {
        None | Some(OrgRole::Owner | OrgRole::Admin) => true,
        Some(OrgRole::Member) => false,
    }
}

pub(crate) fn snapshot_ok(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.get("format").and_then(Value::as_str) == Some(SNAPSHOT_FORMAT)
        && object.get("v").and_then(Value::as_u64) == Some(1)
}

pub(crate) fn lock(store: &Shared) -> std::sync::MutexGuard<'_, Store> {
    store
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Refuse when the owner label is already registered under another kind.
pub(crate) fn owner_kind_conflict(store: &Store, owner: &str, owner_kind: &str) -> bool {
    store
        .owners
        .get(owner)
        .is_some_and(|existing| existing != owner_kind)
}

pub(crate) fn register_owner(store: &mut Store, owner: &str, owner_kind: &str) {
    store
        .owners
        .insert(owner.to_string(), owner_kind.to_string());
}

pub(crate) fn remember(store: &mut Store, address: &str, owner_kind: &str, principal: &str) {
    let Some((owner, slug)) = address.split_once('/') else {
        return;
    };
    register_owner(store, owner, owner_kind);
    match store.directory.get_mut(address) {
        Some(entry) => {
            entry.owner_kind = owner_kind.to_string();
            if !principal.is_empty() {
                entry.principal = principal.to_string();
            }
        }
        None => {
            store.directory.insert(
                address.to_string(),
                DirEntry {
                    owner_kind: owner_kind.to_string(),
                    owner: owner.to_string(),
                    slug: slug.to_string(),
                    principal: principal.to_string(),
                },
            );
        }
    }
}

pub(crate) fn claimed_by_other(store: &Store, address: &str, principal: &str) -> bool {
    store.directory.get(address).is_some_and(|entry| {
        !entry.principal.is_empty() && !principal.is_empty() && entry.principal != principal
    })
}
