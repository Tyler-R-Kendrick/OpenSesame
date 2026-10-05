//! The device and key operations (ADR 0169 §4), validated before anything is
//! sent and answered in [`crate::wire`]'s shapes. The daemon's routes and the
//! `opensesame tailnet` CLI both call these; neither speaks to Tailscale any
//! other way.

use serde_json::{json, Value};

use crate::config::CredentialKind;
use crate::validate::{self, KeyRequest};
use crate::wire::{self, DeviceView, KeyView, RoutesView};
use crate::{AdminError, AdminStore, Upstream};

/// Bare auth keys whose details are fetched one by one; more are listed by
/// id only.
const DETAILED_KEYS: usize = 50;

fn tailnet(store: &AdminStore) -> Result<String, AdminError> {
    Ok(store.config()?.ok_or(AdminError::NotConnected)?.tailnet)
}

/// Whether a tailnet is connected, which, and with what kind of credential.
///
/// # Errors
///
/// A state file this build cannot read.
pub fn status(store: &AdminStore) -> Result<Value, AdminError> {
    Ok(match store.config()? {
        None => json!({ "connected": false }),
        Some(config) => json!({
            "connected": true,
            "tailnet": config.tailnet,
            "credential": config.credential.kind,
            "connected_at": config.connected_at,
        }),
    })
}

/// Every device on the tailnet.
///
/// # Errors
///
/// See [`Upstream::call`].
pub async fn list_devices(
    up: &Upstream,
    store: &AdminStore,
) -> Result<Vec<DeviceView>, AdminError> {
    let tailnet = tailnet(store)?;
    let raw = up
        .call(
            store,
            "GET",
            &format!("/tailnet/{tailnet}/devices?fields=all"),
            None,
        )
        .await?;
    Ok(wire::devices(&raw))
}

/// One device.
///
/// # Errors
///
/// `invalid_id`, or see [`Upstream::call`].
pub async fn get_device(
    up: &Upstream,
    store: &AdminStore,
    id: &str,
) -> Result<DeviceView, AdminError> {
    let id = validate::id(id)?;
    let raw = up
        .call(store, "GET", &format!("/device/{id}?fields=all"), None)
        .await?;
    wire::device(&raw).ok_or(AdminError::Unavailable("device answer unreadable".into()))
}

async fn post(
    up: &Upstream,
    store: &AdminStore,
    id: &str,
    what: &str,
    body: Value,
) -> Result<Value, AdminError> {
    let id = validate::id(id)?;
    up.call(store, "POST", &format!("/device/{id}/{what}"), Some(&body))
        .await
}

/// Admit a device to the tailnet, or put it out.
///
/// # Errors
///
/// `invalid_id`, or see [`Upstream::call`].
pub async fn set_authorized(
    up: &Upstream,
    store: &AdminStore,
    id: &str,
    authorized: bool,
) -> Result<(), AdminError> {
    post(
        up,
        store,
        id,
        "authorized",
        json!({ "authorized": authorized }),
    )
    .await
    .map(drop)
}

/// Rename a device; an empty name resets it to its hostname.
///
/// # Errors
///
/// `invalid_id`, `invalid_name`, or see [`Upstream::call`].
pub async fn rename(
    up: &Upstream,
    store: &AdminStore,
    id: &str,
    name: &str,
) -> Result<(), AdminError> {
    let name = validate::name(name)?;
    post(up, store, id, "name", json!({ "name": name }))
        .await
        .map(drop)
}

/// Replace a device's tags.
///
/// # Errors
///
/// `invalid_id`, `invalid_tags`, or see [`Upstream::call`].
pub async fn set_tags(
    up: &Upstream,
    store: &AdminStore,
    id: &str,
    tags: &[String],
) -> Result<(), AdminError> {
    let tags = validate::tags(tags)?;
    post(up, store, id, "tags", json!({ "tags": tags }))
        .await
        .map(drop)
}

