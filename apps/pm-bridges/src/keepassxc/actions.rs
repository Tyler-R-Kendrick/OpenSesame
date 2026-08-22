//! The keepassxc-protocol action handlers and the session that owns them.
//!
//! [`Session::handle`] is total: every input, however malformed, produces a
//! protocol-shaped response. It never panics and never propagates an error to
//! the transport, because a transport that has to interpret errors is a
//! transport that will leak them into the wrong shape.
//!
//! # Authorization, per action
//!
//! | action | needs a key exchange | needs an association |
//! |---|---|---|
//! | `change-public-keys` | no (it *is* the exchange) | no |
//! | `get-databasehash` | yes | no |
//! | `associate` | yes | no — it *creates* one, behind the pairing window |
//! | `test-associate` | yes | proves one |
//! | everything else | yes | **yes** |
//!
//! That last row is stricter than KeePassXC, which lets an unassociated
//! client generate a password. Constitution C2(b) wants every caller identity
//! to have passed a human approval once, so the bridge draws the line there.

use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::keepassxc::crypto::{HostKeys, SessionBox};
use crate::keepassxc::pairing::{self, Approval};
use crate::keepassxc::proto::{
    error_reply, increment_nonce_b64, parse_envelope, Envelope, ErrorCode, PROTOCOL_VERSION,
};
use crate::pairing::{Association, PairingWindow};
use crate::store::{entry_uuid, host_of, StoreAccess, StoreMatch};
use crate::{now_unix, BridgeError};
use opensesame_sealed_store::{generate_password, Entry};

/// Group the bridge files entries created by `set-login` under.
pub const DEFAULT_GROUP: &str = "keepassxc-browser";

/// Length of a `generate-password` result.
pub const GENERATED_PASSWORD_LEN: usize = 24;

/// Knobs a transport supplies when building a [`Session`].
pub struct SessionConfig {
    /// The shared pairing-window file.
    pub window: PairingWindow,
    /// Injected so tests drive the approval loop without real time passing.
    pub sleep: fn(Duration),
    /// Ephemeral host keypair; generated fresh per process in production.
    pub host_keys: HostKeys,
}

impl SessionConfig {
    pub fn new(window: PairingWindow) -> Self {
        Self {
            window,
            sleep: std::thread::sleep,
            host_keys: HostKeys::generate(),
        }
    }
}

/// One connected client, keyed by its `clientID`.
struct ClientState {
    /// The client's ephemeral public key, as sent in `change-public-keys`.
    client_public_b64: String,
    session: SessionBox,
    /// Set once the client proves (or completes) an association.
    associated: Option<Association>,
}

/// The protocol server core: transport-agnostic, one per process.
pub struct Session {
    store: StoreAccess,
    config: SessionConfig,
    clients: BTreeMap<String, ClientState>,
}

impl Session {
    pub fn new(store: StoreAccess, config: SessionConfig) -> Self {
        Self {
            store,
            config,
            clients: BTreeMap::new(),
        }
    }

    /// The host's public key, for tests and diagnostics.
    pub fn host_public_b64(&self) -> String {
        self.config.host_keys.public_b64()
    }

    /// Handle one raw envelope, returning the response to send back.
    pub fn handle(&mut self, raw: &[u8]) -> Value {
        let envelope = match parse_envelope(raw) {
            Ok(envelope) => envelope,
            Err(_) => return error_reply("", ErrorCode::CannotDecryptMessage, None),
        };
        if envelope.action.is_empty() {
            return error_reply("", ErrorCode::IncorrectAction, None);
        }
        if envelope.action == "change-public-keys" {
            return self.change_public_keys(&envelope);
        }
        self.encrypted(&envelope)
    }

    // ——— unencrypted ————————————————————————————————————————————————

