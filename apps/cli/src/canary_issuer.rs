//! One configured native Host retirement adapter. Local passwords never authorize the Host.
use opensesame_human_vault::credential_canaries::Artifact;
use opensesame_sealed_store::{credential_canaries::issuer, StoreError};
use std::{path::PathBuf, time::Duration};
use zeroize::Zeroizing;
struct HostIssuer {
    origin: String,
    authorization: Vec<Zeroizing<String>>,
    runtime: tokio::runtime::Handle,
}
impl issuer::TrustedIssuerProvider for HostIssuer {
    fn retire_authenticated(
        &self,
        reference: &str,
        identity: &str,
    ) -> Result<Artifact, StoreError> {
        self.runtime
            .block_on(self.retire(reference, identity))
            .map_err(|_| StoreError::Other("configured issuer retirement refused".into()))
    }
}
impl HostIssuer {
    async fn retire(&self, reference: &str, identity: &str) -> anyhow::Result<Artifact> {
        // Issuance UUIDs are public references, not credentials supplied by the owner.
        let parsed = uuid::Uuid::parse_str(reference)?;
        anyhow::ensure!(
            parsed.to_string() == reference,
            "issuer reference must be canonical"
        );
        let destination = format!(
            "{}/api/v1/credential-canaries/issued/{reference}/retire",
            self.origin
        );
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .referer(false)
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(4))
            .build()?;
        for authorization in &self.authorization {
            let mut header = reqwest::header::HeaderValue::from_str(authorization)?;
            header.set_sensitive(true);
            let mut response = client
                .post(&destination)
                .header(reqwest::header::AUTHORIZATION, header)
                .send()
                .await?;
            if matches!(
                response.status(),
                reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
            ) {
                continue;
            }
            anyhow::ensure!(
                response.status().is_success(),
                "configured issuer refused retirement"
            );
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await? {
                anyhow::ensure!(
                    bytes.len() + chunk.len() <= 4096,
                    "issuer metadata exceeds its bound"
                );
                bytes.extend_from_slice(&chunk);
            }
            let artifact: Artifact = serde_json::from_slice(&bytes)?;
            anyhow::ensure!(
                artifact.context.vault_identity == identity,
                "issuer vault context mismatch"
            );
            return Ok(artifact);
        }
        anyhow::bail!("configured native owner authorization is required")
    }
}
fn origin(server: &str, allow_loopback: bool) -> anyhow::Result<String> {
    let origin = server.strip_suffix('/').unwrap_or(server);
    let url = reqwest::Url::parse(origin)?;
    let local = allow_loopback
        && url.scheme() == "http"
        && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    anyhow::ensure!(
        (url.scheme() == "https" || local)
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.origin().ascii_serialization() == origin,
        "issuer requires a configured HTTPS origin or explicitly approved loopback"
    );
    Ok(origin.to_owned())
}
pub(crate) async fn retire(
    root: PathBuf,
    current: Zeroizing<String>,
    reference: String,
    server: &str,
    allow_loopback: bool,
) -> anyhow::Result<()> {
    let provider = HostIssuer {
        origin: origin(server, allow_loopback)?,
        authorization: crate::connect::authorization_headers()
            .into_iter()
            .map(Zeroizing::new)
            .collect(),
        runtime: tokio::runtime::Handle::current(),
    };
    anyhow::ensure!(
        !provider.authorization.is_empty(),
        "configured native owner authorization is required"
    );
    tokio::task::spawn_blocking(move || {
        issuer::retire_issued(&root, current.as_bytes(), &reference, &provider)
    })
    .await??;
    println!("Retired issuer authority and imported its verified detection metadata.");
    Ok(())
}
