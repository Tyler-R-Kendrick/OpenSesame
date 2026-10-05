//! Tailscale's shapes in, the daemon's own out (ADR 0166 §4).
//!
//! A page is answered in snake case with only the fields it shows, so a
//! change to Tailscale's wire format is absorbed here and a field Tailscale
//! adds never reaches a browser by accident. Strings are bounded, lists are
//! capped, and a zero time (`0001-01-01…`, Tailscale's "never") is `null`.
//! A key's secret appears in exactly one place: [`created_key`].

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::validate::KeyRequest;

const MAX_TEXT: usize = 255;
const MAX_LIST: usize = 256;

fn text(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_TEXT)
        .collect()
}

fn time(value: Option<&Value>) -> Option<String> {
    let raw = text(value);
    (!raw.is_empty() && !raw.starts_with("0001-")).then_some(raw)
}

fn flag(value: Option<&Value>) -> bool {
    value.and_then(Value::as_bool).unwrap_or(false)
}

fn list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .take(MAX_LIST)
                .map(|item| item.chars().take(MAX_TEXT).collect())
                .collect()
        })
        .unwrap_or_default()
}

/// One device, as a page sees it.
#[expect(
    clippy::struct_excessive_bools,
    reason = "a wire view of Tailscale's own per-device flags, one field each"
)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DeviceView {
    /// The stable `nodeId`; the legacy numeric id when Tailscale sent none.
    pub id: String,
    /// The `MagicDNS` name (`web-01.tail1234.ts.net`).
    pub name: String,
    /// The OS hostname the device reported.
    pub hostname: String,
    pub os: String,
    pub client_version: String,
    pub update_available: bool,
    pub user: String,
    pub addresses: Vec<String>,
    pub tags: Vec<String>,
    pub authorized: bool,
    pub external: bool,
    pub ephemeral: bool,
    pub key_expiry_disabled: bool,
    pub expires: Option<String>,
    pub created: Option<String>,
    pub last_seen: Option<String>,
    /// Holding a connection to the control server now.
    pub connected: bool,
    pub blocks_incoming: bool,
    pub ssh_enabled: bool,
    /// Several machines share one node key: usually copied state.
    pub multiple_connections: bool,
    pub advertised_routes: Vec<String>,
    pub enabled_routes: Vec<String>,
    pub tailnet_lock_error: Option<String>,
}

/// A Tailscale device object, or `None` when it names no device.
#[must_use]
pub fn device(raw: &Value) -> Option<DeviceView> {
    let node_id = text(raw.get("nodeId"));
    let id = if node_id.is_empty() {
        text(raw.get("id"))
    } else {
        node_id
    };
    if crate::validate::id(&id).is_err() {
        return None;
    }
    let lock_error = text(raw.get("tailnetLockError"));
    Some(DeviceView {
        id,
        name: text(raw.get("name")),
        hostname: text(raw.get("hostname")),
        os: text(raw.get("os")),
        client_version: text(raw.get("clientVersion")),
        update_available: flag(raw.get("updateAvailable")),
        user: text(raw.get("user")),
        addresses: list(raw.get("addresses")),
        tags: list(raw.get("tags")),
        authorized: flag(raw.get("authorized")),
        external: flag(raw.get("isExternal")),
        ephemeral: flag(raw.get("isEphemeral")),
        key_expiry_disabled: flag(raw.get("keyExpiryDisabled")),
        expires: time(raw.get("expires")),
        created: time(raw.get("created")),
        last_seen: time(raw.get("lastSeen")),
        connected: flag(raw.get("connectedToControl")),
        blocks_incoming: flag(raw.get("blocksIncomingConnections")),
        ssh_enabled: flag(raw.get("sshEnabled")),
        multiple_connections: flag(raw.get("multipleConnections")),
        advertised_routes: list(raw.get("advertisedRoutes")),
        enabled_routes: list(raw.get("enabledRoutes")),
        tailnet_lock_error: (!lock_error.is_empty()).then_some(lock_error),
    })
}

