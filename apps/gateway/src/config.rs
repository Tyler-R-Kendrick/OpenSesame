use clap::Parser;
use std::{env, net::SocketAddr};

#[cfg(test)]
pub use opensesame_host_core::deployment_mode::DeploymentMode;
pub use opensesame_host_core::deployment_mode::{Deployment, ExposureClass};

pub fn constant_time_eq(a: &str, b: &str) -> bool {
    use sha2::{Digest, Sha256};
    // Compare digests so a length mismatch cannot return early.
    let ha = Sha256::digest(a.as_bytes());
    let hb = Sha256::digest(b.as_bytes());
    ha.iter().zip(hb.iter()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

#[derive(Parser, Debug, Clone)]
#[command(name = "opensesame-gateway")]
pub struct Args {
    #[arg(long, env = "OPENSESAME_LISTEN", default_value = "127.0.0.1:8787")]
    pub listen: SocketAddr,
    #[arg(
        long,
        env = "OPENSESAME_RESOURCE",
        default_value = "https://opensesame.local"
    )]
    pub resource: String,
    #[arg(
        long,
        env = "OPENSESAME_ISSUER",
        default_value = "https://keycloak.local/realms/opensesame"
    )]
    pub issuer: String,
    #[arg(
        long,
        env = "OPENSESAME_DB",
        default_value = ".tools/run/opensesame.db"
    )]
    pub database_url: String,
    #[arg(long, env = "OPENSESAME_TASK_DB", default_value = "")]
    pub task_database_url: String,
}

pub fn is_production_env() -> bool {
    // Legacy call sites fail closed on invalid mode. Startup validates every
    // effective endpoint through StartupSecurity before persistent state opens.
    opensesame_host_core::deployment_mode::from_env(ExposureClass::LocalOnly)
        .map_or(true, Deployment::production_safeguards)
}

/// Our A2H `agent_id` — the software identity a person sees attached to an
/// escalation on their phone.
///
/// Defaults to `did:web:<host of the public URL>`, the form the A2H spec's own
/// examples use, so a deployment that configures nothing still sends a stable
/// identifier rather than an empty string. Read from the environment the same
/// way `dev_bootstrap_enabled` is, and for the same reason: it is needed where
/// threading a new field through `AppState` would buy nothing.
#[must_use]
pub fn a2h_agent_id(public_url: &str) -> String {
    if let Ok(configured) = env::var("OPENSESAME_A2H_AGENT_ID") {
        let trimmed = configured.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let host = public_url
        .split("://")
        .nth(1)
        .unwrap_or(public_url)
        .split(['/', ':'])
        .next()
        .filter(|host| !host.is_empty())
        .unwrap_or("opensesame.local");
    format!("did:web:{host}")
}

/// Where an escalation's deep link points — the surface a person opens to watch
/// or take over a run.
///
/// Defaults to the gateway's own public URL. A deployment that serves the PWA
/// somewhere else sets this, because a link to an API host is a link nobody can
/// act on.
#[must_use]
pub fn a2h_attach_base(public_url: &str) -> String {
    env::var("OPENSESAME_A2H_ATTACH_BASE")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| public_url.to_string())
        .trim_end_matches('/')
        .to_string()
}

pub fn dev_bootstrap_enabled() -> bool {
    env::var("OPENSESAME_DEV_BOOTSTRAP")
        .ok()
        .is_some_and(|v| v == "true" || v == "1")
}

/// Vault KV v2 read facade (`apps/gateway/src/routes/kv_facade.rs`), default off.
///
/// Read the same way `dev_bootstrap_enabled` is, and for the same reason: the
/// router is built from `AppState`, so a flag that decides whether a route
/// group is *mounted at all* has to be readable without threading a new field
/// through state. Off means the routes do not exist, so a probe sees 404 rather
/// than a 403 that confirms the surface is there.
pub fn kv_facade_enabled() -> bool {
    env::var("OPENSESAME_KV_FACADE")
        .ok()
        .is_some_and(|v| v == "true" || v == "1")
}

