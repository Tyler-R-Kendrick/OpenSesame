//! Digest-addressed OCI component fetch (ADR 0065 §8, first roadmap item).
//!
//! A connector manifest's `spec.component.oci` reference pins the digest of
//! the component *bytes* — the same value `WasmConnector::load` hashes and
//! `HostPolicy::trusted_digests` consents to. That makes the registry pull a
//! single digest-addressed blob GET: no manifest parsing, no layer
//! selection, no tag resolution — nothing a registry can vary. The registry
//! is untrusted transport; the local sha256 check is the integrity boundary,
//! and a mismatch refuses the boot. Sigstore signature verification remains
//! deferred (ADR 0065 §8): today `signaturesRequired` means "digest must be
//! operator-pinned", and this fetch changes nothing about that.
//!
//! Auth: the anonymous OCI token flow only (a `401` + `WWW-Authenticate:
//! Bearer` challenge answered with an unauthenticated token request), which
//! is what public registries like ghcr.io serve. Private registries are out
//! of scope until credential UX review — fail closed, never prompt.

use anyhow::Context;

/// Blobs above this are refused before download completes.
pub const MAX_COMPONENT_BYTES: usize = 64 * 1024 * 1024;

pub struct OciRef {
    pub registry: String,
    pub repository: String,
    /// `sha256:<64 hex>` — the component-bytes digest.
    pub digest: String,
}

/// Parse `registry/repository@sha256:<hex>`. The digest syntax was already
/// validated by the manifest parser; this re-checks anyway (fail closed
/// beats trusting a caller).
pub fn parse_oci_ref(reference: &str) -> anyhow::Result<OciRef> {
    let (name, digest) = reference
        .rsplit_once('@')
        .context("OCI reference lacks a digest")?;
    let hex = digest
        .strip_prefix("sha256:")
        .context("OCI digest must be sha256:<hex>")?;
    anyhow::ensure!(
        hex.len() == 64
            && hex
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
        "OCI digest must be 64 lowercase hex characters"
    );
    let (registry, repository) = name
        .split_once('/')
        .context("OCI reference must be registry/repository")?;
    anyhow::ensure!(
        registry.contains('.') && !registry.contains("..") && !repository.is_empty(),
        "OCI registry must be a hostname"
    );
    anyhow::ensure!(
        !opensesame_connector_host::is_blocked_host(registry.split(':').next().unwrap_or(registry)),
        "OCI registry {registry} is a blocked host"
    );
    anyhow::ensure!(
        repository.chars().all(|c| c.is_ascii_lowercase()
            || c.is_ascii_digit()
            || matches!(c, '/' | '-' | '_' | '.')),
        "OCI repository has invalid characters"
    );
    Ok(OciRef {
        registry: registry.to_owned(),
        repository: repository.to_owned(),
        digest: digest.to_owned(),
    })
}

/// Fetch the component blob named by `reference` and verify its sha256
/// locally. Every failure is an error the boot refuses on.
pub async fn fetch_component(http: &reqwest::Client, reference: &str) -> anyhow::Result<Vec<u8>> {
    let parsed = parse_oci_ref(reference)?;
    let base = format!("https://{}", parsed.registry);
    fetch_blob_from_base(http, &base, &parsed.repository, &parsed.digest).await
}