    fn change_public_keys(&mut self, envelope: &Envelope) -> Value {
        let (Some(client_public), Some(nonce), Some(client_id)) = (
            envelope.public_key.as_deref(),
            envelope.nonce.as_deref(),
            envelope.client_id.as_deref(),
        ) else {
            return error_reply(&envelope.action, ErrorCode::KeyChangeFailed, None);
        };
        let Ok(session) = self.config.host_keys.box_with(client_public) else {
            return error_reply(&envelope.action, ErrorCode::KeyChangeFailed, None);
        };
        let Ok(reply_nonce) = increment_nonce_b64(nonce) else {
            return error_reply(&envelope.action, ErrorCode::KeyChangeFailed, None);
        };
        // A repeat exchange replaces the session box but keeps nothing from
        // the old one: a new browser session must re-prove its association.
        self.clients.insert(
            client_id.to_string(),
            ClientState {
                client_public_b64: client_public.to_string(),
                session,
                associated: None,
            },
        );
        json!({
            "action": "change-public-keys",
            "version": PROTOCOL_VERSION,
            "publicKey": self.config.host_keys.public_b64(),
            "success": "true",
            "nonce": reply_nonce,
            "clientID": client_id,
        })
    }

    // ——— encrypted ——————————————————————————————————————————————————

    fn encrypted(&mut self, envelope: &Envelope) -> Value {
        let action = envelope.action.clone();
        let (Some(nonce), Some(client_id)) =
            (envelope.nonce.as_deref(), envelope.client_id.as_deref())
        else {
            return error_reply(&action, ErrorCode::CannotDecryptMessage, None);
        };
        if !self.clients.contains_key(client_id) {
            return error_reply(&action, ErrorCode::ClientPublicKeyNotReceived, None);
        }
        let Ok(reply_nonce) = increment_nonce_b64(nonce) else {
            return error_reply(&action, ErrorCode::CannotDecryptMessage, None);
        };

        // Decrypt the inner message, if this action carries one.
        let inner = match envelope.message.as_deref() {
            None => Value::Object(Map::new()),
            Some(message) => {
                let client = &self.clients[client_id];
                let Ok(plaintext) = client.session.open(message, nonce) else {
                    return error_reply(&action, ErrorCode::CannotDecryptMessage, None);
                };
                if plaintext.is_empty() {
                    return error_reply(&action, ErrorCode::EmptyMessageReceived, None);
                }
                match serde_json::from_slice::<Value>(&plaintext) {
                    Ok(value) if value.is_object() => value,
                    _ => return error_reply(&action, ErrorCode::CannotDecryptMessage, None),
                }
            }
        };

        let outcome = self.dispatch(&action, client_id, &inner);
        match outcome {
            Err(code) => error_reply(&action, code, None),
            Ok(mut body) => {
                if let Some(object) = body.as_object_mut() {
                    object.insert("nonce".into(), Value::String(reply_nonce.clone()));
                }
                let Ok(bytes) = serde_json::to_vec(&body) else {
                    return error_reply(&action, ErrorCode::CannotDecryptMessage, None);
                };
                let client = &self.clients[client_id];
                let Ok(sealed) = client.session.seal(&bytes, &reply_nonce) else {
                    return error_reply(&action, ErrorCode::CannotDecryptMessage, None);
                };
                json!({
                    "action": action,
                    "message": sealed,
                    "nonce": reply_nonce,
                    "clientID": client_id,
                })
            }
        }
    }

    /// Route one decrypted action. `Err(code)` becomes an unencrypted error
    /// reply; `Ok(body)` is sealed under the incremented nonce.
    fn dispatch(
        &mut self,
        action: &str,
        client_id: &str,
        inner: &Value,
    ) -> Result<Value, ErrorCode> {
        match action {
            "get-databasehash" => Ok(json!({
                "action": "hash",
                "hash": self.store.database_hash(),
                "version": PROTOCOL_VERSION,
                "success": "true",
            })),
            "associate" => self.associate(client_id, inner),
            "test-associate" => self.test_associate(client_id, inner),
            "get-logins" => self.get_logins(client_id, inner),
            "set-login" => self.set_login(client_id, inner),
            "get-totp" => self.get_totp(client_id, inner),
            "generate-password" => {
                self.require_association(client_id, inner)?;
                Ok(json!({
                    "version": PROTOCOL_VERSION,
                    "password": generate_password(GENERATED_PASSWORD_LEN, true),
                    "success": "true",
                }))
            }
            "lock-database" => {
                self.require_association(client_id, inner)?;
                self.store.lock();
                // The protocol documents the successful reply to
                // `lock-database` as the "database not opened" error — the
                // database really is closed by the time the answer is sent.
                Ok(json!({
                    "action": "lock-database",
                    "errorCode": ErrorCode::DatabaseNotOpened.code(),
                    "error": ErrorCode::DatabaseNotOpened.message(),
                }))
            }
            "get-database-groups" => {
                self.require_association(client_id, inner)?;
                self.database_groups()
            }
            // Passkeys live in the Pages OPFS vault, not the sealed store, so
            // there is nothing here to serve. Answering "incorrect action"
            // is the protocol's own way of saying unsupported; the extension
            // falls back to the platform authenticator.
            "passkeys-get" | "passkeys-register" => Err(ErrorCode::IncorrectAction),
            _ => Err(ErrorCode::IncorrectAction),
        }
    }