pub fn cors_origins() -> Vec<String> {
    opensesame_host_core::http_security::cors_origins_from_env()
}

pub fn assert_cors_origins() -> Result<(), String> {
    opensesame_host_core::http_security::assert_cors_origins_allowed(
        &cors_origins(),
        is_production_env(),
    )
}

/// Receipt signing key, from `OPENSESAME_RECEIPT_SIGNING_KEY` (base64 32-byte seed).
///
/// Receipts are the non-repudiation record and the store outlives the process, so
/// an ephemeral key means every receipt written before a restart verifies as
/// `valid: false` — indistinguishable from tampering. Production must supply one.
pub fn resolve_receipt_signer() -> Result<opensesame_audit::ReceiptSigner, String> {
    match env::var("OPENSESAME_RECEIPT_SIGNING_KEY") {
        Ok(seed) if !seed.trim().is_empty() => {
            opensesame_audit::ReceiptSigner::from_seed_b64(&seed).map_err(|e| e.to_string())
        }
        _ if is_production_env() => Err(
            "OPENSESAME_RECEIPT_SIGNING_KEY unset in production; receipts would be \
             unverifiable after restart"
                .into(),
        ),
        _ => {
            tracing::warn!(
                "OPENSESAME_RECEIPT_SIGNING_KEY unset; using an ephemeral receipt key (dev only)"
            );
            Ok(opensesame_audit::ReceiptSigner::generate())
        }
    }
}

/// Keys trusted to have signed a receipt: the active signer plus any retired
/// public keys from `OPENSESAME_RECEIPT_VERIFY_KEYS` (comma or whitespace
/// separated base64 32-byte ed25519 public keys).
///
/// Verification needs no secret, so rotating the signer does not require keeping
/// the old seed — only its public half — and old receipts stay verifiable.
pub fn resolve_receipt_verifier(
    signer: &opensesame_audit::ReceiptSigner,
) -> Result<opensesame_audit::ReceiptVerifier, String> {
    let mut verifier = opensesame_audit::ReceiptVerifier::new();
    verifier.trust(signer.verifying_key());
    let retired = env::var("OPENSESAME_RECEIPT_VERIFY_KEYS").unwrap_or_default();
    for entry in retired.split([',', ' ', '\n', '\t']) {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        verifier.trust_b64(entry).map_err(|e| e.to_string())?;
    }
    Ok(verifier)
}

/// Pepper for low-entropy digests (user codes).
///
/// A user code is ~2^35 possibilities, so a keyless digest of one is recoverable
/// by exhaustion; the pepper is what makes the stored digest worth storing.
pub fn resolve_claim_pepper() -> Result<String, String> {
    required_secret(
        "OPENSESAME_CLAIM_PEPPER",
        env::var("OPENSESAME_CLAIM_PEPPER").ok().as_deref(),
    )
}

pub fn resolve_operator_token() -> Result<String, String> {
    required_secret(
        "OPENSESAME_OPERATOR_TOKEN",
        env::var("OPENSESAME_OPERATOR_TOKEN").ok().as_deref(),
    )
}

fn required_secret(name: &str, value: Option<&str>) -> Result<String, String> {
    match value {
        Some(value) if value.len() >= 32 && value.trim() == value
            && value.bytes().all(|byte| byte.is_ascii_graphic())
            && value.bytes().collect::<std::collections::HashSet<_>>().len() >= 8 => Ok(value.into()),
        _ => Err(format!("{name} must contain an explicitly provisioned high-entropy secret of at least 32 bytes")),
    }
}

/// Validated once, before connecting or mutating any durable store.
/// Deliberately no Debug/Serialize implementation: this carries secret material.
pub struct StartupSecurity {
    pub host_authorization: Option<crate::host_authorization::HostAuthorizationVerifier>,
    pub deployment: Deployment,
    pub identity_mapping: Option<crate::identity_mapping::IdentityMappingClient>,
    pub operator_token: String,
    pub claim_pepper: String,
    pub receipt_signer: opensesame_audit::ReceiptSigner,
}