/// The transport leg, separated from the https/hostname fence so tests can
/// drive it against a loopback registry.
pub async fn fetch_blob_from_base(
    http: &reqwest::Client,
    base: &str,
    repository: &str,
    digest: &str,
) -> anyhow::Result<Vec<u8>> {
    let url = format!("{base}/v2/{repository}/blobs/{digest}");
    let mut response = http
        .get(&url)
        .send()
        .await
        .with_context(|| format!("fetch {url}"))?;

    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        let challenge = response
            .headers()
            .get(reqwest::header::WWW_AUTHENTICATE)
            .and_then(|v| v.to_str().ok())
            .context("registry sent 401 without a WWW-Authenticate challenge")?;
        let token = anonymous_token(http, challenge).await?;
        response = http
            .get(&url)
            .bearer_auth(token)
            .send()
            .await
            .with_context(|| format!("fetch {url} with token"))?;
    }
    anyhow::ensure!(
        response.status().is_success(),
        "registry returned {} for {url}",
        response.status()
    );
    if let Some(len) = response.content_length() {
        anyhow::ensure!(
            len <= MAX_COMPONENT_BYTES as u64,
            "component blob exceeds {MAX_COMPONENT_BYTES} bytes"
        );
    }
    let bytes = response.bytes().await.context("read component blob")?;
    anyhow::ensure!(
        bytes.len() <= MAX_COMPONENT_BYTES,
        "component blob exceeds {MAX_COMPONENT_BYTES} bytes"
    );
    let actual = format!(
        "sha256:{:x}",
        <sha2::Sha256 as sha2::Digest>::digest(&bytes)
    );
    anyhow::ensure!(
        actual == digest,
        "registry blob digest {actual} does not match pinned {digest} — refusing"
    );
    Ok(bytes.to_vec())
}

/// Answer a `Bearer realm=…,service=…,scope=…` challenge anonymously. Only
/// https realms are accepted, and only fields from the challenge are sent —
/// no credentials exist on this path by design.
async fn anonymous_token(http: &reqwest::Client, challenge: &str) -> anyhow::Result<String> {
    let fields = parse_bearer_challenge(challenge)
        .context("registry challenge is not a Bearer challenge")?;
    let realm = fields
        .iter()
        .find(|(k, _)| k == "realm")
        .map(|(_, v)| v.as_str())
        .context("Bearer challenge lacks a realm")?;
    anyhow::ensure!(
        realm.starts_with("https://") || realm.starts_with("http://127.0.0.1"),
        "token realm must be https"
    );
    let mut request = http.get(realm);
    for (key, value) in &fields {
        if key == "service" || key == "scope" {
            request = request.query(&[(key.as_str(), value.as_str())]);
        }
    }
    let response = request.send().await.context("token request")?;
    anyhow::ensure!(
        response.status().is_success(),
        "token endpoint returned {}",
        response.status()
    );
    let body: serde_json::Value = response.json().await.context("token response")?;
    let token = body
        .get("token")
        .or_else(|| body.get("access_token"))
        .and_then(serde_json::Value::as_str)
        .context("token response carries no token")?;
    Ok(token.to_owned())
}

