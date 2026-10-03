//! What the embedder plugs in: where credentials come from, where refusals and
//! receipts go, and what time it is.
//!
//! The proxy owns none of these. The daemon supplies the token source it
//! already runs under its scrubbed-environment discipline, converts each
//! refusal into a `SecurityNotice` on ADR 0080's feed, and keeps receipts
//! where its other brokered calls keep theirs. Tests supply fakes.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use opensesame_invoke_through::{Admission, ReceiptMeta, Refusal, TokenSource};

/// Receives every surrogate refusal. A refusal is a tripwire (ADR 0150 §5): it
/// names the run, the provider and the fence, and never the surrogate, so an
/// implementation may publish it anywhere a security notice may go.
///
/// Called on the request path; an implementation that does I/O should hand
/// the refusal to a queue rather than block.
pub trait RefusalSink: Send + Sync {
    fn refused(&self, refusal: &Refusal);

    /// A refused login-form surrogate (ADR 0150 §6.3). The default drops it;
    /// an embedder that publishes notices publishes these beside the rest.
    fn login_refused(&self, refusal: &LoginRefusal<'_>) {
        let _ = refusal;
    }
}

/// A login-form surrogate refused at the proxy: the `surrogate.*` code, the
/// run, and the detail `opensesame-rotation-web` already defanged. `Debug`
/// says whether a detail is present, never its text.
#[derive(Clone, Copy)]
pub struct LoginRefusal<'a> {
    pub code: &'a str,
    pub run_id: &'a str,
    pub detail: Option<&'a str>,
}

impl std::fmt::Debug for LoginRefusal<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoginRefusal")
            .field("code", &self.code)
            .field("run_id", &self.run_id)
            .field("detail", &self.detail.is_some())
            .finish()
    }
}

/// Receives the receipt of every brokered call. Optional: the proxy works
/// without one, but the daemon records these beside its other invoke-through
/// receipts.
pub trait ReceiptSink: Send + Sync {
    fn brokered(&self, admission: &Admission, receipt: &ReceiptMeta);
}

/// The time admission and expiry are judged by.
pub trait Clock: Send + Sync {
    fn now_unix(&self) -> u64;
}

/// Wall-clock time.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_unix(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_secs())
    }
}

/// Picks the credential source for an admitted request. Keyed on the
/// admission, so an embedder may answer per connection as well as per
/// provider; [`ProviderSources`] is the per-provider table.
pub trait TokenSources: Send + Sync {
    fn source_for(&self, admission: &Admission) -> Option<Arc<dyn TokenSource>>;
}

/// One token source per provider id.
#[derive(Default, Clone)]
pub struct ProviderSources {
    by_provider: HashMap<String, Arc<dyn TokenSource>>,
}

impl std::fmt::Debug for ProviderSources {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut providers: Vec<&String> = self.by_provider.keys().collect();
        providers.sort();
        f.debug_struct("ProviderSources")
            .field("providers", &providers)
            .finish()
    }
}

impl ProviderSources {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Serve `provider_id`'s admitted requests from `source`.
    #[must_use]
    pub fn with(mut self, provider_id: &str, source: Arc<dyn TokenSource>) -> Self {
        self.by_provider.insert(provider_id.to_owned(), source);
        self
    }
}

impl TokenSources for ProviderSources {
    fn source_for(&self, admission: &Admission) -> Option<Arc<dyn TokenSource>> {
        self.by_provider.get(&admission.provider_id).cloned()
    }
}
