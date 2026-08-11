//! OpenSesame **host-core sdk** — host logic facade (ADR 0017).
//!
//! WIT: `wit/host/world.wit`.

pub use opensesame_audit as audit;
pub use opensesame_authn as authn;
pub use opensesame_authz as authz;
pub use opensesame_broker as broker;
pub use opensesame_connector_host as connector_host;
pub use opensesame_core as core;
pub use opensesame_env_spec as env_spec;

pub mod wit_contract {
    pub const PACKAGE: &str = "opensesame:host@1.0.0";
}

/// Daemon listen defaults (HTTP loopback) and bind policy helpers.
pub mod daemon {
    pub const DEFAULT_LISTEN: &str = "127.0.0.1:18790";
    pub const ENV_LISTEN: &str = "OPENSESAME_AGENT_LISTEN";
    pub const ENV_LISTEN_ALIAS: &str = "OPENSESAME_DAEMON_LISTEN";
    /// When `1`, skip TCP and serve Unix socket only (`OPENSESAME_AGENT_SOCK` required).
    pub const ENV_UDS_ONLY: &str = "OPENSESAME_DAEMON_UDS_ONLY";
    /// When `1`, allow non-loopback TCP binds (explicit operator override).
    /// Shared by daemon, credential-agent, and gateway.
    pub const ENV_ALLOW_NONLOCAL: &str = "OPENSESAME_ALLOW_NONLOCAL";
    /// Legacy alias kept for daemon/operator docs.
    pub const ENV_ALLOW_NONLOCAL_DAEMON: &str = "OPENSESAME_DAEMON_ALLOW_NONLOCAL";