/// Minimal parser for `Bearer k="v",k2="v2"`. Values are quoted strings
/// without embedded quotes (the grammar registries actually emit); anything
/// else fails closed.
fn parse_bearer_challenge(challenge: &str) -> Option<Vec<(String, String)>> {
    let rest = challenge.trim().strip_prefix("Bearer ")?;
    let mut fields = Vec::new();
    for part in rest.split(',') {
        let (key, value) = part.trim().split_once('=')?;
        let value = value.strip_prefix('"')?.strip_suffix('"')?;
        if value.contains('"') || value.contains('\\') {
            return None;
        }
        fields.push((key.trim().to_owned(), value.to_owned()));
    }
    Some(fields)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::get;
    use axum::Router;
    use sha2::Digest;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[test]
    fn refs_parse_and_fences_hold() {
        let parsed =
            parse_oci_ref(&format!("ghcr.io/acme/echo@sha256:{}", "a".repeat(64))).expect("parses");
        assert_eq!(parsed.registry, "ghcr.io");
        assert_eq!(parsed.repository, "acme/echo");
        assert!(parsed.digest.starts_with("sha256:"));

        for bad in [
            "ghcr.io/acme/echo:latest",                              // tag, not digest
            &format!("ghcr.io/acme/echo@sha256:{}", "a".repeat(63)), // short digest
            &format!("localhost/acme/echo@sha256:{}", "a".repeat(64)), // blocked host
            &format!("127.0.0.1/acme/echo@sha256:{}", "a".repeat(64)),
            &format!("noslash@sha256:{}", "a".repeat(64)),
        ] {
            assert!(parse_oci_ref(bad).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn bearer_challenges_parse_strictly() {
        let fields = parse_bearer_challenge(
            r#"Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:a/b:pull""#,
        )
        .expect("parses");
        assert_eq!(fields[0], ("realm".into(), "https://ghcr.io/token".into()));
        assert!(parse_bearer_challenge("Basic realm=x").is_none());
        assert!(parse_bearer_challenge(r#"Bearer realm="a\"b""#).is_none());
    }

    async fn serve(app: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{addr}")
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn fetches_and_verifies_a_blob_through_the_token_flow() {
        let blob = b"component-bytes".to_vec();
        let digest = format!("sha256:{:x}", sha2::Sha256::digest(&blob));
        let challenged = Arc::new(AtomicBool::new(false));

        // Bind first so the 401 challenge can name this server's own /token
        // endpoint as the realm.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let realm = format!("http://{addr}/token");
        let state = (blob.clone(), Arc::clone(&challenged), realm);

        let app = Router::new()
            .route(
                "/token",
                get(|| async { axum::Json(serde_json::json!({"token": "anon-token"})) }),
            )
            .route("/v2/acme/echo/blobs/{digest}", get(challenge_then_serve))
            .with_state(state);
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let http = reqwest::Client::new();
        let bytes = fetch_blob_from_base(&http, &format!("http://{addr}"), "acme/echo", &digest)
            .await
            .expect("full token flow fetch");
        assert_eq!(bytes, b"component-bytes");
        assert!(
            challenged.load(Ordering::SeqCst),
            "the 401 leg must have run"
        );
    }

    /// Blob bytes, the "was challenged" flag, and the realm to advertise.
    type ChallengeState = (Vec<u8>, Arc<AtomicBool>, String);
    /// A 401 carrying exactly one `www-authenticate` header.
    type ChallengeResponse = (StatusCode, [(&'static str, String); 1]);

    /// Answer the first request with a token challenge, then serve the blob.
    ///
    /// Named rather than inline so the two-leg flow reads as two legs; as a
    /// closure inside `Router::route` it nested four deep.
    async fn challenge_then_serve(
        State((blob, challenged, realm)): State<ChallengeState>,
        headers: HeaderMap,
    ) -> Result<Vec<u8>, ChallengeResponse> {
        let Some(authorization) = headers.get("authorization") else {
            challenged.store(true, Ordering::SeqCst);
            return Err((
                StatusCode::UNAUTHORIZED,
                [(
                    "www-authenticate",
                    format!(
                        "Bearer realm=\"{realm}\",service=\"test\",scope=\"repository:acme/echo:pull\""
                    ),
                )],
            ));
        };
        assert_eq!(authorization, "Bearer anon-token");
        Ok(blob)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_wrong_digest_is_refused_even_from_a_cooperative_registry() {
        let blob = b"honest-bytes".to_vec();
        let app = Router::new().route(
            "/v2/acme/echo/blobs/{digest}",
            get(move || std::future::ready(blob.clone())),
        );
        let base = serve(app).await;
        let http = reqwest::Client::new();

        let pinned_wrong = format!("sha256:{}", "b".repeat(64));
        let err = fetch_blob_from_base(&http, &base, "acme/echo", &pinned_wrong)
            .await
            .expect_err("digest mismatch must refuse");
        assert!(err.to_string().contains("does not match pinned"));

        let honest = format!("sha256:{:x}", sha2::Sha256::digest(b"honest-bytes"));
        let bytes = fetch_blob_from_base(&http, &base, "acme/echo", &honest)
            .await
            .expect("honest digest fetches");
        assert_eq!(bytes, b"honest-bytes");
    }
}
