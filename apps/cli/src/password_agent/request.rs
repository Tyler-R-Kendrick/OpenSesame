//! Native private HTTPS executor and lease lifecycle; no response body is published.
use super::lease_store::Store;
use clap::{Args, Subcommand};
use opensesame_connector_host::password_agent::{lease, request as policy};
use std::{
    io::IsTerminal,
    net::{IpAddr, SocketAddr},
    time::Duration,
};
#[derive(Args)]
pub(crate) struct Destination {
    pub url: String,
    #[arg(long)]
    pub secret: String,
    #[arg(long, default_value = "Authorization")]
    pub header: String,
    #[arg(long, default_value = "Bearer ")]
    pub prefix: String,
}
// CLI arguments may contain private URL paths/queries; Debug never prints them.
impl std::fmt::Debug for Destination {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Destination")
            .finish_non_exhaustive()
    }
}
impl Destination {
    fn binding(&self) -> anyhow::Result<policy::Binding> {
        policy::describe(&self.url, &self.secret, &self.header, &self.prefix)
    }
}
#[derive(Args, Debug)]
pub(crate) struct Request {
    #[command(flatten)]
    pub destination: Destination,
    #[arg(long)]
    pub lease: String,
}
#[derive(Subcommand, Debug)]
pub(crate) enum LeaseCommand {
    Approve {
        #[command(flatten)]
        destination: Destination,
        #[arg(long, default_value = "10m")]
        expires_in: String,
        #[arg(long, default_value_t = 1)]
        uses: u32,
    },
    Status {
        id: String,
    },
    Revoke {
        id: String,
    },
}
fn inspect(reference: &str) -> anyhow::Result<lease::Resource> {
    inspect_before(
        reference,
        std::time::Instant::now() + Duration::from_secs(15),
    )
}
fn remaining(deadline: std::time::Instant) -> anyhow::Result<Duration> {
    deadline
        .checked_duration_since(std::time::Instant::now())
        .filter(|d| !d.is_zero())
        .ok_or_else(|| {
            anyhow::anyhow!("Private request deadline exceeded; any claimed use remains consumed")
        })
}
fn inspect_before(
    reference: &str,
    deadline: std::time::Instant,
) -> anyhow::Result<lease::Resource> {
    let (vault, item) = policy::reference_location(reference)?;
    let raw = super::io::op_timeout(
        &[
            "item".into(),
            "list".into(),
            "--vault".into(),
            vault,
            "--format".into(),
            "json".into(),
        ],
        remaining(deadline)?,
    )?;
    let values: serde_json::Value =
        serde_json::from_slice(&raw).map_err(|_| anyhow::anyhow!("Invalid version metadata"))?;
    lease::inspect(
        values
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("Invalid version metadata"))?,
        &item,
    )
}
fn instant(value: i64) -> anyhow::Result<String> {
    Ok(chrono::DateTime::from_timestamp_millis(value)
        .ok_or_else(|| anyhow::anyhow!("Invalid lease timestamp"))?
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}
fn receipt(value: &lease::Lease) -> anyhow::Result<serde_json::Value> {
    let mut receipt = value.receipt();
    receipt["createdAt"] = serde_json::json!(instant(value.created_at)?);
    receipt["expiresAt"] = serde_json::json!(instant(value.expires_at)?);
    Ok(receipt)
}
pub(super) async fn lease(cmd: LeaseCommand) -> anyhow::Result<()> {
    match cmd {
        LeaseCommand::Approve {
            destination,
            expires_in,
            uses,
        } => {
            let binding = destination.binding()?;
            let ttl = lease::limits(&expires_in, uses)?;
            anyhow::ensure!(
                std::io::stdin().is_terminal() && std::io::stderr().is_terminal(),
                "Lease approval requires an interactive terminal"
            );
            let review = &binding;
            eprintln!(
                "Approve lease: {}",
                serde_json::json!({"capability":review.capability,"method":review.method,"reference":review.reference,"destination":review.destination,"destinationFingerprint":review.destination_fingerprint,"url":review.full_url,"header":review.header,"prefix":review.prefix,"expiresIn":expires_in,"uses":uses})
            );
            // Approval is exclusively desktop authenticated, regardless of global auth flags.
            super::credential::DESKTOP.store(true, std::sync::atomic::Ordering::Relaxed);
            let resource = inspect(&binding.reference)?;
            let granted = Store::open()
                .await?
                .grant(binding, resource, ttl, uses)
                .await?;
            super::print(&receipt(&granted)?)?;
        }
        LeaseCommand::Status { id } => {
            super::print(&receipt(&Store::open().await?.status(&id).await?)?)?;
        }
        LeaseCommand::Revoke { id } => {
            super::print(&receipt(&Store::open().await?.revoke(&id).await?)?)?;
        }
    }
    Ok(())
}
pub(super) async fn execute(options: Request) -> anyhow::Result<()> {
    let binding = options.destination.binding()?;
    let mut store = Store::open()
        .await
        .map_err(|_| anyhow::anyhow!("Lease store operation failed"))?;
    store.authorize(&options.lease, &binding).await?;
    let backend = NativeBackend {
        deadline: std::time::Instant::now() + Duration::from_secs(15),
    };
    let result = execute_bounded(
        &mut store,
        &options.lease,
        &binding,
        &backend,
        Duration::from_secs(15),
    )
    .await?;
    super::print(&result)
}
trait Backend {
    async fn addresses(&self, binding: &policy::Binding) -> anyhow::Result<Vec<SocketAddr>>;
    async fn inspect(&self, reference: &str) -> anyhow::Result<lease::Resource>;
    async fn read(&self, reference: &str) -> anyhow::Result<zeroize::Zeroizing<Vec<u8>>>;
    async fn send(
        &self,
        binding: &policy::Binding,
        addresses: &[SocketAddr],
        secret: &str,
    ) -> anyhow::Result<(u16, zeroize::Zeroizing<Vec<u8>>)>;
}
async fn local_call<T: Send + 'static>(
    deadline: std::time::Instant,
    operation: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> anyhow::Result<T> {
    remaining(deadline)?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let cancellation = std::sync::Arc::new(super::process_io::Cancellation::default());
    let _guard = super::process_io::CancellationGuard(cancellation.clone());
    let worker = cancellation.clone();
    std::thread::spawn(move || {
        let result = super::process_io::scoped(worker, deadline, operation);
        let _ = sender.send(result);
    });
    if let Ok(result) =
        tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), receiver).await
    {
        result.map_err(|_| anyhow::anyhow!("Private request operation failed"))?
    } else {
        cancellation.cancel();
        anyhow::bail!("Private request deadline exceeded; any claimed use remains consumed")
    }
}
struct NativeBackend {
    deadline: std::time::Instant,
}
impl Backend for NativeBackend {
    async fn addresses(&self, binding: &policy::Binding) -> anyhow::Result<Vec<SocketAddr>> {
        let url = reqwest::Url::parse(&binding.full_url)
            .map_err(|_| anyhow::anyhow!("Invalid request URL"))?;
        let host = url
            .host_str()
            .ok_or_else(|| anyhow::anyhow!("Invalid request URL"))?
            .trim_matches(['[', ']'])
            .to_owned();
        local_call(self.deadline, move || {
            use std::net::ToSocketAddrs;
            Ok((host.as_str(), 443)
                .to_socket_addrs()
                .map_err(|_| anyhow::anyhow!("Could not resolve destination"))?
                .collect())
        })
        .await
    }
    async fn inspect(&self, reference: &str) -> anyhow::Result<lease::Resource> {
        let reference = reference.to_owned();
        let deadline = self.deadline;
        local_call(deadline, move || inspect_before(&reference, deadline)).await
    }
    async fn read(&self, reference: &str) -> anyhow::Result<zeroize::Zeroizing<Vec<u8>>> {
        let reference = reference.to_owned();
        let deadline = self.deadline;
        local_call(deadline, move || {
            Ok(zeroize::Zeroizing::new(super::io::op_timeout(
                &["read".into(), reference],
                remaining(deadline)?,
            )?))
        })
        .await
    }
    async fn send(
        &self,
        binding: &policy::Binding,
        addresses: &[SocketAddr],
        secret: &str,
    ) -> anyhow::Result<(u16, zeroize::Zeroizing<Vec<u8>>)> {
        let url = reqwest::Url::parse(&binding.full_url)
            .map_err(|_| anyhow::anyhow!("Invalid request URL"))?;
        let host = url
            .host_str()
            .ok_or_else(|| anyhow::anyhow!("Invalid request URL"))?
            .trim_matches(['[', ']']);
        let client = reqwest::Client::builder()
            .no_proxy()
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .timeout(remaining(self.deadline)?)
            .resolve_to_addrs(host, &addresses[..1])
            .build()
            .map_err(|_| anyhow::anyhow!("Private request initialization failed"))?;
        let header = zeroize::Zeroizing::new(format!("{}{secret}", binding.prefix));
        let mut response = client
            .get(url)
            .header(&binding.header, header.as_str())
            .header("Accept-Encoding", "identity")
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Private request failed; use consumed"))?;
        let status = response.status().as_u16();
        anyhow::ensure!(
            !response.status().is_redirection(),
            "Private request redirects are forbidden; use consumed"
        );
        let mut body = zeroize::Zeroizing::new(Vec::new());
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| anyhow::anyhow!("Private response failed; use consumed"))?
        {
            anyhow::ensure!(
                body.len() + chunk.len() <= 64 * 1024,
                "Private response exceeded 64 KiB; use consumed"
            );
            body.extend_from_slice(&chunk);
        }
        Ok((status, body))
    }
}
async fn execute_bounded(
    store: &mut Store,
    id: &str,
    binding: &policy::Binding,
    backend: &impl Backend,
    timeout: Duration,
) -> anyhow::Result<serde_json::Value> {
    tokio::time::timeout(timeout, execute_with(store, id, binding, backend))
        .await
        .map_err(|_| {
            anyhow::anyhow!("Private request deadline exceeded; any claimed use remains consumed")
        })?
}
async fn execute_with(
    store: &mut Store,
    id: &str,
    binding: &policy::Binding,
    backend: &impl Backend,
) -> anyhow::Result<serde_json::Value> {
    binding.validate_private_url()?;
    let addresses = backend.addresses(binding).await?;
    let ips: Vec<IpAddr> = addresses.iter().map(SocketAddr::ip).collect();
    policy::validate_addresses(&ips)?;
    let before = backend.inspect(&binding.reference).await?;
    let claimed = store.claim(id, binding, &before).await?;
    let clear = backend.read(&binding.reference).await?;
    let text = std::str::from_utf8(&clear)
        .map_err(|_| anyhow::anyhow!("Invalid leased credential; use consumed"))?;
    let secret = policy::credential(text)?;
    anyhow::ensure!(
        backend.inspect(&binding.reference).await? == before,
        "Credential changed during leased use; use consumed and nothing sent"
    );
    let (status, body) = backend.send(binding, &addresses, secret).await?;
    anyhow::ensure!(
        !(300..400).contains(&status),
        "Private request redirects are forbidden; use consumed"
    );
    anyhow::ensure!(
        body.len() <= 64 * 1024,
        "Private response exceeded 64 KiB; use consumed"
    );
    let mut receipt = policy::receipt(binding, status, &body, secret);
    receipt["lease"] = serde_json::json!({"id":claimed.id,"principal":claimed.principal,"expiresAt":instant(claimed.expires_at)?,"usesRemaining":claimed.uses_remaining});
    Ok(receipt)
}
#[cfg(test)]
#[path = "request_tests.rs"]
mod tests;