/// `{"devices":[…]}`, keeping every entry that names a device.
#[must_use]
pub fn devices(raw: &Value) -> Vec<DeviceView> {
    raw.get("devices")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(device).collect())
        .unwrap_or_default()
}

/// A device's routes after a change.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RoutesView {
    pub advertised_routes: Vec<String>,
    pub enabled_routes: Vec<String>,
}

#[must_use]
pub fn routes(raw: &Value) -> RoutesView {
    RoutesView {
        advertised_routes: list(raw.get("advertisedRoutes")),
        enabled_routes: list(raw.get("enabledRoutes")),
    }
}

/// One auth key, as a page sees it: never its secret.
#[expect(
    clippy::struct_excessive_bools,
    reason = "a wire view of Tailscale's own per-key flags, one field each"
)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct KeyView {
    pub id: String,
    pub description: String,
    pub created: Option<String>,
    pub expires: Option<String>,
    pub revoked: Option<String>,
    pub invalid: bool,
    pub reusable: bool,
    pub ephemeral: bool,
    pub preauthorized: bool,
    pub tags: Vec<String>,
}

/// A Tailscale key object that is an auth key, or `None`.
#[must_use]
pub fn key(raw: &Value) -> Option<KeyView> {
    let id = text(raw.get("id"));
    let kind = text(raw.get("keyType"));
    if crate::validate::id(&id).is_err() || !(kind.is_empty() || kind == "auth") {
        return None;
    }
    let create = raw.pointer("/capabilities/devices/create");
    let field = |name: &str| create.and_then(|c| c.get(name));
    Some(KeyView {
        id,
        description: text(raw.get("description")),
        created: time(raw.get("created")),
        expires: time(raw.get("expires")),
        revoked: time(raw.get("revoked")),
        invalid: flag(raw.get("invalid")),
        reusable: flag(field("reusable")),
        ephemeral: flag(field("ephemeral")),
        preauthorized: flag(field("preauthorized")),
        tags: list(field("tags")),
    })
}

/// The auth key ids a list names, for the keys Tailscale sent bare.
#[must_use]
pub fn key_ids(raw: &Value) -> Vec<(String, Option<KeyView>)> {
    raw.get("keys")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .take(MAX_LIST)
                .filter_map(|item| {
                    let id = text(item.get("id"));
                    crate::validate::id(&id).ok()?;
                    let described = item.get("capabilities").is_some();
                    let kind = text(item.get("keyType"));
                    (kind.is_empty() || kind == "auth")
                        .then(|| (id, described.then(|| key(item)).flatten()))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The one response that carries a key's secret: what `POST /keys` returns.
#[must_use]
pub fn created_key(raw: &Value) -> Option<Value> {
    let view = key(raw)?;
    let secret = raw.get("key").and_then(Value::as_str)?;
    if !secret.starts_with("tskey-auth-") || secret.len() > MAX_TEXT {
        return None;
    }
    let mut out = serde_json::to_value(view).ok()?;
    out.as_object_mut()?
        .insert("key".into(), Value::String(secret.to_string()));
    Some(out)
}

/// Tailscale's body for `POST /tailnet/{tailnet}/keys`.
#[must_use]
pub fn create_key_body(request: &KeyRequest) -> Value {
    let mut create = Map::new();
    create.insert("reusable".into(), request.reusable.into());
    create.insert("ephemeral".into(), request.ephemeral.into());
    create.insert("preauthorized".into(), request.preauthorized.into());
    if !request.tags.is_empty() {
        create.insert("tags".into(), request.tags.clone().into());
    }
    let mut body = json!({
        "keyType": "auth",
        "capabilities": { "devices": { "create": create } },
        "expirySeconds": request.expiry_seconds,
    });
    if !request.description.is_empty() {
        body["description"] = request.description.clone().into();
    }
    body
}

/// The message Tailscale put in an error body, if any.
#[must_use]
pub fn error_message(raw: &Value) -> String {
    text(raw.get("message"))
}

#[cfg(test)]
#[path = "wire_tests.rs"]
mod tests;
