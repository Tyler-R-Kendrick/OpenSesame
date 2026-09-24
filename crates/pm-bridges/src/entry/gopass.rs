//! `opensesame-gopass-jsonapi` — a **gopass-jsonapi compatible** stdio host
//! backed by the `OpenSesame` sealed store.
//!
//! The [gopassbridge] extension talks to `gopass-jsonapi` over Mozilla/Chrome
//! native messaging with the same 32-bit-LE framing browserpass uses, but a
//! different, flatter JSON vocabulary keyed on `type`: `query`, `queryHost`,
//! `getLogin`, `getData`, `create`. Responses are bare JSON values — an array
//! for the query verbs, an object for the rest — with `{"error": "…"}` as the
//! universal failure shape.
//!
//! [gopassbridge]: https://github.com/gopasspw/gopassbridge
//!
//! **Clean room (C3).** Implemented from gopass-jsonapi's published `api.md`.
//! No gopass source was copied.
//!
//! **Plane (C2).** Identical to the browserpass host: stdio, same local user
//! session, reachable only after `opensesame bridge install gopass --browser …`
//! wrote the manifest naming the gopassbridge extension id.
//!
//! **Login resolution** follows gopass's documented rule: the `login`,
//! `username`, or `user` trailer field, falling back to the last path segment.

use std::io::{self, Write};

use crate::framing::{self, ReadOutcome};
use crate::store::{
    host_of, name_fallback_admits, name_matches, trailer_value, StoreAccess, StoreMatch,
};
use crate::{now_unix, BridgeError};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct Request {
    #[serde(rename = "type")]
    kind: String,
    query: String,
    host: String,
    entry: String,
}

/// Serve native-messaging requests on stdin until the browser closes it.
pub fn main() {
    let mut stdin = io::stdin().lock();
    let mut stdout = io::stdout().lock();

    loop {
        let message = match framing::read_message(&mut stdin) {
            Ok(ReadOutcome::Eof) => return,
            Ok(ReadOutcome::Message(bytes)) => bytes,
            Err(error) => {
                eprintln!("gopass bridge: {error}");
                std::process::exit(1);
            }
        };
        let response = match serde_json::from_slice::<Request>(&message) {
            Ok(request) => dispatch(&request).unwrap_or_else(|error| error_value(&error)),
            Err(_) => error_value(&BridgeError::Protocol("malformed request".into())),
        };
        let _ = framing::write_json(&mut stdout, &response);
        let _ = stdout.flush();
    }
}

/// Failure shape from `api.md`: `{"error": "<message>"}`.
///
/// [`BridgeError`]'s `Display` is a failure *class* by construction — it
/// never interpolates entry contents — so it is safe to hand to the caller.
fn error_value(error: &BridgeError) -> Value {
    json!({ "error": error.to_string() })
}

fn dispatch(request: &Request) -> Result<Value, BridgeError> {
    match request.kind.as_str() {
        "query" => query(&request.query),
        "queryHost" => query_host(&request.host),
        "getLogin" => get_login(&request.entry),
        "getData" => get_data(&request.entry),
        other => Err(BridgeError::Protocol(format!("unsupported type '{other}'"))),
    }
}

fn store() -> Result<StoreAccess, BridgeError> {
    StoreAccess::from_env(None)
}

/// Substring match over logical names — gopass's own `query` semantics.
fn query(needle: &str) -> Result<Value, BridgeError> {
    let store = store()?;
    let needle = needle.trim().to_lowercase();
    let names: Vec<Value> = store
        .list("")?
        .into_iter()
        .filter(|name| needle.is_empty() || name.to_lowercase().contains(&needle))
        .map(Value::String)
        .collect();
    Ok(Value::Array(names))
}

/// `queryHost` answers with the entries whose path names the host itself or
/// one of its parents on a dot boundary (`Web/example.com` for
/// `login.example.com`), or a child of the host (`Web/login.example.com` for
/// `example.com`). An entry whose own `url:` trailer names another host is
/// never offered on its path name alone.
///
/// gopass-jsonapi walks the host leftwards, re-querying each shorter suffix.
/// That walk is deliberately absent: every parent it would reach is already a
/// match here, so the only thing a walk adds is the *children* of a walked
/// suffix — `attacker.github.io` climbing to `github.io` and collecting
/// `Web/victim.github.io`, or `attacker.co.uk` collecting `Web/bank.co.uk`.
/// With no public suffix list on hand, a child of anything above the queried
/// host is another tenant's credential, so children are only ever children of
/// the host that asked.
fn query_host(host: &str) -> Result<Value, BridgeError> {
    let store = store()?;
    let Some(host) = host_of(host) else {
        return Ok(Value::Array(Vec::new()));
    };
    let hits = store
        .list("")?
        .into_iter()
        .filter(|name| name_matches(name, &host))
        .filter(|name| {
            store
                .show(name)
                .is_ok_and(|entry| name_fallback_admits(&entry, &host))
        })
        .map(Value::String)
        .collect();
    Ok(Value::Array(hits))
}

fn get_login(entry: &str) -> Result<Value, BridgeError> {
    let store = store()?;
    let decrypted = store.show(entry)?;
    let matched = StoreMatch {
        name: entry.to_string(),
        entry: decrypted,
    };
    Ok(json!({
        "username": matched.login(),
        "password": matched.entry.secret,
    }))
}

/// `getData` returns the entry's non-credential extras. gopassbridge reads
/// `current_totp`; the remaining trailer fields are passed through so a
/// client can show them, minus the secret itself.
fn get_data(entry: &str) -> Result<Value, BridgeError> {
    let store = store()?;
    let decrypted = store.show(entry)?;
    let mut data = serde_json::Map::new();
    if let Some(otp) = decrypted.otp.as_ref() {
        let code = opensesame_sealed_store_totp(otp)?;
        data.insert("current_totp".into(), Value::String(code));
    }
    for key in ["login", "username", "user", "url", "notes"] {
        if let Some(value) = trailer_value(&decrypted.trailer, &[key]) {
            data.entry(key.to_string()).or_insert(Value::String(value));
        }
    }
    Ok(Value::Object(data))
}

fn opensesame_sealed_store_totp(
    otp: &opensesame_sealed_store::OtpUri,
) -> Result<String, BridgeError> {
    opensesame_sealed_store::totp_code(otp, now_unix())
        .map_err(|e| BridgeError::Store(e.to_string()))
}
