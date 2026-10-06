//! Owner-paired sealed metadata sender; no production credentials or ambient HTTP authority.
use crate::pass_security::StoreArgs;
use clap::Subcommand;
use opensesame_sealed_store::{credential_canaries::receiver, StoreError};
use std::{
    future::Future,
    path::Path,
    pin::Pin,
    task::{Context, Poll, Waker},
    time::Duration,
};
#[derive(Debug, Subcommand)]
pub(crate) enum PassReceiverCmd {
    /// Import independently generated pairing; always starts disabled/unverified.
    Configure {
        #[arg(long)]
        provision_file: std::path::PathBuf,
        #[command(flatten)]
        store: StoreArgs,
    },
    /// Inspect redacted pairing, verified delivery and queue counts.
    Status {
        #[command(flatten)]
        store: StoreArgs,
    },
    /// Send one closed owner test and require an authenticated current-binding ACK.
    Test {
        #[command(flatten)]
        store: StoreArgs,
    },
    /// Enable only an ACK-verified receiver after fresh owner authentication.
    Enable {
        #[command(flatten)]
        store: StoreArgs,
    },
    /// Disable delivery and discard unsent sealed metadata.
    Disable {
        #[command(flatten)]
        store: StoreArgs,
    },
    /// Remove pairing and discard unsent sealed metadata.
    Remove {
        #[command(flatten)]
        store: StoreArgs,
    },
    /// Attempt at most two queued deliveries without opening the real root.
    Flush {
        #[command(flatten)]
        store: StoreArgs,
    },
}
pub(crate) async fn run(cmd: PassReceiverCmd) -> anyhow::Result<()> {
    let store = match &cmd {
        PassReceiverCmd::Configure { store, .. }
        | PassReceiverCmd::Status { store }
        | PassReceiverCmd::Test { store }
        | PassReceiverCmd::Enable { store }
        | PassReceiverCmd::Disable { store }
        | PassReceiverCmd::Remove { store }
        | PassReceiverCmd::Flush { store } => store,
    };
    if let PassReceiverCmd::Flush { .. } = cmd {
        let root = crate::pass_security::root(store)?;
        let mut delivered = 0;
        for _ in 0..2 {
            if !deliver(&root, None, false).await? {
                break;
            }
            delivered += 1;
        }
        let status = receiver::outbox_status(&root)?;
        println!(
            "{}",
            serde_json::json!({"delivered":delivered,"queued":status["queued"],"failed":status["failed"]})
        );
        return Ok(());
    }
    let (root, current) = crate::pass_security::owner(store)?;
    match cmd {
        PassReceiverCmd::Configure { provision_file, .. } => {
            let provision =
                zeroize::Zeroizing::new(crate::canary_cli::read_file(&provision_file, 8192)?);
            receiver::configure(&root, current.as_bytes(), &provision)?;
        }
        PassReceiverCmd::Status { .. } => println!(
            "{}",
            opensesame_sealed_store::credential_canaries::status(&root, current.as_bytes())?
        ),
        PassReceiverCmd::Test { .. } => {
            let id = receiver::test(&root, current.as_bytes())?;
            // The owner proof and all store edit locks are released before network I/O.
            drop(current);
            let delivered = if let Some(id) = id {
                deliver(&root, Some(&id), true).await?
            } else {
                false
            };
            println!("{}", serde_json::json!({"delivered":delivered}));
        }
        PassReceiverCmd::Enable { .. } => receiver::enable(&root, current.as_bytes(), true)?,
        PassReceiverCmd::Disable { .. } => receiver::enable(&root, current.as_bytes(), false)?,
        PassReceiverCmd::Remove { .. } => receiver::remove(&root, current.as_bytes())?,
        PassReceiverCmd::Flush { .. } => unreachable!(),
    }
    Ok(())
}
type TransportFuture =
    Pin<Box<dyn Future<Output = Result<reqwest::Response, reqwest::Error>> + Send>>;
enum Started {
    Ready(Result<reqwest::Response, reqwest::Error>),
    Pending(TransportFuture),
}
fn start(client: &reqwest::Client, destination: &str, packet: &str) -> Started {
    let mut future: TransportFuture = Box::pin(
        client
            .post(destination)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(packet.to_owned())
            .send(),
    );
    match future
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
    {
        Poll::Ready(response) => Started::Ready(response),
        Poll::Pending => Started::Pending(future),
    }
}
async fn acknowledgement(started: Started) -> anyhow::Result<String> {
    let mut response = match started {
        Started::Ready(response) => response?,
        Started::Pending(future) => future.await?,
    };
    anyhow::ensure!(
        response.status().is_success(),
        "observation receiver refused delivery"
    );
    let mut raw = Vec::new();
    while let Some(part) = response.chunk().await? {
        anyhow::ensure!(
            raw.len() + part.len() <= 2048,
            "observation ACK exceeds its bound"
        );
        raw.extend_from_slice(&part);
    }
    Ok(String::from_utf8(raw)?)
}
pub(crate) async fn deliver(
    root: &Path,
    package_id: Option<&str>,
    testing: bool,
) -> anyhow::Result<bool> {
    let Some(reservation) = receiver::reserve(root, package_id, testing)? else {
        return Ok(false);
    };
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(4))
        .build()?;
    let started = receiver::begin_dispatch(root, &reservation, |destination, packet| {
        Ok::<_, StoreError>(start(&client, destination, packet))
    })?;
    let Some(started) = started else {
        return Ok(false);
    };
    let ack = tokio::time::timeout(Duration::from_secs(4), acknowledgement(started))
        .await
        .ok()
        .and_then(Result::ok);
    Ok(receiver::finish(root, &reservation, ack.as_deref())?)
}
