//! Serving Bitwarden's web vault (ADR 0148 §7) from a directory the operator
//! supplies — a build of `bitwarden/clients`' web app, such as vaultwarden's
//! `bw_web_builds`. The Host ships none; with no directory configured this
//! surface serves only the API.
//!
//! The web vault is a single-page app: a path with no file answers with its
//! `index.html`. The API's own paths never do — an unknown `/api` or
//! `/identity` route stays a 404 — and every page carries headers that keep
//! it out of frames and pin where it may load from and connect to.

use std::path::PathBuf;

use axum::http::header::{
    HeaderName, HeaderValue, CONTENT_SECURITY_POLICY, REFERRER_POLICY, X_CONTENT_TYPE_OPTIONS,
    X_FRAME_OPTIONS,
};
use axum::Router;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

use crate::BitwardenServer;

/// Where the web vault may load from and connect to: itself, plus the
/// k-anonymity password check it offers.
const CSP: &str = "default-src 'self'; base-uri 'self'; form-action 'self'; \
     object-src 'self' blob:; script-src 'self' 'wasm-unsafe-eval'; \
     style-src 'self' 'unsafe-inline'; img-src 'self' data:; \
     connect-src 'self' https://api.pwnedpasswords.com; worker-src 'self' blob:; \
     frame-ancestors 'self'";

fn header(name: HeaderName, value: &'static str) -> SetResponseHeaderLayer<HeaderValue> {
    SetResponseHeaderLayer::overriding(name, HeaderValue::from_static(value))
}

/// `router`, with the web vault in `dir` behind every path it does not
/// route itself.
pub(super) fn with_web_vault(
    router: Router<BitwardenServer>,
    dir: Option<PathBuf>,
) -> Router<BitwardenServer> {
    let Some(dir) = dir else {
        return router;
    };
    let pages = ServeDir::new(&dir)
        .append_index_html_on_directories(true)
        .fallback(ServeFile::new(dir.join("index.html")));
    let pages = tower::ServiceBuilder::new()
        .layer(header(CONTENT_SECURITY_POLICY, CSP))
        .layer(header(X_FRAME_OPTIONS, "SAMEORIGIN"))
        .layer(header(X_CONTENT_TYPE_OPTIONS, "nosniff"))
        .layer(header(REFERRER_POLICY, "same-origin"))
        .service(pages);
    router.fallback_service(pages)
}
