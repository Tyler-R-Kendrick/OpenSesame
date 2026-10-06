//! Fill by reference for the companion autofill extension (ADR 0150 §6.4),
//! `@opensesame/browser-extension-autofill` (`apps/browser-extension-autofill`).
//!
//! Autofill is the optional `browser-autofill` plugin (ADR 0150 §7,
//! `spec/plugins/catalog.json`). Until a person installs it and switches it
//! on, every route here answers exactly like a path the daemon never served
//! ([`gate`]); `apps/browser-extension` has no fill code and never calls one.
//!
//! The extension never holds a vault. When a person presses its keyboard
//! command or the fill key in its popup, it names an entry by *reference* (a
//! store path, `rotation-web`'s `FillCredential { reference, … }` without the
//! selector — the person's focus is the selector) and the origin of the page
//! it verified, and this module answers with **one field's value**, and only
//! when that entry declares exactly that origin. It never lists a value;
//! `/v1/fill/match` answers with entry names alone.
//!
//! # ADR 0052 §2: the three conditions, and how each is met
//!
//! This is a plaintext-yielding surface, so it must meet all three:
//!
//! - **(a) the caller is the same local user session.** Met by "loopback +
//!   user token": the request must address loopback (`Host`), carry an
//!   extension `Origin`, and present the pairing token the extension
//!   generated, whose digest was recorded for exactly that origin
//!   ([`caller`], [`pairing`]).
//! - **(b) each distinct caller needed one explicit human approval.** Met by
//!   the pairing ceremony: an extension's request produces a code shown in
//!   its own popup, and a person approves that code with the operator
//!   credential on a separate channel (`POST /v1/fill/pair/approve`, which
//!   refuses any request carrying an `Origin`, so no browser page and no
//!   extension can approve itself). One approval admits one extension origin.
//! - **(c) local IPC or loopback only, never remote, never the agent
//!   plane.** Met by refusing any `Host` that is not loopback and any
//!   forwarded request, by leaving these routes off the tailnet listener,
//!   and by the capability registry excluding fill from MCP and `WebMCP`
//!   (ADR 0150 §6.4): a model has no tool that returns a value.
//!
//! Every value-bearing route is rate limited per extension origin, refused
//! without an exact-origin match, and answers `Cache-Control: no-store`.
//! Values are never logged; entries are zeroized once the answer is built.

mod caller;
mod gate;
mod operator;
mod origin;
mod pairing;
mod produced;
mod source;

use crate::{
    ratelimit::{rate_limited, RateKey, TokenBucket},
    App,
};
use axum::{
    extract::DefaultBodyLimit,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, MethodRouter},
    Extension, Json, Router,
};
use caller::{extension_caller, refuse, Caller};
use gate::{PluginGate, SettingsGate};
use origin::{entry_matches, login_of, valid_reference, WebOrigin};
use pairing::{PairOutcome, Pairings};
use produced::{password_of, Filled};
use serde::Deserialize;
use serde_json::json;
use source::{EntrySource, SealedSource, SourceError};
use std::{path::PathBuf, sync::Arc};
use zeroize::{Zeroize, Zeroizing};

/// Largest request body: a reference, an origin and a field name.
const MAX_BODY_BYTES: usize = 4 * 1024;
/// Entries opened to answer one `match`; a larger store answers `truncated`.
pub(crate) const MAX_SCAN: usize = 2048;
/// Names returned by one `match`.
pub(crate) const MAX_REFERENCES: usize = 32;

/// Where paired extensions are recorded, overriding the state directory.
pub(crate) const ENV_FILL_STATE_DIR: &str = "OPENSESAME_FILL_STATE_DIR";

/// Which one field a fill returns.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Field {
    Password,
    Username,
}

