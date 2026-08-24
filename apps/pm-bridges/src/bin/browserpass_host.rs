//! `opensesame-browserpass-host` — a **browserpass-native compatible** stdio
//! host backed by the `OpenSesame` sealed store.
//!
//! The stock [browserpass extension] speaks a small JSON protocol over
//! Chrome/Firefox native messaging: `configure`, `list`, `fetch`, `echo`,
//! plus write verbs this bridge deliberately does not implement. This binary
//! answers that protocol from a sealed store instead of a directory of
//! `.gpg` files, so the extension works unmodified.
//!
//! [browserpass extension]: https://github.com/browserpass/browserpass-extension
//!
//! **Clean room (C3).** browserpass-native is ISC-licensed and was read as a
//! *specification of the wire format only* — the request/response field
//! names, the little-endian framing, and the numeric error codes. No code was
//! copied; the store layer, error handling, and control flow here are
//! `OpenSesame`'s.
//!
//! **Plane (C2).** stdio only: the caller is whatever process the browser
//! `exec`ed this binary from, in the user's own session. It becomes reachable
//! only after a human ran `opensesame bridge install browserpass --browser …`,
//! which writes the manifest naming the exact extension ids allowed to launch
//! it. There is no listener, no loopback port, and no agent-plane path here.
//!
//! **Mapping.** Sealed-store logical names are presented with a `.gpg` suffix
//! because the extension filters on that extension and strips it for display;
//! `fetch` reverses the mapping. Entry text is rendered in `pass` format
//! (secret on line 1, `key: value` trailer), which is exactly what the
//! extension's parser expects.

use std::io::{self, Write};
use std::path::{Path, PathBuf};

use opensesame_pm_bridges::framing::{self, ReadOutcome};
use opensesame_pm_bridges::store::{resolve_root, StoreAccess, ENV_STORE_PASSWORD};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// Protocol version reported to the extension.
///
/// The extension compares this against its own minimum supported host
/// version, so it must be a browserpass-native version code
/// (`major*1_000_000 + minor*1_000 + patch`), not an `OpenSesame` version.
const PROTOCOL_VERSION: u32 = 3_001_002;

// browserpass-native error codes (stable by contract: the extension maps them
// to user-facing messages, and the host exits with them).
const CODE_PARSE_REQUEST: u32 = 11;
const CODE_INVALID_REQUEST_ACTION: u32 = 12;
const CODE_INACCESSIBLE_PASSWORD_STORE: u32 = 13;
const CODE_INACCESSIBLE_DEFAULT_PASSWORD_STORE: u32 = 14;
const CODE_UNABLE_TO_LIST_FILES: u32 = 18;
const CODE_INVALID_PASSWORD_STORE: u32 = 20;
const CODE_INVALID_PASSWORD_FILE_EXTENSION: u32 = 23;
const CODE_UNABLE_TO_DECRYPT_PASSWORD_FILE: u32 = 24;

#[derive(Debug, Default, Deserialize)]
struct StoreSpec {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    path: String,
}