    // ——— association ————————————————————————————————————————————————

    fn associate(&mut self, client_id: &str, inner: &Value) -> Result<Value, ErrorCode> {
        let key = string_field(inner, "key").ok_or(ErrorCode::AssociationFailed)?;
        let id_key = string_field(inner, "idKey").ok_or(ErrorCode::AssociationFailed)?;

        // The `key` the client echoes must be the session key it exchanged;
        // otherwise a third party could try to associate someone else's key.
        if self.clients[client_id].client_public_b64 != key {
            return Err(ErrorCode::AssociationFailed);
        }

        let approval = pairing::request_approval(
            &self.config.window,
            &id_key,
            "keepassxc-browser",
            self.config.sleep,
        )
        .map_err(|_| ErrorCode::ActionCancelledOrDenied)?;

        let Approval::Granted { name } = approval else {
            let _ = self.config.window.close();
            return Err(ErrorCode::ActionCancelledOrDenied);
        };
        let association =
            pairing::persist_association(&name, &id_key).map_err(|_| ErrorCode::AssociationFailed)?;
        let _ = self.config.window.close();

        let id = association.id.clone();
        if let Some(client) = self.clients.get_mut(client_id) {
            client.associated = Some(association);
        }
        Ok(json!({
            "hash": self.store.database_hash(),
            "version": PROTOCOL_VERSION,
            "success": "true",
            "id": id,
        }))
    }

    fn test_associate(&mut self, client_id: &str, inner: &Value) -> Result<Value, ErrorCode> {
        let id = string_field(inner, "id").ok_or(ErrorCode::AssociationFailed)?;
        let key = string_field(inner, "key").ok_or(ErrorCode::AssociationFailed)?;
        let association = pairing::verify(&id, &key)
            .map_err(|_| ErrorCode::AssociationFailed)?
            .ok_or(ErrorCode::AssociationFailed)?;
        if let Some(client) = self.clients.get_mut(client_id) {
            client.associated = Some(association.clone());
        }
        Ok(json!({
            "version": PROTOCOL_VERSION,
            "hash": self.store.database_hash(),
            "id": association.id,
            "success": "true",
        }))
    }

    /// Every post-handshake action passes through here.
    ///
    /// A client counts as authorized if it proved an association earlier in
    /// this session, or if the request itself carries a `keys` array naming a
    /// stored one (the shape `get-logins` uses).
    fn require_association(
        &mut self,
        client_id: &str,
        inner: &Value,
    ) -> Result<Association, ErrorCode> {
        if let Some(association) = self.clients[client_id].associated.clone() {
            return Ok(association);
        }
        let keys = key_pairs(inner);
        if keys.is_empty() {
            return Err(ErrorCode::AssociationFailed);
        }
        let association = pairing::verify_any(&keys)
            .map_err(|_| ErrorCode::AssociationFailed)?
            .ok_or(ErrorCode::EncryptionKeyUnrecognized)?;
        if let Some(client) = self.clients.get_mut(client_id) {
            client.associated = Some(association.clone());
        }
        Ok(association)
    }

    // ——— store actions ——————————————————————————————————————————————

    fn get_logins(&mut self, client_id: &str, inner: &Value) -> Result<Value, ErrorCode> {
        self.require_association(client_id, inner)?;
        let url = string_field(inner, "url").ok_or(ErrorCode::NoUrlProvided)?;
        if url.trim().is_empty() {
            return Err(ErrorCode::NoUrlProvided);
        }
        let matches = self.store.find_by_url(&url).map_err(store_error_code)?;
        if matches.is_empty() {
            return Err(ErrorCode::NoLoginsFound);
        }
        let entries: Vec<Value> = matches.iter().map(login_entry).collect();
        Ok(json!({
            "count": entries.len().to_string(),
            "entries": entries,
            "hash": self.store.database_hash(),
            "version": PROTOCOL_VERSION,
            "success": "true",
        }))
    }