/// Turn a device's key expiry off, or back on.
///
/// # Errors
///
/// `invalid_id`, or see [`Upstream::call`].
pub async fn set_key_expiry_disabled(
    up: &Upstream,
    store: &AdminStore,
    id: &str,
    disabled: bool,
) -> Result<(), AdminError> {
    post(
        up,
        store,
        id,
        "key",
        json!({ "keyExpiryDisabled": disabled }),
    )
    .await
    .map(drop)
}

/// Expire a device's key now: it must sign in again.
///
/// # Errors
///
/// `invalid_id`, or see [`Upstream::call`].
pub async fn expire(up: &Upstream, store: &AdminStore, id: &str) -> Result<(), AdminError> {
    let id = validate::id(id)?;
    up.call(store, "POST", &format!("/device/{id}/expire"), None)
        .await
        .map(drop)
}

/// Replace a device's enabled routes; `0.0.0.0/0` and `::/0` make it an exit
/// node.
///
/// # Errors
///
/// `invalid_id`, `invalid_routes`, or see [`Upstream::call`].
pub async fn set_routes(
    up: &Upstream,
    store: &AdminStore,
    id: &str,
    routes: &[String],
) -> Result<RoutesView, AdminError> {
    let routes = validate::routes(routes)?;
    let raw = post(up, store, id, "routes", json!({ "routes": routes })).await?;
    Ok(wire::routes(&raw))
}

/// Remove a device from the tailnet.
///
/// # Errors
///
/// `invalid_id`, or see [`Upstream::call`].
pub async fn delete_device(up: &Upstream, store: &AdminStore, id: &str) -> Result<(), AdminError> {
    let id = validate::id(id)?;
    up.call(store, "DELETE", &format!("/device/{id}"), None)
        .await
        .map(drop)
}

/// The tailnet's auth keys, never their secrets.
///
/// # Errors
///
/// See [`Upstream::call`].
pub async fn list_keys(up: &Upstream, store: &AdminStore) -> Result<Vec<KeyView>, AdminError> {
    let tailnet = tailnet(store)?;
    let raw = up
        .call(store, "GET", &format!("/tailnet/{tailnet}/keys"), None)
        .await?;
    let mut out = Vec::new();
    for (index, (id, described)) in wire::key_ids(&raw).into_iter().enumerate() {
        if let Some(view) = described {
            out.push(view);
            continue;
        }
        if index >= DETAILED_KEYS {
            continue;
        }
        // A key revoked between the list and this read is simply gone.
        match up
            .call(store, "GET", &format!("/tailnet/{tailnet}/keys/{id}"), None)
            .await
        {
            Ok(detail) => out.extend(wire::key(&detail)),
            Err(AdminError::NotFound) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(out)
}

/// Mint an auth key. The answer carries its secret, once.
///
/// # Errors
///
/// The [`validate::key_request`] codes, `tags_required` through an OAuth
/// client, or see [`Upstream::call`].
pub async fn create_key(
    up: &Upstream,
    store: &AdminStore,
    request: KeyRequest,
) -> Result<Value, AdminError> {
    let config = store.config()?.ok_or(AdminError::NotConnected)?;
    let oauth = config.credential.kind == CredentialKind::Oauth;
    let request = validate::key_request(&request, oauth)?;
    let raw = up
        .call(
            store,
            "POST",
            &format!("/tailnet/{}/keys", config.tailnet),
            Some(&wire::create_key_body(&request)),
        )
        .await?;
    wire::created_key(&raw).ok_or(AdminError::Unavailable("key answer unreadable".into()))
}

/// Revoke an auth key.
///
/// # Errors
///
/// `invalid_id`, or see [`Upstream::call`].
pub async fn delete_key(up: &Upstream, store: &AdminStore, id: &str) -> Result<(), AdminError> {
    let id = validate::id(id)?;
    let tailnet = tailnet(store)?;
    up.call(
        store,
        "DELETE",
        &format!("/tailnet/{tailnet}/keys/{id}"),
        None,
    )
    .await
    .map(drop)
}