#[derive(Debug, Default, Deserialize)]
struct Settings {
    #[serde(default)]
    stores: std::collections::BTreeMap<String, StoreSpec>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct Request {
    action: String,
    settings: Settings,
    file: String,
    #[serde(rename = "storeId")]
    store_id: String,
    #[serde(rename = "echoResponse")]
    echo_response: Value,
}

#[derive(Debug, Serialize)]
struct OkResponse {
    status: &'static str,
    version: u32,
    data: Value,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    status: &'static str,
    code: u32,
    version: u32,
    params: Value,
}

/// A failure that must be reported to the extension and end the process.
struct Failure {
    code: u32,
    params: Value,
}

impl Failure {
    fn new(code: u32, action: &str, message: &str) -> Self {
        Self {
            code,
            params: json!({ "message": message, "action": action }),
        }
    }
}

fn main() {
    let mut stdin = io::stdin().lock();
    let mut stdout = io::stdout().lock();

    loop {
        let message = match framing::read_message(&mut stdin) {
            Ok(ReadOutcome::Eof) => return,
            Ok(ReadOutcome::Message(bytes)) => bytes,
            Err(error) => {
                // Nothing legible arrived; there is no request to answer.
                eprintln!("browserpass bridge: {error}");
                std::process::exit(process_exit_code(CODE_PARSE_REQUEST));
            }
        };

        let request: Request = match serde_json::from_slice(&message) {
            Ok(request) => request,
            Err(_) => fail(
                &mut stdout,
                Failure::new(
                    CODE_PARSE_REQUEST,
                    "",
                    "Unable to parse the browser request",
                ),
            ),
        };

        match dispatch(&request) {
            Ok(Some(data)) => send_ok(&mut stdout, data),
            // `echo` answers with the raw payload, not the ok envelope.
            Ok(None) => send_raw(&mut stdout, &request.echo_response),
            Err(failure) => fail(&mut stdout, failure),
        }
    }
}

/// `Ok(Some(data))` → wrap in the ok envelope; `Ok(None)` → raw echo.
fn dispatch(request: &Request) -> Result<Option<Value>, Failure> {
    match request.action.as_str() {
        "configure" => configure(request).map(Some),
        "list" => list(request).map(Some),
        "fetch" => fetch(request).map(Some),
        "echo" => Ok(None),
        other => Err(Failure {
            code: CODE_INVALID_REQUEST_ACTION,
            params: json!({ "message": "Invalid request action", "action": other }),
        }),
    }
}

fn passphrase() -> Option<String> {
    std::env::var(ENV_STORE_PASSWORD)
        .ok()
        .filter(|p| !p.is_empty())
}

fn open_store(path: &Path) -> Result<StoreAccess, opensesame_pm_bridges::BridgeError> {
    let passphrase = passphrase();
    StoreAccess::open(path, passphrase.as_deref().map(str::as_bytes))
}

fn configure(request: &Request) -> Result<Value, Failure> {
    let mut store_settings = Map::new();
    for (key, store) in &request.settings.stores {
        let path = PathBuf::from(&store.path);
        open_store(&path).map_err(|_| Failure {
            code: CODE_INACCESSIBLE_PASSWORD_STORE,
            params: json!({
                "message": "The password store is not accessible",
                "action": "configure",
                "storeId": store.id,
                "storeName": store.name,
                "storePath": store.path,
            }),
        })?;
        let id = if store.id.is_empty() { key } else { &store.id };
        store_settings.insert(id.clone(), Value::String(default_settings(&path)));
    }

    let mut data = json!({
        "defaultStore": { "path": "", "settings": "{}" },
        "storeSettings": Value::Object(store_settings),
    });

    // Only validate the default store when the user configured none of their
    // own — otherwise a missing `~/.password-store` is not an error.
    if request.settings.stores.is_empty() {
        let path = resolve_root(None);
        open_store(&path).map_err(|_| Failure {
            code: CODE_INACCESSIBLE_DEFAULT_PASSWORD_STORE,
            params: json!({
                "message": "The default password store is not accessible",
                "action": "configure",
                "storePath": path.to_string_lossy(),
            }),
        })?;
        data["defaultStore"]["path"] = Value::String(path.to_string_lossy().to_string());
        data["defaultStore"]["settings"] = Value::String(default_settings(&path));
    }
    Ok(data)
}

/// Per-store `.browserpass.json` overrides, verbatim; `{}` when absent.
fn default_settings(root: &Path) -> String {
    std::fs::read_to_string(root.join(".browserpass.json"))
        .ok()
        .filter(|s| serde_json::from_str::<Value>(s).is_ok())
        .unwrap_or_else(|| "{}".to_string())
}

fn list(request: &Request) -> Result<Value, Failure> {
    let mut files = Map::new();
    for (id, path) in stores(request) {
        let store = open_store(&path).map_err(|_| Failure {
            code: CODE_INACCESSIBLE_PASSWORD_STORE,
            params: json!({
                "message": "The password store is not accessible",
                "action": "list",
                "storeId": id,
                "storePath": path.to_string_lossy(),
            }),
        })?;
        let names = store.list("").map_err(|_| {
            Failure::new(
                CODE_UNABLE_TO_LIST_FILES,
                "list",
                "Unable to list the files in the password store",
            )
        })?;
        // The extension filters on `.gpg` and strips it for display; the
        // sealed store's own on-disk extension is an implementation detail.
        let listed: Vec<Value> = names
            .into_iter()
            .map(|name| Value::String(format!("{name}.gpg")))
            .collect();
        files.insert(id, Value::Array(listed));
    }
    Ok(json!({ "files": Value::Object(files) }))
}

fn fetch(request: &Request) -> Result<Value, Failure> {
    let Some(name) = request.file.strip_suffix(".gpg") else {
        return Err(Failure {
            code: CODE_INVALID_PASSWORD_FILE_EXTENSION,
            params: json!({
                "message": "The requested password file does not have the expected '.gpg' extension",
                "action": "fetch",
                "file": request.file,
            }),
        });
    };
    let (id, path) = stores(request)
        .into_iter()
        .find(|(id, _)| *id == request.store_id)
        .ok_or_else(|| Failure {
            code: CODE_INVALID_PASSWORD_STORE,
            params: json!({
                "message": "The password store is not present in the list of stores",
                "action": "fetch",
                "storeId": request.store_id,
            }),
        })?;

    let store = open_store(&path).map_err(|_| Failure {
        code: CODE_INACCESSIBLE_PASSWORD_STORE,
        params: json!({
            "message": "The password store is not accessible",
            "action": "fetch",
            "storeId": id,
            "storePath": path.to_string_lossy(),
        }),
    })?;

    // The failure params carry the *file* but never any decrypted bytes: an
    // error path must not become a side channel for entry contents.
    let entry = store.show(name).map_err(|_| Failure {
        code: CODE_UNABLE_TO_DECRYPT_PASSWORD_FILE,
        params: json!({
            "message": "Unable to decrypt the password file",
            "action": "fetch",
            "file": request.file,
        }),
    })?;
    Ok(json!({ "contents": entry.render() }))
}

/// Configured stores, or the resolved default when the extension sent none.
fn stores(request: &Request) -> Vec<(String, PathBuf)> {
    if request.settings.stores.is_empty() {
        return vec![(String::new(), resolve_root(None))];
    }
    request
        .settings
        .stores
        .iter()
        .map(|(key, store)| {
            let id = if store.id.is_empty() {
                key.clone()
            } else {
                store.id.clone()
            };
            (id, PathBuf::from(&store.path))
        })
        .collect()
}

fn send_ok(out: &mut impl Write, data: Value) {
    let _ = framing::write_json(
        out,
        &OkResponse {
            status: "ok",
            version: PROTOCOL_VERSION,
            data,
        },
    );
}

fn send_raw(out: &mut impl Write, value: &Value) {
    let _ = framing::write_json(out, value);
}

fn fail(out: &mut impl Write, failure: Failure) -> ! {
    let _ = framing::write_json(
        out,
        &ErrorResponse {
            status: "error",
            code: failure.code,
            version: PROTOCOL_VERSION,
            params: failure.params,
        },
    );
    let _ = out.flush();
    std::process::exit(process_exit_code(failure.code));
}

fn process_exit_code(code: u32) -> i32 {
    i32::try_from(code).unwrap_or(i32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_exit_code_preserves_protocol_codes_and_clamps_overflow() {
        assert_eq!(process_exit_code(CODE_PARSE_REQUEST), 11);
        assert_eq!(process_exit_code(i32::MAX as u32), i32::MAX);
        assert_eq!(process_exit_code(u32::MAX), i32::MAX);
    }
}
