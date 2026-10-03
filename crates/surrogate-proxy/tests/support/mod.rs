//! Shared harness for the surrogate-proxy suites: a real loopback TLS
//! upstream, a real invoker pinned to it, counting fakes for every port, and
//! a real proxy run on a real socket.

#![allow(dead_code)] // each suite uses a different subset

pub mod any_cert;
pub mod client;
pub mod stub;

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use opensesame_invoke_through::{
    Admission, AuthStyle, EgressRule, InvokeError, Invoker, ReceiptMeta, Refusal, RefusalCode,
    SurrogateSite, TlsClientSpec, TokenSource,
};
use opensesame_surrogate_proxy::{
    Clock, PassthroughClient, ProviderSources, ProxyConfig, ReceiptSink, RefusalSink, RunHandle,
    RunSpec, SurrogateGrant, SurrogateRuns,
};
use secrecy::SecretString;

use stub::{spawn_upstream, Upstream};

/// The real credential. It must reach the upstream and nothing else.
pub const CANARY: &str = "CANARY-gh-token-3f9a-never-in-the-child";
/// The provider host the run's surrogate is for.
pub const HOST: &str = "api.github.test";
/// A host with no surrogate rights: where an exfiltration would go.
pub const EVIL: &str = "evil.test";
/// A passthrough host with no provider rule.
pub const STATIC: &str = "static.test";

pub struct CountingSource {
    pub calls: AtomicUsize,
    /// How long one acquisition takes (a credential tool running).
    pub delay: Duration,
    /// Acquisitions running now, and the most there ever were at once.
    pub live: AtomicUsize,
    pub peak: AtomicUsize,
}

impl TokenSource for CountingSource {
    fn acquire(&self) -> Result<SecretString, InvokeError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let now = self.live.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak.fetch_max(now, Ordering::SeqCst);
        std::thread::sleep(self.delay);
        self.live.fetch_sub(1, Ordering::SeqCst);
        Ok(SecretString::from(CANARY))
    }
}

#[derive(Default)]
pub struct Refusals(pub Mutex<Vec<Refusal>>);

impl RefusalSink for Refusals {
    fn refused(&self, refusal: &Refusal) {
        self.0.lock().unwrap().push(refusal.clone());
    }
}

impl Refusals {
    pub fn codes(&self) -> Vec<RefusalCode> {
        self.0.lock().unwrap().iter().map(|r| r.code).collect()
    }
}

#[derive(Default)]
pub struct Receipts(pub Mutex<Vec<(Admission, ReceiptMeta)>>);

impl ReceiptSink for Receipts {
    fn brokered(&self, admission: &Admission, receipt: &ReceiptMeta) {
        self.0
            .lock()
            .unwrap()
            .push((admission.clone(), receipt.clone()));
    }
}

/// Starts at the real time (the child verifies the run CA against it) and
/// moves only when a test says so.
pub struct ManualClock(pub AtomicU64);

impl Clock for ManualClock {
    fn now_unix(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

impl ManualClock {
    pub fn advance(&self, by: Duration) {
        self.0.fetch_add(by.as_secs(), Ordering::SeqCst);
    }
}

pub struct Harness {
    pub upstream: Upstream,
    pub passthrough: Upstream,
    pub runs: SurrogateRuns,
    pub source: Arc<CountingSource>,
    pub refusals: Arc<Refusals>,
    pub receipts: Arc<Receipts>,
    pub clock: Arc<ManualClock>,
}

impl Harness {
    pub fn source_calls(&self) -> usize {
        self.source.calls.load(Ordering::SeqCst)
    }

    /// Start a run with one GitHub surrogate in `GITHUB_TOKEN`.
    pub fn start(&self, run_id: &str) -> RunHandle {
        self.start_with(
            run_id,
            &RunSpec {
                grants: vec![grant()],
                passthrough_hosts: vec![],
                ..RunSpec::default()
            },
        )
    }

    pub fn start_with(&self, run_id: &str, spec: &RunSpec) -> RunHandle {
        self.runs.create_run(run_id, spec).expect("run starts")
    }
}

pub fn grant() -> SurrogateGrant {
    SurrogateGrant {
        env_var: "GITHUB_TOKEN".into(),
        provider_id: "github".into(),
        connection_ref: "conn://acme/gh".into(),
        site: SurrogateSite::Authorization,
        methods: vec!["GET".into(), "POST".into()],
        path_prefixes: vec!["/".into()],
        ttl: Duration::from_secs(600),
    }
}

pub async fn harness() -> Harness {
    harness_with(Duration::ZERO, None).await
}

/// A harness whose credential tool takes `delay` per run, and whose proxy
/// allows `slots` concurrent runs of it (the default when `None`).
pub async fn harness_with(delay: Duration, slots: Option<(usize, Duration)>) -> Harness {
    let upstream = spawn_upstream(HOST).await;
    let passthrough = spawn_upstream(STATIC).await;
    let invoker = Invoker::with_tls(
        vec![EgressRule {
            provider_id: "github",
            scheme: "https",
            hosts: &[HOST],
            auth: AuthStyle::Bearer,
        }],
        &TlsClientSpec {
            config: Arc::new(upstream.client_config()),
            server_name: None,
            pinned: Some((HOST.into(), vec![upstream.addr])),
        },
    );
    let source = Arc::new(CountingSource {
        calls: AtomicUsize::new(0),
        delay,
        live: AtomicUsize::new(0),
        peak: AtomicUsize::new(0),
    });
    let refusals = Arc::new(Refusals::default());
    let receipts = Arc::new(Receipts::default());
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let clock = Arc::new(ManualClock(AtomicU64::new(now)));
    let mut config = ProxyConfig::new(
        Arc::new(invoker),
        Arc::new(ProviderSources::new().with("github", source.clone())),
        refusals.clone(),
    );
    if let Some((concurrent, wait)) = slots {
        config = config.with_acquisition_limit(concurrent, wait);
    }
    let config = config
        .with_receipts(receipts.clone())
        .with_clock(clock.clone())
        .with_passthrough_client(PassthroughClient::with_tls(
            passthrough.client_config(),
            Some((STATIC, &[passthrough.addr])),
        ));
    Harness {
        upstream,
        passthrough,
        runs: SurrogateRuns::new(config),
        source,
        refusals,
        receipts,
        clock,
    }
}