impl Field {
    fn as_str(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::Username => "username",
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MatchReq {
    origin: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FillReq {
    reference: String,
    origin: String,
    field: Field,
}

/// The plugin switch, pairings, the store, and the two budgets.
pub(crate) struct FillState {
    gate: Arc<dyn PluginGate>,
    pairings: Pairings,
    source: Box<dyn EntrySource>,
    /// Value-bearing fills: four in a burst, then one every two seconds.
    fill_limiter: TokenBucket,
    /// Pairing requests and name lookups: ten, then one a second.
    lookup_limiter: TokenBucket,
}

/// `OPENSESAME_FILL_STATE_DIR`, else the daemon's usual state directory.
fn state_dir() -> Option<PathBuf> {
    let var = |name: &str| std::env::var_os(name).filter(|value| !value.is_empty());
    var(ENV_FILL_STATE_DIR)
        .map(PathBuf::from)
        .or_else(|| var("XDG_STATE_HOME").map(|dir| PathBuf::from(dir).join("opensesame")))
        .or_else(|| var("LOCALAPPDATA").map(|dir| PathBuf::from(dir).join("OpenSesame")))
        .or_else(|| var("HOME").map(|home| PathBuf::from(home).join(".local/state/opensesame")))
}

impl FillState {
    pub(crate) fn new(
        source: Box<dyn EntrySource>,
        pairing_dir: Option<&std::path::Path>,
        gate: Arc<dyn PluginGate>,
    ) -> Self {
        Self {
            gate,
            pairings: Pairings::load(pairing_dir),
            source,
            fill_limiter: TokenBucket::new(4.0, 0.5),
            lookup_limiter: TokenBucket::new(10.0, 1.0),
        }
    }

    /// The production state: the sealed store and the state directory.
    pub(crate) fn from_env() -> Arc<Self> {
        Arc::new(Self::new(
            Box::new(SealedSource::from_env()),
            state_dir().as_deref(),
            Arc::new(SettingsGate::from_env()),
        ))
    }

    /// Names of entries declaring exactly `origin`, and whether the scan
    /// stopped early.
    fn matches(&self, origin: &WebOrigin) -> Result<(Vec<String>, bool), SourceError> {
        let reader = self.source.open()?;
        let names = reader.names()?;
        let truncated = names.len() > MAX_SCAN;
        let mut found = Vec::new();
        for name in names.into_iter().take(MAX_SCAN) {
            let mut entry = match reader.read(&name) {
                Ok(entry) => entry,
                Err(SourceError::Locked) => return Err(SourceError::Locked),
                // One entry this reader cannot open does not hide the rest.
                Err(_) => continue,
            };
            let matched = entry_matches(&entry.trailer, origin);
            entry.secret.zeroize();
            entry.trailer.zeroize();
            if matched && found.len() < MAX_REFERENCES {
                found.push(name);
            }
        }
        Ok((found, truncated))
    }

    /// One field of `reference`, only if that entry declares `origin`.
    fn resolve(
        &self,
        reference: &str,
        origin: &WebOrigin,
        field: Field,
    ) -> Result<Filled, SourceError> {
        let reader = self.source.open()?;
        let mut entry = reader.read(reference)?;
        // A reference for another site answers exactly like one that does not
        // exist, so the route cannot be used to probe which names are stored.
        let filled = if entry_matches(&entry.trailer, origin) {
            match field {
                Field::Password => password_of(&entry),
                Field::Username => Ok(Filled {
                    value: Zeroizing::new(login_of(reference, &entry.trailer)),
                    pepper: false,
                }),
            }
        } else {
            Err(SourceError::Missing)
        };
        entry.secret.zeroize();
        entry.trailer.zeroize();
        filled
    }
}

/// The caller, with its token verified against the pairing it presented.
fn paired_caller(fill: &FillState, headers: &HeaderMap) -> Result<Caller, Response> {
    let caller = extension_caller(headers)?;
    if fill.pairings.verify(&caller.origin, &caller.token) {
        Ok(caller)
    } else {
        Err(refuse(StatusCode::UNAUTHORIZED, "not_paired"))
    }
}

fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// The one body that carries a value, serialized straight from the zeroizing
/// copy so no intermediate JSON tree holds a second one.
fn value_response(field: Field, filled: &Filled) -> Response {
    #[derive(serde::Serialize)]
    struct FillBody<'a> {
        field: &'static str,
        value: &'a str,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        pepper: bool,
    }
    match serde_json::to_vec(&FillBody {
        field: field.as_str(),
        value: &filled.value,
        pepper: filled.pepper,
    }) {
        Ok(body) => ([(header::CONTENT_TYPE, "application/json")], body).into_response(),
        Err(_) => refuse(StatusCode::INTERNAL_SERVER_ERROR, "store_failed"),
    }
}

fn store_refusal(error: &SourceError) -> Response {
    match error {
        SourceError::Missing => refuse(StatusCode::NOT_FOUND, "no_match"),
        SourceError::Locked => refuse(StatusCode::SERVICE_UNAVAILABLE, "store_locked"),
        SourceError::Legacy => refuse(StatusCode::CONFLICT, "legacy_password"),
        SourceError::Failed => refuse(StatusCode::INTERNAL_SERVER_ERROR, "store_failed"),
    }
}

/// `POST /v1/fill/pair`: open (or re-read) this extension's pairing request.
async fn pair(Extension(fill): Extension<Arc<FillState>>, headers: HeaderMap) -> Response {
    let caller = match extension_caller(&headers) {
        Ok(caller) => caller,
        Err(response) => return response,
    };
    // A caller that has not proved its token is only claiming an origin, and
    // any local process can claim any. It spends the shared unpaired bucket,
    // never the budget of the paired extension that origin names.
    let key = if fill.pairings.verify(&caller.origin, &caller.token) {
        RateKey::Extension(caller.origin.clone())
    } else {
        RateKey::UnpairedFill
    };
    if let Err(retry) = fill.lookup_limiter.check(key) {
        return rate_limited(retry);
    }
    match fill
        .pairings
        .request(&caller.origin, &caller.token, chrono::Utc::now())
    {
        PairOutcome::Paired => Json(json!({ "state": "paired" })).into_response(),
        PairOutcome::Pending { code, expires_at } => (
            StatusCode::ACCEPTED,
            Json(json!({ "state": "pending", "code": code, "expires_at": expires_at })),
        )
            .into_response(),
        PairOutcome::Full => refuse(StatusCode::TOO_MANY_REQUESTS, "too_many_pending"),
    }
}

/// `POST /v1/fill/match`: names of the entries declaring exactly `origin`.
async fn match_origin(
    Extension(fill): Extension<Arc<FillState>>,
    headers: HeaderMap,
    Json(req): Json<MatchReq>,
) -> Response {
    let caller = match paired_caller(&fill, &headers) {
        Ok(caller) => caller,
        Err(response) => return response,
    };
    if let Err(retry) = fill.lookup_limiter.check(RateKey::Extension(caller.origin)) {
        return rate_limited(retry);
    }
    let Some(origin) = WebOrigin::parse_request(&req.origin) else {
        return refuse(StatusCode::BAD_REQUEST, "invalid_origin");
    };
    let scan = Arc::clone(&fill);
    match tokio::task::spawn_blocking(move || scan.matches(&origin)).await {
        Ok(Ok((references, truncated))) => no_store(
            Json(json!({ "references": references, "truncated": truncated })).into_response(),
        ),
        Ok(Err(error)) => no_store(store_refusal(&error)),
        Err(_) => refuse(StatusCode::INTERNAL_SERVER_ERROR, "store_failed"),
    }
}

/// `POST /v1/fill`: one field of one entry, for exactly its own origin.
async fn fill_value(
    Extension(fill): Extension<Arc<FillState>>,
    headers: HeaderMap,
    Json(req): Json<FillReq>,
) -> Response {
    let caller = match paired_caller(&fill, &headers) {
        Ok(caller) => caller,
        Err(response) => return response,
    };
    if let Err(retry) = fill.fill_limiter.check(RateKey::Extension(caller.origin)) {
        return rate_limited(retry);
    }
    let Some(origin) = WebOrigin::parse_request(&req.origin) else {
        return refuse(StatusCode::BAD_REQUEST, "invalid_origin");
    };
    if !valid_reference(&req.reference) {
        return refuse(StatusCode::BAD_REQUEST, "invalid_reference");
    }
    let field = req.field;
    let lookup = Arc::clone(&fill);
    let reference = req.reference;
    let resolved =
        tokio::task::spawn_blocking(move || lookup.resolve(&reference, &origin, field)).await;
    match resolved {
        Ok(Ok(filled)) => no_store(value_response(field, &filled)),
        Ok(Err(error)) => no_store(store_refusal(&error)),
        Err(_) => refuse(StatusCode::INTERNAL_SERVER_ERROR, "store_failed"),
    }
}

/// The fill routes. The value-bearing ones speak only to a paired extension
/// on loopback; the pairing ceremony's approve, revoke and list speak only
/// to the operator.
///
/// All of them sit behind the `browser-autofill` plugin switch ([`gate`]).
/// Each path is mounted as a service (`route_service`) so the switch wraps
/// the whole method router, not each method inside it: a switched-off daemon
/// answers every method on every path here exactly as it answers a path it
/// never served — no `Allow` header, no body, nothing to probe.
pub(crate) fn routes(state: Arc<FillState>, app: &App) -> Router<App> {
    let switch = Arc::clone(&state.gate);
    let bound = |methods: MethodRouter<App>| methods.with_state::<()>(app.clone());
    Router::new()
        .route_service("/v1/fill", bound(post(fill_value)))
        .route_service("/v1/fill/match", bound(post(match_origin)))
        .route_service("/v1/fill/pair", bound(post(pair)))
        .route_service("/v1/fill/pair/approve", bound(post(operator::approve)))
        .route_service("/v1/fill/pair/revoke", bound(post(operator::revoke)))
        .route_service("/v1/fill/pairings", bound(get(operator::list)))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(Extension(state))
        .layer(axum::middleware::from_fn(move |request, next| {
            gate::require_active(Arc::clone(&switch), request, next)
        }))
}

#[cfg(test)]
mod auth_tests;
#[cfg(test)]
mod gate_tests;
#[cfg(test)]
mod sealed_tests;
#[cfg(test)]
mod tests;
