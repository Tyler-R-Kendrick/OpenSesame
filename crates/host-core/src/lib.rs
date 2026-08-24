//! `OpenSesame` **host-core sdk** — host logic facade (ADR 0017).
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
    #[must_use]
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
    ///
    /// # Errors
    ///
    /// Returns an error when a non-loopback listener is requested without the
    /// explicit override.
    pub fn assert_tcp_listen_allowed(listen: &str) -> Result<(), String> {
        if nonlocal_override_enabled() || listen_host_is_loopback(listen) {
            return Ok(());
        }
        Err(format!(
            "TCP listen `{listen}` is not loopback; set {ENV_ALLOW_NONLOCAL}=1 to override"
        ))
    }

    #[must_use]
    pub fn uds_only_requested() -> bool {
        std::env::var(ENV_UDS_ONLY).ok().as_deref() == Some("1")
    }

    /// True when an `http(s)://` base names this machine.
    ///
    /// The operator token is a shared secret for *this host*, so a base that
    /// names anywhere else must not be offered it. Userinfo makes the authority
    /// ambiguous — `http://127.0.0.1@evil.test/` is a request to evil.test — so a
    /// base carrying any is not local.
    #[must_use]
    pub fn base_url_is_local(base: &str) -> bool {
        let trimmed = base.trim();
        let Some(rest) = trimmed
            .strip_prefix("http://")
            .or_else(|| trimmed.strip_prefix("https://"))
        else {
            return false;
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

    /// Length-hiding comparison of two secrets (SHA-256 then XOR-fold).
    #[must_use]
    pub fn constant_time_eq(a: &str, b: &str) -> bool {
        use sha2::{Digest, Sha256};
        let ha = Sha256::digest(a.as_bytes());
        let hb = Sha256::digest(b.as_bytes());
        ha.iter().zip(hb.iter()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
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

    ///
    /// # Errors
    ///
    /// Returns `Unconfigured` for an empty expected token and `Unauthorized`
    /// when no constant-time token match exists.
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
        "http://127.0.0.1:5180,http://localhost:5180,",
        "https://tyler-r-kendrick.github.io"
    );

    pub fn parse_cors_origins(raw: Option<&str>) -> Vec<String> {
        raw.unwrap_or(DEV_CORS_ORIGINS)
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

    /// Production must list explicit origins; `*` / `null` are never allowed.
    /// An unset `OPENSESAME_CORS_ORIGINS` in production is refused so the
    /// development allowlist (localhost + github.io) cannot silently apply.
    ///
    /// # Errors
    ///
    /// Returns an error for wildcard, null, absent, or empty production origin
    /// policies.
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
        if is_production {
            let configured = std::env::var(ENV_CORS_ORIGINS)
                .ok()
                .filter(|value| !value.trim().is_empty());
            if configured.is_none() {
                return Err(format!(
                    "{ENV_CORS_ORIGINS} must be set in production (refusing the development CORS allowlist)"
                ));
            }
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

    /// Chrome Private Network Access / Local Network Access: github.io →
    /// Tailscale Serve / loopback daemon. Always advertise allow on preflight
    /// when the browser asks; also echo on the final response.
    fn allow_private_network<S>(router: Router<S>) -> Router<S>
    where
        S: Clone + Send + Sync + 'static,
    {
        router.layer(middleware::from_fn(|req: Request, next: Next| async move {
            let wants = req
                .headers()
                .get("access-control-request-private-network")
                .is_some_and(|value| value.as_bytes() == b"true");
            let mut res = next.run(req).await;
            if wants {
                res.headers_mut().insert(
                    HeaderName::from_static("access-control-allow-private-network"),
                    HeaderValue::from_static("true"),
                );
            }
            res
        }))
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
    pub fn apply_http_security<S>(router: Router<S>, origins: &[String], hsts: bool) -> Router<S>
    where
        S: Clone + Send + Sync + 'static,
    {
        allow_private_network(apply_security_headers(router, hsts).layer(cors_layer(origins)))
    }
}

/// Property / Adversarial / Chaos / conTract oracles shared by Host tests.
///
/// See `docs/validation/pact.md`. These helpers kill the same classes of
/// mutants (check-then-set, source-order inversion, partition drops) so each
/// plane does not invent a one-off assertion style.
pub mod pact {
    /// Production source must mention `ordered` markers in that sequence.
    ///
    /// # Panics
    ///
    /// Panics when a marker is absent or appears out of order.
    pub fn assert_source_order(src: &str, ordered: &[&str]) {
        let production = src.split("#[cfg(test)]").next().unwrap_or(src);
        let mut last = 0usize;
        for marker in ordered {
            let pos = production
                .get(last..)
                .and_then(|rest| rest.find(marker))
                .map_or_else(
                    || panic!("pact source oracle missing {marker}"),
                    |offset| last + offset,
                );
            last = pos;
        }
    }

    /// Exclusive insert: only one concurrent claimant wins.
    ///
    /// # Panics
    ///
    /// Panics if the test mutex is poisoned or the single-winner invariant fails.
    pub fn exclusive_claim_is_single_winner() {
        use std::collections::HashSet;
        use std::sync::{Arc, Mutex};
        struct Kv {
            keys: Mutex<HashSet<String>>,
        }
        impl Kv {
            fn try_claim(&self, key: &str) -> bool {
                let mut g = self.keys.lock().expect("kv");
                g.insert(key.to_string())
            }
        }
        let kv = Arc::new(Kv {
            keys: Mutex::new(HashSet::new()),
        });
        let mut wins = 0usize;
        for _ in 0..64 {
            if kv.try_claim("d1") {
                wins += 1;
            }
        }
        assert_eq!(wins, 1, "try_claim must be exclusive");
    }

    /// Check-then-set is the mutant that exclusive claim exists to kill.
    ///
    /// # Panics
    ///
    /// Panics if the test mutex is poisoned or the modeled race is not observed.
    pub fn check_then_set_admits_double_claim() {
        use std::collections::HashSet;
        use std::sync::Mutex;
        let keys = Mutex::new(HashSet::<String>::new());
        let check = |key: &str| !keys.lock().expect("kv").contains(key);
        let set = |key: &str| {
            keys.lock().expect("kv").insert(key.to_string());
        };
        let c1 = check("d1");
        let c2 = check("d1");
        assert!(c1 && c2, "mutant race: both checks pass");
        set("d1");
        set("d1");
        assert_eq!(keys.lock().expect("kv").len(), 1);
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::daemon::{
        assert_tcp_listen_allowed, listen_host_is_loopback, ENV_ALLOW_NONLOCAL,
        ENV_ALLOW_NONLOCAL_DAEMON,
    };
    use super::http_security::{assert_cors_origins_allowed, parse_cors_origins, ENV_CORS_ORIGINS};

    #[test]
    fn wit_package_pinned() {
        assert!(super::wit_contract::PACKAGE.contains("host"));
    }

    #[test]
    fn forwarding_headers_are_treated_as_hop_headers() {
        use super::http_security::{is_hop_or_forwarding_header, is_safe_path_id};
        assert!(is_hop_or_forwarding_header("X-Forwarded-For"));
        assert!(is_hop_or_forwarding_header("forwarded"));
        assert!(is_hop_or_forwarding_header("X-Real-IP"));
        assert!(!is_hop_or_forwarding_header("authorization"));
        assert!(is_safe_path_id("clm_abc12345"));
        assert!(!is_safe_path_id("../etc/passwd"));
        assert!(!is_safe_path_id("id?x=1"));
        assert!(!is_safe_path_id("id#frag"));
    }

    #[test]
    fn pact_oracles_kill_check_then_set_and_require_source_order() {
        super::pact::exclusive_claim_is_single_winner();
        super::pact::check_then_set_admits_double_claim();
        super::pact::assert_source_order(
            "alpha(); beta(); gamma();",
            &["alpha()", "beta()", "gamma()"],
        );
        // A marker that also appears earlier still counts after the previous step.
        super::pact::assert_source_order(
            "append_outbox(early); pub async fn resync; append_outbox(late);",
            &["pub async fn resync", "append_outbox("],
        );
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
        assert!(origins.contains(&"https://tyler-r-kendrick.github.io".into()));
        assert!(assert_cors_origins_allowed(&origins, false).is_ok());
    }

    #[test]
    fn cors_origins_reject_wildcard_and_empty_prod() {
        assert!(assert_cors_origins_allowed(&["*".into()], true).is_err());
        assert!(assert_cors_origins_allowed(&["null".into()], true).is_err());
        assert!(assert_cors_origins_allowed(&[], true).is_err());
        std::env::set_var(ENV_CORS_ORIGINS, "https://app.example");
        assert!(assert_cors_origins_allowed(&["https://app.example".into()], true).is_ok());
        std::env::remove_var(ENV_CORS_ORIGINS);
        assert!(assert_cors_origins_allowed(&["https://app.example".into()], true).is_err());
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
        assert_eq!(
            res.headers().get("cross-origin-resource-policy").unwrap(),
            "cross-origin"
        );
    }

    #[tokio::test]
    async fn private_network_preflight_allows_github_pages() {
        let app = apply_http_security(
            Router::new().route("/health", get(|| async { "ok" })),
            &["https://tyler-r-kendrick.github.io".into()],
            false,
        );
        let res = app
            .oneshot(
                Request::builder()
                    .method("OPTIONS")
                    .uri("/health")
                    .header(header::ORIGIN, "https://tyler-r-kendrick.github.io")
                    .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
                    .header("access-control-request-private-network", "true")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(
            res.status().is_success()
                || res.status() == StatusCode::NO_CONTENT
                || res.status() == StatusCode::OK
        );
        assert_eq!(
            res.headers()
                .get("access-control-allow-private-network")
                .unwrap(),
            "true"
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
