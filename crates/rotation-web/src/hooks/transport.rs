//! The hosted transport: every verb of the tool boundary, bracketed.
//!
//! [`HookedTransport`] is a decorator. It implements [`BrowserTransport`] and,
//! when its inner transport can capture, [`CeremonyTransport`], so it drops in
//! wherever a transport goes — `run_change_password`, `run_capture_steps`, or
//! a relay serving a remote agent's tool calls — without either ordering
//! function changing. The verbs' shapes are unchanged too: a refused verb
//! answers [`StepError::Refused`] (inside [`CaptureError::Step`] for a
//! capture), the same way any failed step does, so the executors' fail-closed
//! handling of a failed step is what handles a refused one.

use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use opensesame_ceremony::{CaptureDigest, Slot};
use opensesame_session_observe::MaskManifest;

use super::args::{
    CaptureDownloadArgs, CaptureFieldArgs, MaskArgs, NoArgs, PlacedRefArgs, RefArgs, SelectorArgs,
    UrlArgs,
};
use super::session::HookSession;
use super::verbs::{
    AssertPresent, CaptureCredential, CaptureDownload, FillCredential, Navigate, Outstanding,
    ReadDom, Screenshot, Submit, VerifyLogin, WaitFor,
};
use crate::ceremony::{CaptureError, CeremonyTransport};
use crate::tools::{
    AdmittedFrame, BrowserTransport, CredentialRef, Filled, Presence, RedactedDom, StepError,
    Verified,
};

/// The rotation surface's verb names — `agent_init.tools_registered` for a
/// run that only drives (ADR 0076 §1).
pub const BROWSER_VERBS: [&str; 8] = [
    "navigate",
    "wait_for",
    "fill_credential",
    "assert_present",
    "submit",
    "read_dom_redacted",
    "screenshot_redacted",
    "verify_login",
];

/// The capture verbs a ceremony adds (ADR 0082 §3).
pub const CEREMONY_VERBS: [&str; 3] = ["outstanding", "capture_credential", "capture_download"];

/// A transport whose every verb is an agent-hooks tool call.
pub struct HookedTransport<T> {
    inner: T,
    session: HookSession,
    ledger_refused: AtomicBool,
}

impl<T> HookedTransport<T> {
    /// Wrap `inner`; every verb emits through `session`.
    #[must_use]
    pub const fn new(inner: T, session: HookSession) -> Self {
        Self {
            inner,
            session,
            ledger_refused: AtomicBool::new(false),
        }
    }

    /// Whether a hook refused an `outstanding()` ledger read. That verb
    /// cannot return an error, so it answers every slot; this is how a run
    /// learns the answer was a refusal and not the ledger.
    #[must_use]
    pub fn ledger_refused(&self) -> bool {
        self.ledger_refused.load(Ordering::SeqCst)
    }

    /// The session the verbs emit through — for its records and refusals.
    #[must_use]
    pub const fn session(&self) -> &HookSession {
        &self.session
    }

    /// The wrapped transport.
    #[must_use]
    pub const fn inner(&self) -> &T {
        &self.inner
    }

    /// Take the transport and session apart once the run is over.
    #[must_use]
    pub fn into_parts(self) -> (T, HookSession) {
        (self.inner, self.session)
    }
}

#[async_trait]
impl<T: BrowserTransport> BrowserTransport for HookedTransport<T> {
    async fn navigate(&self, url: &str) -> Result<(), StepError> {
        let inner = &self.inner;
        let args = UrlArgs {
            url: url.to_owned(),
        };
        self.session
            .tool::<Navigate, _, _>(args, |a| async move { inner.navigate(&a.url).await })
            .await
    }

    async fn wait_for(&self, selector: &str) -> Result<(), StepError> {
        let inner = &self.inner;
        let args = SelectorArgs {
            selector: selector.to_owned(),
        };
        self.session
            .tool::<WaitFor, _, _>(args, |a| async move { inner.wait_for(&a.selector).await })
            .await
    }

    async fn fill_credential(
        &self,
        reference: &CredentialRef,
        selector: &str,
    ) -> Result<Filled, StepError> {
        let inner = &self.inner;
        let args = PlacedRefArgs {
            reference: reference.clone(),
            selector: selector.to_owned(),
        };
        self.session
            .tool::<FillCredential, _, _>(args, |a| async move {
                inner.fill_credential(&a.reference, &a.selector).await
            })
            .await
    }

    async fn assert_present(
        &self,
        reference: &CredentialRef,
        selector: &str,
    ) -> Result<Presence, StepError> {
        let inner = &self.inner;
        let args = PlacedRefArgs {
            reference: reference.clone(),
            selector: selector.to_owned(),
        };
        self.session
            .tool::<AssertPresent, _, _>(args, |a| async move {
                inner.assert_present(&a.reference, &a.selector).await
            })
            .await
    }

    async fn submit(&self, selector: &str) -> Result<(), StepError> {
        let inner = &self.inner;
        let args = SelectorArgs {
            selector: selector.to_owned(),
        };
        self.session
            .tool::<Submit, _, _>(args, |a| async move { inner.submit(&a.selector).await })
            .await
    }

    async fn read_dom_redacted(&self) -> Result<RedactedDom, StepError> {
        let inner = &self.inner;
        self.session
            .tool::<ReadDom, _, _>(
                NoArgs {},
                |_| async move { inner.read_dom_redacted().await },
            )
            .await
    }

    async fn screenshot_redacted(
        &self,
        mask: MaskManifest,
    ) -> Result<Option<AdmittedFrame>, StepError> {
        let inner = &self.inner;
        self.session
            .tool::<Screenshot, _, _>(MaskArgs { mask }, |a| async move {
                inner.screenshot_redacted(a.mask).await
            })
            .await
    }

    async fn verify_login(&self, reference: &CredentialRef) -> Result<Verified, StepError> {
        let inner = &self.inner;
        let args = RefArgs {
            reference: reference.clone(),
        };
        self.session
            .tool::<VerifyLogin, _, _>(
                args,
                |a| async move { inner.verify_login(&a.reference).await },
            )
            .await
    }
}

#[async_trait]
impl<T: CeremonyTransport> CeremonyTransport for HookedTransport<T> {
    async fn outstanding(&self) -> Vec<Slot> {
        let inner = &self.inner;
        let answer = self
            .session
            .bracket::<Outstanding, _, _>(NoArgs {}, |_| async move { inner.outstanding().await })
            .await;
        answer.unwrap_or_else(|| {
            self.ledger_refused.store(true, Ordering::SeqCst);
            Slot::ALL.to_vec()
        })
    }

    async fn capture_credential(
        &self,
        slot: Slot,
        selector: &str,
    ) -> Result<CaptureDigest, CaptureError> {
        let inner = &self.inner;
        let args = CaptureFieldArgs {
            slot,
            selector: selector.to_owned(),
        };
        self.session
            .tool::<CaptureCredential, _, _>(args, |a| async move {
                inner.capture_credential(a.slot, &a.selector).await
            })
            .await
    }

    async fn capture_download(
        &self,
        slot: Slot,
        content_type: &str,
    ) -> Result<CaptureDigest, CaptureError> {
        let inner = &self.inner;
        let args = CaptureDownloadArgs {
            slot,
            content_type: content_type.to_owned(),
        };
        self.session
            .tool::<CaptureDownload, _, _>(args, |a| async move {
                inner.capture_download(a.slot, &a.content_type).await
            })
            .await
    }
}
