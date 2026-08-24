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

use opensesame_pm_bridges::framing::{self, ReadOutcome};
use opensesame_pm_bridges::store::{host_of, name_matches, trailer_value, StoreAccess, StoreMatch};
use opensesame_pm_bridges::{now_unix, BridgeError};
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

fn main() {
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

/// `queryHost` walks the host leftwards, dropping one label at a time until
/// something matches or only the public suffix would be left. With no public
/// suffix list on hand, the floor is two labels — `example.com` still gets
/// queried, a bare `com` never does.
fn query_host(host: &str) -> Result<Value, BridgeError> {
    let store = store()?;
    let Some(host) = host_of(host) else {
        return Ok(Value::Array(Vec::new()));
    };
    let names = store.list("")?;
    let mut labels: Vec<&str> = host.split('.').filter(|l| !l.is_empty()).collect();
    while labels.len() >= 2 || (labels.len() == 1 && !host.contains('.')) {
        let candidate = labels.join(".");
        let hits: Vec<Value> = names
            .iter()
            .filter(|name| name_matches(name, &candidate))
            .cloned()
            .map(Value::String)
            .collect();
        if !hits.is_empty() {
            return Ok(Value::Array(hits));
        }
        if labels.len() == 1 {
            break;
        }
        labels.remove(0);
    }
    Ok(Value::Array(Vec::new()))
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
