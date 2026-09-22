//! The live callout stack: pinned nats-server (TLS client listener,
//! config-mode auth callout) → in-process bridge (nkey user in the AUTH
//! account) → mock Host on a `SecureListener` that requires the bridge's
//! client certificate.
//!
//! Everything is disposable: keys are generated per run, files live under a
//! `TempDir`, and both processes/tasks are stopped by [`Stack::stop`].

pub mod host;
pub mod pki;
pub mod server;
pub mod tokens;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use opensesame_nats_callout::bridge::{run, BridgeCore};
use opensesame_nats_callout::host_client::HttpHost;
use opensesame_nats_callout::response::ResponseSigner;
use opensesame_transport_security::{
    client_config, Generation, SecureListener, ServerProfile, TransportGenerations,
};

pub use host::{HostPins, MockHost};
pub use tokens::{FORGED_TOKEN, GOOD_TOKEN, SHORT_TOKEN};

use opensesame_domain::transport::{TransportPolicy, TrustProfileRef};

/// Events a client saw, newest last.
pub type EventLog = Arc<Mutex<Vec<String>>>;

pub struct Stack {
    _dir: tempfile::TempDir,
    pki: pki::Pki,
    nats: server::NatsServer,
    pub host: Arc<MockHost>,
    host_url: url::Url,
    account_seed: String,
    shutdown: tokio::sync::oneshot::Sender<()>,
    bridge: tokio::task::JoinHandle<()>,
}

impl Stack {
    /// Start every component and wait until the bridge is serving.
    ///
    /// # Panics
    ///
    /// When any component fails to start.
    pub async fn start() -> Self {
        let dir = opensesame_transport_security::testkit::tempdir();
        let pki = pki::Pki::generate(dir.path());
        let account = nkeys::KeyPair::new_account();
        let account_seed = account.seed().expect("account seed");
        let bridge_user = nkeys::KeyPair::new_user();

        let host = MockHost::new();
        let (host_url, shutdown) = start_host(&pki, Arc::clone(&host)).await;

        let nats = server::NatsServer::start(
            dir.path(),
            &pki,
            &account.public_key(),
            &bridge_user.public_key(),
        );
        host.pin(HostPins {
            server_public_keys: vec![nats.server_public_key.clone()],
            callout_subject: account.public_key(),
        });

        let core = Arc::new(build_core(&pki, &account_seed, &host_url, false));
        let options = async_nats::ConnectOptions::new()
            .name("live-bridge")
            .nkey(bridge_user.seed().expect("bridge seed"))
            .require_tls(true)
            .tls_client_config(
                client_config(&pki.client_profile(pki::NATS_DNS, None)).expect("tls"),
            )
            .connection_timeout(Duration::from_secs(5))
            .retry_on_initial_connect();
        let nats_client = options
            .connect(nats.url())
            .await
            .expect("bridge connects to nats");
        let bridge = tokio::spawn(async move {
            let _ = run(nats_client, core).await;
        });
        tokio::time::sleep(Duration::from_millis(300)).await;
        Self {
            _dir: dir,
            pki,
            nats,
            host,
            host_url,
            account_seed,
            shutdown,
            bridge,
        }
    }

    /// The callout account's public key — what nats-server puts in a
    /// request's `sub` in config mode.
    ///
    /// # Panics
    ///
    /// Never: the seed was generated in this process.
    #[must_use]
    pub fn callout_account(&self) -> String {
        nkeys::KeyPair::from_seed(&self.account_seed)
            .expect("account seed")
            .public_key()
    }

    /// A bridge core wired to the mock Host with the bridge's certificate.
    ///
    /// # Panics
    ///
    /// When the client cannot be built.
    #[must_use]
    pub fn bridge_core(&self) -> BridgeCore {
        build_core(&self.pki, &self.account_seed, &self.host_url, false)
    }

    /// The same core with an unrelated worker certificate — the Host must
    /// refuse it (AT-CALLOUT-BRIDGE).
    ///
    /// # Panics
    ///
    /// When the client cannot be built.
    #[must_use]
    pub fn bridge_core_with_worker_certificate(&self) -> BridgeCore {
        build_core(&self.pki, &self.account_seed, &self.host_url, true)
    }

