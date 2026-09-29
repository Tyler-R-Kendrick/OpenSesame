//! The proxy's configuration and the state every run shares.

use std::sync::{Arc, PoisonError, RwLock};
use std::time::Duration;

use opensesame_invoke_through::{Admission, Invoker, Refusal, RequestView, SurrogateLedger};

use crate::passthrough::PassthroughClient;
use crate::ports::{Clock, ReceiptSink, RefusalSink, SystemClock, TokenSources};

/// How long a run's CA and its leaves stay valid. A run that outlives it
/// fails closed: its child's handshakes start failing, nothing downgrades.
pub const DEFAULT_CA_VALIDITY: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Everything the registry needs from its embedder.
pub struct ProxyConfig {
    pub(crate) invoker: Arc<Invoker>,
    pub(crate) sources: Arc<dyn TokenSources>,
    pub(crate) refusals: Arc<dyn RefusalSink>,
    pub(crate) receipts: Option<Arc<dyn ReceiptSink>>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) passthrough: PassthroughClient,
    pub(crate) ca_validity: Duration,
}

impl std::fmt::Debug for ProxyConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProxyConfig")
            .field("receipts", &self.receipts.is_some())
            .field("ca_validity", &self.ca_validity)
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
        }
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

/// The ledger and configuration every run's listener reads.
pub(crate) struct Shared {
    pub(crate) ledger: RwLock<SurrogateLedger>,
    pub(crate) config: ProxyConfig,
}

impl Shared {
    pub(crate) fn new(config: ProxyConfig) -> Self {
        let rules = config.invoker.fence().rules().to_vec();
        Self {
            ledger: RwLock::new(SurrogateLedger::new(rules)),
            config,
        }
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
