//! The proxy's configuration and the state every run shares.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::Duration;

use opensesame_invoke_through::{Admission, Invoker, Refusal, RequestView, SurrogateLedger};
use opensesame_plugin_settings::PluginState;

use crate::login::RunLogins;
use crate::passthrough::PassthroughClient;
use crate::ports::{Clock, ReceiptSink, RefusalSink, SystemClock, TokenSources};
use crate::tripwire::{RunObserver, RunWatch};

/// How long a run's CA and its leaves stay valid. A run that outlives it
/// fails closed: its child's handshakes start failing, nothing downgrades.
pub const DEFAULT_CA_VALIDITY: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// How many credential-tool runs (`gh auth token`, …) one run may have going
/// at once. A child that opens many tunnels and fires admitted requests
/// queues behind these; it cannot spawn a process per request.
pub const DEFAULT_MAX_CONCURRENT_ACQUISITIONS: usize = 4;

/// How long an admitted request waits for one of those slots before the
/// client is told to slow down.
pub const ACQUIRE_WAIT: Duration = Duration::from_secs(5);

/// Everything the registry needs from its embedder.
pub struct ProxyConfig {
    pub(crate) invoker: Arc<Invoker>,
    pub(crate) sources: Arc<dyn TokenSources>,
    pub(crate) refusals: Arc<dyn RefusalSink>,
    pub(crate) receipts: Option<Arc<dyn ReceiptSink>>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) passthrough: PassthroughClient,
    pub(crate) ca_validity: Duration,
    pub(crate) observer: Option<Arc<dyn RunObserver>>,
    /// The plugin switch login substitution shares (ADR 0150 §7). `None`
    /// arms no login: a declared one is refused at run start.
    pub(crate) login_switch: Option<PluginState>,
    /// Concurrent credential acquisitions per run.
    pub(crate) max_concurrent_acquisitions: usize,
    /// How long a request waits for an acquisition slot.
    pub(crate) acquire_wait: Duration,
}

impl std::fmt::Debug for ProxyConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProxyConfig")
            .field("receipts", &self.receipts.is_some())
            .field("ca_validity", &self.ca_validity)
            .field("observer", &self.observer.is_some())
            .field("login_switch", &self.login_switch.is_some())
            .finish_non_exhaustive()
    }
}

impl ProxyConfig {
    /// The broker the proxy admits into, the credential sources it draws
    /// from, and where refusals go. The ledger serves exactly the invoker's
    /// egress rules, so admission and the invoker's own fence can never
    /// disagree about which hosts a provider has.
    #[must_use]
    pub fn new(
        invoker: Arc<Invoker>,
        sources: Arc<dyn TokenSources>,
        refusals: Arc<dyn RefusalSink>,
    ) -> Self {
        Self {
            invoker,
            sources,
            refusals,
            receipts: None,
            clock: Arc::new(SystemClock),
            passthrough: PassthroughClient::webpki(),
            ca_validity: DEFAULT_CA_VALIDITY,
            observer: None,
            login_switch: None,
            max_concurrent_acquisitions: DEFAULT_MAX_CONCURRENT_ACQUISITIONS,
            acquire_wait: ACQUIRE_WAIT,
        }
    }

    /// Cap concurrent credential acquisitions per run (at least one), and
    /// how long a request waits for a slot.
    #[must_use]
    pub fn with_acquisition_limit(mut self, concurrent: usize, wait: Duration) -> Self {
        self.max_concurrent_acquisitions = concurrent.max(1);
        self.acquire_wait = wait;
        self
    }

    /// Who hears that a tripwire revoked a run, and how each login went.
    #[must_use]
    pub fn with_observer(mut self, observer: Arc<dyn RunObserver>) -> Self {
        self.observer = Some(observer);
        self
    }

    /// The `surrogate-proxy` plugin's state, which alone arms a declared
    /// login substitution (`LoginRoad::choose`).
    #[must_use]
    pub fn with_login_switch(mut self, state: PluginState) -> Self {
        self.login_switch = Some(state);
        self
    }

    #[must_use]
    pub fn with_receipts(mut self, receipts: Arc<dyn ReceiptSink>) -> Self {
        self.receipts = Some(receipts);
        self
    }

    #[must_use]
    pub fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = clock;
        self
    }

    /// The client used for a run's passthrough hosts (never for brokered
    /// calls, which go through the invoker).
    #[must_use]
    pub fn with_passthrough_client(mut self, client: PassthroughClient) -> Self {
        self.passthrough = client;
        self
    }

    #[must_use]
    pub fn with_ca_validity(mut self, validity: Duration) -> Self {
        self.ca_validity = validity;
        self
    }
}

/// The ledger and configuration every run's listener reads, and each run's
/// lease and login desks, which the tripwire revokes through.
pub(crate) struct Shared {
    pub(crate) ledger: RwLock<SurrogateLedger>,
    pub(crate) config: ProxyConfig,
    pub(crate) watches: Mutex<HashMap<String, RunWatch>>,
    pub(crate) logins: Mutex<HashMap<String, Arc<RunLogins>>>,
}

impl Shared {
    pub(crate) fn new(config: ProxyConfig) -> Self {
        let rules = config.invoker.fence().rules().to_vec();
        Self {
            ledger: RwLock::new(SurrogateLedger::new(rules)),
            config,
            watches: Mutex::new(HashMap::new()),
            logins: Mutex::new(HashMap::new()),
        }
    }

    /// The run's login desks, if it declared any.
    pub(crate) fn logins_of(&self, run_id: &str) -> Option<Arc<RunLogins>> {
        self.logins
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(run_id)
            .cloned()
    }

    /// Admit one request for `caller` at the configured clock's now.
    pub(crate) fn admit(
        &self,
        view: &RequestView<'_>,
        caller: &str,
    ) -> Result<Option<Admission>, Refusal> {
        let now = self.config.clock.now_unix();
        let ledger = self.ledger.read().unwrap_or_else(PoisonError::into_inner);
        ledger.admit(view, caller, now)
    }
}