    fn set_login(&mut self, client_id: &str, inner: &Value) -> Result<Value, ErrorCode> {
        self.require_association(client_id, inner)?;
        let password = string_field(inner, "password").ok_or(ErrorCode::NoLoginsFound)?;
        let login = string_field(inner, "login").unwrap_or_default();
        let url = string_field(inner, "url").unwrap_or_default();

        // An existing entry is updated in place, preserving its trailer; a
        // new one is filed under the bridge's own group so a human can see
        // at a glance what the browser created.
        let existing = string_field(inner, "uuid")
            .and_then(|uuid| self.resolve_uuid(&uuid))
            .filter(|name| !name.is_empty());

        let name = match existing {
            Some(name) => name,
            None => {
                let host = host_of(&url).ok_or(ErrorCode::NoUrlProvided)?;
                let leaf = if login.trim().is_empty() {
                    host.clone()
                } else {
                    sanitize_segment(&login)
                };
                format!("{DEFAULT_GROUP}/{}/{leaf}", sanitize_segment(&host))
            }
        };

        let previous = self.store.show(&name).ok();
        let trailer = merged_trailer(previous.as_ref(), &login, &url);
        let entry = Entry {
            secret: password,
            trailer,
            otp: previous.and_then(|p| p.otp),
        };
        self.store.put(&name, &entry).map_err(store_error_code)?;

        Ok(json!({
            "count": Value::Null,
            "entries": Value::Null,
            "error": "",
            "hash": self.store.database_hash(),
            "version": PROTOCOL_VERSION,
            "success": "true",
        }))
    }

    fn get_totp(&mut self, client_id: &str, inner: &Value) -> Result<Value, ErrorCode> {
        self.require_association(client_id, inner)?;
        let uuid = string_field(inner, "uuid").ok_or(ErrorCode::NoValidUuidProvided)?;
        let name = self.resolve_uuid(&uuid).ok_or(ErrorCode::NoValidUuidProvided)?;
        let code = self
            .store
            .totp(&name, now_unix())
            .map_err(|_| ErrorCode::NoLoginsFound)?;
        Ok(json!({
            "totp": code,
            "version": PROTOCOL_VERSION,
            "success": "true",
        }))
    }

    /// Minimal group tree: one root, one child per top-level store prefix.
    fn database_groups(&mut self) -> Result<Value, ErrorCode> {
        let names = self.store.list("").map_err(store_error_code)?;
        let mut tops: Vec<String> = names
            .iter()
            .filter_map(|name| name.split('/').next().map(str::to_string))
            .filter(|top| !top.is_empty())
            .collect();
        tops.sort();
        tops.dedup();
        if tops.is_empty() {
            return Err(ErrorCode::NoGroupsFound);
        }
        let children: Vec<Value> = tops
            .iter()
            .map(|top| {
                json!({
                    "name": top,
                    "uuid": entry_uuid(top),
                    "children": Vec::<Value>::new(),
                })
            })
            .collect();
        Ok(json!({
            "defaultGroup": DEFAULT_GROUP,
            "defaultGroupAlwaysAllow": false,
            "groups": [{
                "name": "OpenSesame",
                "uuid": entry_uuid(""),
                "children": children,
            }],
            "version": PROTOCOL_VERSION,
            "success": "true",
        }))
    }

    /// Map a protocol uuid back to a logical entry name.
    ///
    /// Entry ids are a pure function of the path (`store::entry_uuid`), so
    /// this is a listing scan and never decrypts anything.
    fn resolve_uuid(&self, uuid: &str) -> Option<String> {
        let names = self.store.list("").ok()?;
        names.into_iter().find(|name| entry_uuid(name) == uuid)
    }
}

fn login_entry(matched: &StoreMatch) -> Value {
    json!({
        "login": matched.login(),
        "name": matched.name,
        "password": matched.entry.secret,
        "uuid": entry_uuid(&matched.name),
        "group": matched.name.rsplit_once('/').map(|(g, _)| g).unwrap_or(""),
        "stringFields": Vec::<Value>::new(),
    })
}

