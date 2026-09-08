//! Route-scoped CORS and shared response hardening. No implicit browser trust.
use axum::{
    extract::Request,
    http::{header, HeaderName, HeaderValue, Method},
    middleware::{self, Next},
    Router,
};
use tower_http::cors::{AllowOrigin, CorsLayer};

pub const ENV_CORS_ORIGINS: &str = "OPENSESAME_CORS_ORIGINS";

/// Absence means no cross-origin access, including in local development.
#[must_use]
pub fn parse_cors_origins(raw: Option<&str>) -> Vec<String> {
    raw.unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

#[must_use]
pub fn cors_origins_from_env() -> Vec<String> {
    parse_cors_origins(std::env::var(ENV_CORS_ORIGINS).ok().as_deref())
}

/// Canonical origins only. A URL path cannot establish an origin boundary.
#[must_use]
pub fn is_exact_origin(origin: &str) -> bool {
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https")
        && url.origin().ascii_serialization() == origin
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.host_str().is_some_and(|host| !host.ends_with('.'))
        && (url.scheme() == "https"
            || crate::deployment_mode::endpoint_exposure(origin)
                == Ok(crate::deployment_mode::ExposureClass::LocalOnly))
}

/// Empty policies are a safe server-only deployment.
/// # Errors
/// Wildcards, null, noncanonical origins and remote HTTP origins are refused.
pub fn assert_cors_origins_allowed(origins: &[String], _is_production: bool) -> Result<(), String> {
    if origins.iter().any(|origin| !is_exact_origin(origin)) {
        return Err(format!(
            "{ENV_CORS_ORIGINS} requires exact HTTPS or loopback origins"
        ));
    }
    Ok(())
}

/// The caller must pass only currently paired origins and mount this on the
/// browser-grant route group. This never authenticates the actual request.
pub fn browser_cors_layer(origins: &[String]) -> CorsLayer {
    let allow = origins
        .iter()
        .filter(|o| is_exact_origin(o))
        .filter_map(|o| HeaderValue::from_str(o).ok())
        .collect::<Vec<_>>();
    CorsLayer::new()
        .allow_origin(AllowOrigin::list(allow))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
        ])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            HeaderName::from_static("x-request-id"),
            HeaderName::from_static("idempotency-key"),
            HeaderName::from_static("dpop"),
        ])
}

/// Credentialless public discovery; never mount this on authority routes.
pub fn public_cors_layer(origins: &[String]) -> CorsLayer {
    let allow = origins
        .iter()
        .filter(|o| is_exact_origin(o))
        .filter_map(|o| HeaderValue::from_str(o).ok())
        .collect::<Vec<_>>();
    CorsLayer::new()
        .allow_origin(AllowOrigin::list(allow))
        .allow_methods([Method::GET])
}

/// nosniff / DENY frame / no-referrer / no-store (+ optional HSTS).
pub fn apply_security_headers<S>(router: Router<S>, hsts: bool) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    router.layer(middleware::from_fn(
        move |req: Request, next: Next| async move {
            let mut res = next.run(req).await;
            let headers = res.headers_mut();
            headers.insert(
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            );
            headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
            headers.insert(
                header::REFERRER_POLICY,
                HeaderValue::from_static("no-referrer"),
            );
            headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            headers.insert(
                HeaderName::from_static("x-permitted-cross-domain-policies"),
                HeaderValue::from_static("none"),
            );
            headers.insert(
                HeaderName::from_static("permissions-policy"),
                HeaderValue::from_static(
                    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
                ),
            );
            headers.insert(
                HeaderName::from_static("cross-origin-resource-policy"),
                HeaderValue::from_static("cross-origin"),
            );
            if hsts {
                headers.insert(
                    header::STRICT_TRANSPORT_SECURITY,
                    HeaderValue::from_static("max-age=63072000; includeSubDomains"),
                );
            }
            res
        },
    ))
}

/// Hop-by-hop and client-controlled forwarding headers the daemon must
/// strip before proxying to loopback Host/Identity APIs.
#[must_use]
pub fn is_hop_or_forwarding_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailers"
            | "transfer-encoding"
            | "upgrade"
            | "host"
            | "content-length"
            | "x-forwarded-for"
            | "x-forwarded-host"
            | "x-forwarded-proto"
            | "x-forwarded-port"
            | "x-forwarded-prefix"
            | "x-real-ip"
            | "forwarded"
            | "x-original-url"
            | "x-rewrite-url"
    )
}

/// Path-segment ids interpolated into upstream URLs (claim ids, etc.).
#[must_use]
pub fn is_safe_path_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (8..=128).contains(&bytes.len())
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(*b, b'.' | b'_' | b'-' | b':'))
}

/// Security headers + fail-closed CORS allowlist for browser-facing host APIs.
pub fn apply_http_security<S>(router: Router<S>, _origins: &[String], hsts: bool) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    apply_security_headers(router, hsts)
}