    /// True when `host` of `host:port` (or bare host) is loopback.
    pub fn listen_host_is_loopback(listen: &str) -> bool {
        let host = match listen.rsplit_once(':') {
            Some((h, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => {
                h.trim_start_matches('[').trim_end_matches(']')
            }
            _ => listen.trim_start_matches('[').trim_end_matches(']'),
        };
        matches!(host, "127.0.0.1" | "localhost" | "::1" | "0:0:0:0:0:0:0:1")
    }

    fn nonlocal_override_enabled() -> bool {
        [ENV_ALLOW_NONLOCAL, ENV_ALLOW_NONLOCAL_DAEMON]
            .iter()
            .any(|k| std::env::var(k).ok().as_deref() == Some("1"))
    }

    /// Refuse non-loopback TCP unless `OPENSESAME_ALLOW_NONLOCAL=1`
    /// (or legacy `OPENSESAME_DAEMON_ALLOW_NONLOCAL=1`).
    pub fn assert_tcp_listen_allowed(listen: &str) -> Result<(), String> {
        if nonlocal_override_enabled() || listen_host_is_loopback(listen) {
            return Ok(());
        }
        Err(format!(
            "TCP listen `{listen}` is not loopback; set {ENV_ALLOW_NONLOCAL}=1 to override"
        ))
    }

    pub fn uds_only_requested() -> bool {
        std::env::var(ENV_UDS_ONLY).ok().as_deref() == Some("1")
    }

    /// True when an `http(s)://` base names this machine.
    ///
    /// The operator token is a shared secret for *this host*, so a base that
    /// names anywhere else must not be offered it. Userinfo makes the authority
    /// ambiguous — `http://127.0.0.1@evil.test/` is a request to evil.test — so a
    /// base carrying any is not local.
    pub fn base_url_is_local(base: &str) -> bool {
        let trimmed = base.trim();
        let rest = match trimmed
            .strip_prefix("http://")
            .or_else(|| trimmed.strip_prefix("https://"))
        {
            Some(rest) => rest,
            None => return false,
        };
        let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
        if authority.is_empty() || authority.contains('@') {
            return false;
        }
        listen_host_is_loopback(&authority.to_ascii_lowercase())
    }
}

/// Operator bearer check shared by the local host binaries.
///
/// Loopback is not a boundary here: a co-resident process reaches the daemon as
/// easily as the toolbar does, so every mutating local route wants this.
pub mod operator {
    use axum::http::{header, HeaderMap};

    /// Length-checked, branch-free comparison of two secrets.
    pub fn constant_time_eq(a: &str, b: &str) -> bool {
        let (aa, bb) = (a.as_bytes(), b.as_bytes());
        if aa.len() != bb.len() {
            return false;
        }
        let mut diff = 0u8;
        for (x, y) in aa.iter().zip(bb.iter()) {
            diff |= x ^ y;
        }
        diff == 0
    }

    /// `X-OpenSesame-Operator: <token>` or `Authorization: Bearer operator:<token>`.
    pub fn token_from_headers(headers: &HeaderMap) -> Option<String> {
        let from_header = headers
            .get("x-opensesame-operator")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let from_bearer = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|a| {
                a.strip_prefix("Bearer operator:")
                    .or_else(|| a.strip_prefix("bearer operator:"))
                    .map(str::to_string)
            });
        from_header.or(from_bearer)
    }

    /// Why a request is not operator-authorized.
    #[derive(Debug, PartialEq, Eq)]
    pub enum OperatorDenial {
        /// No token configured — the route denies rather than opening up.
        Unconfigured,
        Unauthorized,
    }

    pub fn check(expected: &str, headers: &HeaderMap) -> Result<(), OperatorDenial> {
        if expected.is_empty() {
            return Err(OperatorDenial::Unconfigured);
        }
        match token_from_headers(headers) {
            Some(t) if constant_time_eq(&t, expected) => Ok(()),
            _ => Err(OperatorDenial::Unauthorized),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use axum::http::HeaderValue;

        #[test]
        fn an_unset_token_denies_instead_of_allowing() {
            let mut headers = HeaderMap::new();
            headers.insert("x-opensesame-operator", HeaderValue::from_static(""));
            assert_eq!(check("", &headers), Err(OperatorDenial::Unconfigured));
        }

        #[test]
        fn header_and_bearer_forms_both_authorize() {
            let mut headers = HeaderMap::new();
            headers.insert("x-opensesame-operator", HeaderValue::from_static("s3cret"));
            assert!(check("s3cret", &headers).is_ok());

            let mut headers = HeaderMap::new();
            headers.insert(
                header::AUTHORIZATION,
                HeaderValue::from_static("Bearer operator:s3cret"),
            );
            assert!(check("s3cret", &headers).is_ok());
        }

        #[test]
        fn a_wrong_or_missing_token_is_unauthorized() {
            assert_eq!(
                check("s3cret", &HeaderMap::new()),
                Err(OperatorDenial::Unauthorized)
            );
            let mut headers = HeaderMap::new();
            headers.insert("x-opensesame-operator", HeaderValue::from_static("nope"));
            assert_eq!(check("s3cret", &headers), Err(OperatorDenial::Unauthorized));
        }

        #[test]
        fn comparison_is_length_checked() {
            assert!(!constant_time_eq("abc", "abcd"));
            assert!(constant_time_eq("abc", "abc"));
        }
    }
}

/// Browser CORS allowlist + baseline response headers (`OPENSESAME_CORS_ORIGINS`).
pub mod http_security {
    use axum::{
        extract::Request,
        http::{header, HeaderName, HeaderValue, Method},
        middleware::{self, Next},
        Router,
    };
    use tower_http::cors::{AllowOrigin, CorsLayer};

    pub const ENV_CORS_ORIGINS: &str = "OPENSESAME_CORS_ORIGINS";
    /// Vite apps that call Host API / daemon from the browser.
    pub const DEV_CORS_ORIGINS: &str = concat!(
        "http://127.0.0.1:5173,http://localhost:5173,",
        "http://127.0.0.1:5174,http://localhost:5174,",
        "http://127.0.0.1:5175,http://localhost:5175,",
        "http://127.0.0.1:5176,http://localhost:5176,",
        "http://127.0.0.1:5177,http://localhost:5177,",
        "http://127.0.0.1:5180,http://localhost:5180"
    );

    pub fn parse_cors_origins(raw: Option<&str>) -> Vec<String> {
        raw.unwrap_or(DEV_CORS_ORIGINS)
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect()
    }

    pub fn cors_origins_from_env() -> Vec<String> {
        parse_cors_origins(std::env::var(ENV_CORS_ORIGINS).ok().as_deref())
    }

    /// Production must list explicit origins; `*` / `null` are never allowed.
    pub fn assert_cors_origins_allowed(
        origins: &[String],
        is_production: bool,
    ) -> Result<(), String> {
        if origins
            .iter()
            .any(|o| o == "*" || o.eq_ignore_ascii_case("null"))
        {
            return Err(format!("{ENV_CORS_ORIGINS} must not include * or null"));
        }
        if is_production && origins.is_empty() {
            return Err(format!(
                "{ENV_CORS_ORIGINS} must list at least one origin in production"
            ));
        }
        Ok(())
    }

    fn cors_layer(origins: &[String]) -> CorsLayer {
        let allow = origins
            .iter()
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
                Method::OPTIONS,
            ])
            .allow_headers([
                header::AUTHORIZATION,
                header::CONTENT_TYPE,
                HeaderName::from_static("x-request-id"),
                HeaderName::from_static("idempotency-key"),
                HeaderName::from_static("dpop"),
                HeaderName::from_static("x-opensesame-operator"),
            ])
            .allow_credentials(true)
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

    /// Security headers + fail-closed CORS allowlist for browser-facing host APIs.
    pub fn apply_http_security<S>(router: Router<S>, origins: &[String], hsts: bool) -> Router<S>
    where
        S: Clone + Send + Sync + 'static,
    {
        apply_security_headers(router, hsts).layer(cors_layer(origins))
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::daemon::{
        assert_tcp_listen_allowed, listen_host_is_loopback, ENV_ALLOW_NONLOCAL,
        ENV_ALLOW_NONLOCAL_DAEMON,
    };
    use super::http_security::{assert_cors_origins_allowed, parse_cors_origins};

    #[test]
    fn wit_package_pinned() {
        assert!(super::wit_contract::PACKAGE.contains("host"));
    }

    #[test]
    fn a_local_base_url_is_told_apart_from_a_remote_one() {
        use super::daemon::base_url_is_local;
        for local in [
            "http://127.0.0.1:8787",
            "http://localhost:8787/api",
            "https://LOCALHOST",
            "http://[::1]:18790",
        ] {
            assert!(base_url_is_local(local), "{local} names this machine");
        }
        for remote in [
            "http://10.0.0.5:8787",
            "https://api.example.test",
            // Userinfo: the authority is evil.test, whatever it is dressed as.
            "http://127.0.0.1@evil.test/api",
            "http://localhost.evil.test",
            // Not an http(s) base at all.
            "ftp://127.0.0.1",
            "127.0.0.1:8787",
            "",
        ] {
            assert!(!base_url_is_local(remote), "{remote} is not this machine");
        }
    }

    #[test]
    fn loopback_listen_hosts() {
        assert!(listen_host_is_loopback("127.0.0.1:18790"));
        assert!(listen_host_is_loopback("localhost:18790"));
        assert!(listen_host_is_loopback("[::1]:18790"));
        assert!(!listen_host_is_loopback("0.0.0.0:18790"));
        assert!(!listen_host_is_loopback("192.168.1.10:18790"));
    }

    #[test]
    fn nonlocal_tcp_denied_without_override() {
        // Ensure override unset for this process check.
        std::env::remove_var(ENV_ALLOW_NONLOCAL);
        std::env::remove_var(ENV_ALLOW_NONLOCAL_DAEMON);
        assert!(assert_tcp_listen_allowed("127.0.0.1:18790").is_ok());
        assert!(assert_tcp_listen_allowed("0.0.0.0:18790").is_err());
    }

    #[test]
    fn cors_origins_default_includes_vite_apps() {
        let origins = parse_cors_origins(None);
        assert!(origins.contains(&"http://127.0.0.1:5173".into()));
        assert!(origins.contains(&"http://127.0.0.1:5180".into()));
        assert!(assert_cors_origins_allowed(&origins, false).is_ok());
    }

    #[test]
    fn cors_origins_reject_wildcard_and_empty_prod() {
        assert!(assert_cors_origins_allowed(&["*".into()], true).is_err());
        assert!(assert_cors_origins_allowed(&["null".into()], true).is_err());
        assert!(assert_cors_origins_allowed(&[], true).is_err());
        assert!(assert_cors_origins_allowed(&["https://app.example".into()], true).is_ok());
    }

    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    fn read_wit(rel: &str) -> String {
        std::fs::read_to_string(repo_root().join(rel))
            .unwrap_or_else(|e| panic!("cannot read {rel}: {e}"))
    }

    fn assert_no_secrets_or_arbitrary_sign(src: &str) {
        let code: String = src
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n")
            .to_lowercase();
        assert!(
            !code.contains("secrets.get"),
            "WIT must not expose secrets.get"
        );
        assert!(
            !code.contains("sign: func(") || code.contains("purpose:"),
            "sign must be purpose-bound if present"
        );
    }

    #[test]
    fn wit_task_contract() {
        let src = read_wit("wit/task/world.wit");
        assert_no_secrets_or_arbitrary_sign(&src);
        assert!(src.contains("authorize-and-invoke"));
        assert!(src.contains("restrict"));
        assert!(src.contains("terminate"));
        assert!(src.contains("task-handle"));
        assert!(src.contains("intent-handle"));
    }

    #[test]
    fn wit_proof_contract() {
        let src = read_wit("wit/proof/world.wit");
        assert_no_secrets_or_arbitrary_sign(&src);
        assert!(src.contains("execute-authorized-proof"));
        assert!(src.contains("task-run-id"));
        assert!(src.contains("intent-digest"));
    }

    #[test]
    fn wit_mediation_contract() {
        let src = read_wit("wit/mediation/world.wit");
        assert_no_secrets_or_arbitrary_sign(&src);
        assert!(src.contains("classify-result"));
        assert!(src.contains("acknowledge-transition"));
    }

    #[test]
    fn host_wit_unchanged_exports() {
        let src = read_wit("wit/host/world.wit");
        assert!(src.contains("export session"));
        assert!(src.contains("export invoke"));
        assert!(src.contains("opensesame:host@1.0.0"));
    }
}

#[cfg(test)]
mod http_security_layer_tests {
    use axum::{
        body::Body,
        http::{header, Request, StatusCode},
        routing::get,
        Router,
    };
    use tower::ServiceExt;

    use super::http_security::apply_http_security;

    #[tokio::test]
    async fn sets_baseline_headers_cors_and_hsts() {
        let app = apply_http_security(
            Router::new().route("/health/live", get(|| async { "ok" })),
            &["http://127.0.0.1:5173".into()],
            true,
        );
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/health/live")
                    .header(header::ORIGIN, "http://127.0.0.1:5173")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers().get("x-content-type-options").unwrap(),
            "nosniff"
        );
        assert_eq!(res.headers().get("x-frame-options").unwrap(), "DENY");
        assert!(res.headers().get("strict-transport-security").is_some());
        assert_eq!(
            res.headers().get("access-control-allow-origin").unwrap(),
            "http://127.0.0.1:5173"
        );
    }

    #[tokio::test]
    async fn disallowed_origin_has_no_acao() {
        let app = apply_http_security(
            Router::new().route("/health/live", get(|| async { "ok" })),
            &["http://127.0.0.1:5173".into()],
            false,
        );
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/health/live")
                    .header(header::ORIGIN, "https://evil.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(res.headers().get("access-control-allow-origin").is_none());
        assert!(res.headers().get("strict-transport-security").is_none());
    }
}
