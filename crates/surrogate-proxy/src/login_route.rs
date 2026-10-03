//! A request inside a run's tunnel, read for its login surrogates.
//!
//! Login surrogates are looked for first, in every request, because nothing
//! else in the proxy knows them: the invoke-through ledger would read one as
//! a forgery. A request that carries one is put to its declaration and
//! nowhere else. A request to a declared login origin that carries none —
//! the login page itself, its assets, the page after sign-in — is forwarded
//! on with no credential of ours, and its response scrubbed like the
//! substituted one's, since the site may echo the credential on any page.
//!
//! A response is buffered whole under [`MAX_LOGIN_RESPONSE_BYTES`] before the
//! scrub reads it, and a body the scrub cannot read — any content coding but
//! identity — is refused rather than passed on unread. The request asks for
//! identity (`accept-encoding` is dropped), so an honest site obliges.

use bytes::Bytes;
use http::{HeaderMap, HeaderValue, StatusCode};
use http_body_util::{BodyExt, Limited};
use hyper::http::request::Parts;
use hyper::Response;
use opensesame_rotation_web::LoginRequest;

use crate::listener::RunContext;
use crate::login::{DeskEgress, LoginDesk, RunLogins};
use crate::passthrough::end_to_end;
use crate::respond::{self, ProxyBody};
use crate::target::Target;
use crate::tripwire::{login_event, LoginEvent, LoginOutcome};

/// The largest login-origin response the proxy will scrub and pass on.
pub(crate) const MAX_LOGIN_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

const REVOKED: &str = "surrogate.revoked";
const AMBIGUOUS: &str = "surrogate.ambiguous";

/// What the login desks make of one request.
pub(crate) enum Claim<'a> {
    /// No login surrogate in it, and not for a login origin.
    None,
    /// No login surrogate in it, bound for this desk's origin.
    Origin(&'a LoginDesk),
    /// It carries this desk's surrogate.
    Carrying(&'a LoginDesk),
    /// It carries more than one login's surrogate.
    Ambiguous,
}

/// One request, as the scan and the desks read it.
pub(crate) struct Seen<'a> {
    pub(crate) method: &'a str,
    pub(crate) url: &'a str,
    pub(crate) headers: &'a [(String, String)],
    pub(crate) body: &'a [u8],
}

/// Which desk, if any, this request belongs to.
pub(crate) fn claim<'a>(logins: &'a RunLogins, target: &Target, seen: &Seen<'_>) -> Claim<'a> {
    let carrying: Vec<&LoginDesk> = logins
        .desks
        .iter()
        .filter(|desk| desk.appears_in(seen.url, seen.headers, seen.body))
        .collect();
    match carrying.as_slice() {
        [] => logins
            .for_origin(&target.host, target.port)
            .map_or(Claim::None, Claim::Origin),
        [desk] => Claim::Carrying(desk),
        _ => Claim::Ambiguous,
    }
}

/// A request carrying `desk`'s surrogate: substituted and sent, or refused.
pub(crate) async fn carrying(
    ctx: &RunContext,
    desk: &LoginDesk,
    target: &Target,
    parts: &Parts,
    seen: &Seen<'_>,
) -> Response<ProxyBody> {
    let request = LoginRequest {
        method: seen.method,
        url: seen.url,
        headers: seen.headers,
        body: seen.body,
    };
    match desk.egress(&request) {
        DeskEgress::Revoked => {
            ctx.report_login(REVOKED, None);
            respond::refused(StatusCode::FORBIDDEN)
        }
        DeskEgress::Refused(refusal) => {
            let code = refusal.code.as_str();
            ctx.report_login(code, refusal.detail.as_deref());
            announce(ctx, desk, LoginOutcome::Refused(code));
            respond::refused(StatusCode::FORBIDDEN)
        }
        DeskEgress::Substituted(substituted) => {
            announce(ctx, desk, LoginOutcome::Substituted);
            // Moved, not copied: the one buffer holding the credential goes
            // to the wire and is dropped with the request.
            let mut body = substituted.into_body();
            forward(desk, target, parts, Bytes::from(std::mem::take(&mut *body))).await
        }
    }
}

/// More than one login's surrogate in one request: one request never carries
/// two logins' authority.
pub(crate) fn ambiguous(ctx: &RunContext) -> Response<ProxyBody> {
    ctx.report_login(AMBIGUOUS, None);
    respond::refused(StatusCode::FORBIDDEN)
}

fn announce(ctx: &RunContext, desk: &LoginDesk, outcome: LoginOutcome) {
    login_event(
        &ctx.shared,
        &LoginEvent {
            run_id: ctx.run_id.clone(),
            env_var: desk.env_var.clone(),
            outcome,
        },
    );
}

/// Send one request to `desk`'s origin, and return its response scrubbed of
/// the credential.
pub(crate) async fn forward(
    desk: &LoginDesk,
    target: &Target,
    parts: &Parts,
    body: Bytes,
) -> Response<ProxyBody> {
    let mut headers = end_to_end(&parts.headers);
    // The client's length described the page's body, not the one sent; the
    // client sets a new one. Identity only, so the scrub can read the reply.
    headers.remove(http::header::CONTENT_LENGTH);
    headers.remove(http::header::ACCEPT_ENCODING);
    let path_and_query = parts.uri.path_and_query().map_or("/", |p| p.as_str());
    let response = match desk
        .client
        .send(
            &parts.method,
            &target.authority(),
            path_and_query,
            headers,
            body,
        )
        .await
    {
        Ok(response) => response,
        Err(status) => return respond::upstream_failed(status),
    };
    let (mut head, incoming) = response.into_parts();
    if encoded(&head.headers) {
        return respond::upstream_failed(StatusCode::BAD_GATEWAY);
    }
    let Ok(collected) = Limited::new(incoming, MAX_LOGIN_RESPONSE_BYTES)
        .collect()
        .await
    else {
        return respond::upstream_failed(StatusCode::BAD_GATEWAY);
    };
    let (scrubbed, _) = desk.scrub.scrub(&collected.to_bytes());
    head.headers = scrub_headers(desk, &end_to_end(&head.headers));
    head.headers.remove(http::header::CONTENT_LENGTH);
    Response::from_parts(head, respond::full(scrubbed))
}

/// Whether the body carries a content coding other than identity.
fn encoded(headers: &HeaderMap) -> bool {
    headers
        .get_all(http::header::CONTENT_ENCODING)
        .iter()
        .flat_map(|value| value.to_str().unwrap_or("?").split(','))
        .any(|coding| !coding.trim().eq_ignore_ascii_case("identity"))
}

/// Every header value scrubbed; one the scrub cannot make a header of again
/// is dropped rather than passed on unread.
fn scrub_headers(desk: &LoginDesk, headers: &HeaderMap) -> HeaderMap {
    let mut kept = HeaderMap::with_capacity(headers.len());
    for (name, value) in headers {
        let (scrubbed, _) = desk.scrub.scrub(value.as_bytes());
        if let Ok(value) = HeaderValue::from_bytes(&scrubbed) {
            kept.append(name.clone(), value);
        }
    }
    kept
}