impl StartupSecurity {
    pub fn load(args: &Args) -> Result<Self, String> {
        use opensesame_host_core::deployment_mode::{classify, from_env};
        crate::browser_pairing_proof::pairable_origins()?;
        let mut endpoints = vec![args.resource.clone(), args.issuer.clone()];
        for name in [
            "OPENSESAME_PUBLIC_URL",
            "OPENSESAME_HOST_API",
            "OPENSESAME_IDENTITY_URL",
            "OPENSESAME_API_URL",
            "OPENSESAME_SERVER",
            "OPENSESAME_CALLBACK_BASE",
            "OPENSESAME_A2H_ATTACH_BASE",
            "OPENSESAME_HOST_AUTHORIZATION_ISSUER",
        ] {
            if let Ok(value) = env::var(name) {
                endpoints.push(value);
            }
        }
        let endpoint_refs = endpoints.iter().map(String::as_str).collect::<Vec<_>>();
        let exposure = classify(&[&args.listen.to_string()], &endpoint_refs)?;
        let deployment = from_env(exposure)?;
        if deployment.production_safeguards()
            && endpoint_refs.iter().any(|endpoint| {
                !endpoint.starts_with("https://")
                    && opensesame_host_core::deployment_mode::endpoint_exposure(endpoint)
                        != Ok(ExposureClass::LocalOnly)
            })
        {
            return Err("networked deployment endpoints require HTTPS".into());
        }
        if deployment.production_safeguards() && dev_bootstrap_enabled() {
            return Err(
                "OPENSESAME_DEV_BOOTSTRAP requires local-only non-production deployment".into(),
            );
        }
        assert_cors_origins()?;
        let operator_token = resolve_operator_token()?;
        let claim_pepper = resolve_claim_pepper()?;
        if deployment.production_safeguards()
            && env::var("OPENSESAME_RECEIPT_SIGNING_KEY")
                .ok()
                .is_none_or(|key| key.trim().is_empty())
        {
            return Err(
                "OPENSESAME_RECEIPT_SIGNING_KEY is required for production or networked deployment"
                    .into(),
            );
        }
        let receipt_signer = resolve_receipt_signer()?;
        let identity_mapping = if [
            "OPENSESAME_NATS_CALLOUT_SECRET",
            "OPENSESAME_MAPPING_RESOLVE_TOKEN",
        ]
        .iter()
        .any(|name| env::var(name).is_ok_and(|value| !value.is_empty()))
        {
            Some(
                crate::identity_mapping::IdentityMappingClient::from_env(deployment)
                    .map_err(|error| error.to_string())?,
            )
        } else {
            None
        };
        Ok(Self {
            host_authorization: crate::host_authorization::HostAuthorizationVerifier::from_env()?,
            deployment,
            identity_mapping,
            operator_token,
            claim_pepper,
            receipt_signer,
        })
    }
}

#[cfg(test)]
mod security_tests {
    use super::required_secret;

    #[test]
    fn missing_weak_or_published_development_secrets_fail_closed() {
        for value in [
            None,
            Some(""),
            Some("opensesame-dev-operator"),
            Some("opensesame-dev-claim-pepper"),
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            Some(" abcdefghijklmnopqrstuvwxyz0123456789"),
        ] {
            assert!(required_secret("TEST_SECRET", value).is_err());
        }
        assert!(
            required_secret("TEST_SECRET", Some("abcdefghijklmnopqrstuvwxyz0123456789")).is_ok()
        );
    }

    #[test]
    fn invalid_configuration_errors_never_echo_secret_material() {
        let planted = "private-secret-sentinel";
        let error = required_secret("TEST_SECRET", Some(planted)).unwrap_err();
        assert!(!error.contains(planted));
        assert!(error.contains("TEST_SECRET"));
    }
}