    /// Connect an application client presenting `token`.
    ///
    /// # Errors
    ///
    /// The connection error when the server refuses the CONNECT.
    pub async fn app_client(
        &self,
        token: &str,
    ) -> Result<(async_nats::Client, EventLog), async_nats::ConnectError> {
        let log: EventLog = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&log);
        let options = async_nats::ConnectOptions::new()
            .name("live-app")
            .token(token.to_owned())
            .require_tls(true)
            .tls_client_config(
                client_config(&self.pki.client_profile(pki::NATS_DNS, None)).expect("tls"),
            )
            .connection_timeout(Duration::from_secs(5))
            .event_callback(move |event| {
                let sink = Arc::clone(&sink);
                async move {
                    sink.lock().expect("events").push(event.to_string());
                }
            });
        let client = options.connect(self.nats.url()).await?;
        Ok((client, log))
    }

    /// Stop the bridge, the mock Host and nats-server.
    pub async fn stop(mut self) {
        self.bridge.abort();
        let _ = self.shutdown.send(());
        self.nats.stop();
    }
}

fn build_core(
    pki: &pki::Pki,
    account_seed: &str,
    host_url: &url::Url,
    worker_certificate: bool,
) -> BridgeCore {
    let profile = if worker_certificate {
        pki.worker_to_host()
    } else {
        pki.bridge_to_host()
    };
    BridgeCore {
        signer: ResponseSigner::from_seed(account_seed, 300).expect("signer"),
        server_public_keys: vec![],
        xkey: None,
        target_account: server::APP_ACCOUNT.to_owned(),
        callout_subject: None,
        source: Arc::new(HttpHost::new(&profile, host_url).expect("host client")),
    }
}

async fn start_host(
    pki: &pki::Pki,
    host: Arc<MockHost>,
) -> (url::Url, tokio::sync::oneshot::Sender<()>) {
    let identity = Arc::new(pki.host_server.identity());
    let trust = pki.trust();
    let profile_name = TrustProfileRef::new(pki::CLIENT_TRUST_PROFILE).expect("profile");
    let generation = Generation {
        number: 1,
        identity: Some(Arc::clone(&identity)),
        peer_trust: [(profile_name, trust)].into_iter().collect(),
        activated_at: chrono::Utc::now(),
        withdrawn: None,
    };
    let generations = TransportGenerations::new(generation);
    let listener = SecureListener::bind(
        "127.0.0.1:0".parse().expect("addr"),
        Arc::clone(&generations),
        move |generation| {
            let identity = generation
                .identity
                .clone()
                .ok_or(opensesame_domain::transport::TransportError::IdentityMissing)?;
            let trust = generation
                .trust(&TrustProfileRef::new(pki::CLIENT_TRUST_PROFILE).expect("profile"))?
                .clone();
            let mut profile =
                ServerProfile::new(TransportPolicy::MtlsRequired, identity, "mock-host");
            profile.client_trust = Some(trust);
            Ok(profile)
        },
    )
    .await
    .expect("mock host listener");
    let addr = listener.local_addr();
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let _ = listener
            .serve_until(host::router(host), async {
                let _ = rx.await;
            })
            .await;
    });
    let url =
        url::Url::parse(&format!("https://{}:{}", pki::HOST_DNS, addr.port())).expect("host url");
    (url, tx)
}

/// Count permission-violation events, waiting briefly for `want` of them.
pub async fn wait_for_permission_violations(log: &EventLog, want: usize) -> usize {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        let seen = log
            .lock()
            .expect("events")
            .iter()
            .filter(|line| line.to_ascii_lowercase().contains("permissions violation"))
            .count();
        if seen >= want || tokio::time::Instant::now() >= deadline {
            return seen;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// True when the client reported a disconnect within `within`.
pub async fn wait_for_disconnect(log: &EventLog, within: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + within;
    loop {
        let seen = log
            .lock()
            .expect("events")
            .iter()
            .any(|line| line.contains("disconnected"));
        if seen || tokio::time::Instant::now() >= deadline {
            return seen;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}