/// Rebuild an entry's trailer around a browser-supplied login and url,
/// preserving every other field the human had put there.
fn merged_trailer(previous: Option<&Entry>, login: &str, url: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    if let Some(previous) = previous {
        for line in previous.trailer.lines() {
            let key = line
                .split_once(':')
                .map(|(k, _)| k.trim().to_ascii_lowercase())
                .unwrap_or_default();
            if matches!(key.as_str(), "login" | "username" | "user" | "url") {
                continue;
            }
            lines.push(line.to_string());
        }
    }
    let mut out = String::new();
    if !login.trim().is_empty() {
        out.push_str(&format!("login: {}\n", login.trim()));
    }
    if !url.trim().is_empty() {
        out.push_str(&format!("url: {}\n", url.trim()));
    }
    for line in lines {
        out.push_str(&line);
        out.push('\n');
    }
    out
}

/// Make a store path segment out of arbitrary client-supplied text.
fn sanitize_segment(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':') {
                '-'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches(['-', '.', ' ']).to_string();
    if cleaned.is_empty() {
        "unnamed".to_string()
    } else {
        cleaned
    }
}

fn store_error_code(error: BridgeError) -> ErrorCode {
    match error {
        BridgeError::Locked => ErrorCode::DatabaseNotOpened,
        BridgeError::Protocol(_) => ErrorCode::NoUrlProvided,
        _ => ErrorCode::NoLoginsFound,
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

/// Extract the `keys: [{id, key}]` array a request may carry.
fn key_pairs(value: &Value) -> Vec<(String, String)> {
    value
        .get("keys")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| Some((string_field(item, "id")?, string_field(item, "key")?)))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_segment_neutralizes_path_tricks() {
        assert_eq!(sanitize_segment("../../etc/passwd"), "etc-passwd");
        assert_eq!(sanitize_segment("a/b"), "a-b");
        assert_eq!(sanitize_segment("  "), "unnamed");
        assert_eq!(sanitize_segment("///"), "unnamed");
        assert_eq!(sanitize_segment("alice"), "alice");
        assert_eq!(sanitize_segment("C:\\x"), "C-x");
    }

    #[test]
    fn merged_trailer_replaces_login_and_url_but_keeps_the_rest() {
        let previous = Entry {
            secret: "old".into(),
            trailer: "login: old\nurl: https://old\nnotes: keep me\notpauth://totp/x\n".into(),
            otp: None,
        };
        let trailer = merged_trailer(Some(&previous), "new", "https://new");
        assert!(trailer.starts_with("login: new\nurl: https://new\n"));
        assert!(trailer.contains("notes: keep me"));
        assert!(trailer.contains("otpauth://totp/x"));
        assert!(!trailer.contains("https://old"));
    }

    #[test]
    fn merged_trailer_omits_empty_fields() {
        assert_eq!(merged_trailer(None, "", ""), "");
        assert_eq!(merged_trailer(None, "a", ""), "login: a\n");
        assert_eq!(merged_trailer(None, "", "u"), "url: u\n");
    }

    #[test]
    fn key_pairs_reads_the_keys_array_defensively() {
        let value = json!({"keys": [{"id": "a", "key": "k"}, {"id": "b"}, 3]});
        assert_eq!(key_pairs(&value), vec![("a".to_string(), "k".to_string())]);
        assert!(key_pairs(&json!({})).is_empty());
        assert!(key_pairs(&json!({"keys": "not an array"})).is_empty());
    }

    #[test]
    fn store_errors_map_to_protocol_codes() {
        assert_eq!(
            store_error_code(BridgeError::Locked),
            ErrorCode::DatabaseNotOpened
        );
        assert_eq!(
            store_error_code(BridgeError::Protocol("no host".into())),
            ErrorCode::NoUrlProvided
        );
        assert_eq!(
            store_error_code(BridgeError::NotFound),
            ErrorCode::NoLoginsFound
        );
    }

    #[test]
    fn login_entry_carries_no_field_beyond_the_protocol_shape() {
        let matched = StoreMatch {
            name: "Web/example.com".into(),
            entry: Entry {
                secret: "s".into(),
                trailer: "login: alice\n".into(),
                otp: None,
            },
        };
        let value = login_entry(&matched);
        let mut keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort();
        assert_eq!(
            keys,
            vec!["group", "login", "name", "password", "stringFields", "uuid"]
        );
        assert_eq!(value["login"], "alice");
        assert_eq!(value["group"], "Web");
    }
}
