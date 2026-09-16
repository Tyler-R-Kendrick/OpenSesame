//! Shared scaffolding for the guest tests.
//!
//! Deliberately thin. The broker records what it was asked and answers with
//! fixed bytes; it does not simulate policy, because the tests are about the
//! sandbox's boundary rather than about any particular broker's judgement.

#![allow(dead_code)]

use std::sync::{Arc, Mutex};

use chrono::Utc;
use opensesame_sandbox::fixtures::single_chain;
use opensesame_sandbox::{
    Broker, Refusal, RevocationFence, RevocationLedger, RunContext, Sandbox, SandboxProfile,
};

/// Compile WAT to a real wasm binary.
///
/// The sandbox refuses anything that is not binary wasm, so tests cannot
/// hand it text and rely on the engine's own WAT support — which is the
/// behaviour being asserted, not an inconvenience to work around.
///
/// # Panics
///
/// Panics when the fixture itself does not assemble.
#[must_use]
pub fn wat(text: &str) -> Vec<u8> {
    wat::parse_str(text).expect("test fixture assembles")
}

/// A profile from a single grant naming `actions`.
///
/// # Panics
///
/// Panics when the fixture chain does not admit a profile.
#[must_use]
pub fn profile_with(actions: &[&str]) -> SandboxProfile {
    profile_with_budgets(actions, &[])
}

/// A profile from a single grant naming `actions` and metering `budgets`.
///
/// # Panics
///
/// Panics when the fixture chain does not admit a profile.
#[must_use]
pub fn profile_with_budgets(actions: &[&str], budgets: &[(&str, i64)]) -> SandboxProfile {
    SandboxProfile::from_grant_chain(&single_chain(actions, budgets), Utc::now())
        .expect("fixture chain admits a profile")
}

/// A sandbox over a live (never-revoked) fence.
///
/// # Panics
///
/// Panics when the engine cannot be built.
#[must_use]
pub fn sandbox_with(profile: SandboxProfile, broker: Arc<dyn Broker>) -> Sandbox {
    let ledger = RevocationLedger::at(profile.invalidation_generation());
    let fence = ledger.fence_at(profile.invalidation_generation());
    Sandbox::new(profile, broker, fence).expect("engine builds")
}

/// A sandbox over a fence the caller keeps, for revocation tests.
///
/// # Panics
///
/// Panics when the engine cannot be built.
#[must_use]
pub fn sandbox_on(
    profile: SandboxProfile,
    broker: Arc<dyn Broker>,
    fence: RevocationFence,
) -> Sandbox {
    Sandbox::new(profile, broker, fence).expect("engine builds")
}

/// Every capability granted, so a refusal in a test is never merely a
/// missing grant.
///
/// # Panics
///
/// Panics when the fixture chain does not admit a profile.
#[must_use]
pub fn permissive_sandbox() -> Sandbox {
    sandbox_with(
        profile_with(&[
            "sandbox.emit",
            "sandbox.http",
            "sandbox.sign",
            "sandbox.token",
        ]),
        Arc::new(RecordingBroker::answering(b"")),
    )
}

/// A broker that takes real wall-clock time to answer.
///
/// Time spent here burns no fuel — the guest is not executing — so this is
/// the shape of run that only a deadline can bound.
#[derive(Debug)]
pub struct StallingBroker {
    delay: std::time::Duration,
}

impl StallingBroker {
    /// A broker that sleeps `delay` on every fetch.
    #[must_use]
    pub const fn for_(delay: std::time::Duration) -> Self {
        Self { delay }
    }
}

impl Broker for StallingBroker {
    fn emit(&self, _run: &RunContext, _bytes: &[u8]) -> Result<(), Refusal> {
        Ok(())
    }

    fn http_fetch(&self, _run: &RunContext, _destination: &str) -> Result<Vec<u8>, Refusal> {
        std::thread::sleep(self.delay);
        Ok(Vec::new())
    }

    fn sign(&self, _run: &RunContext, _purpose: &str, _digest: &[u8]) -> Result<Vec<u8>, Refusal> {
        Ok(Vec::new())
    }

    fn token_acquire(&self, _run: &RunContext, _scope: &str) -> Result<u32, Refusal> {
        Ok(1)
    }
}

/// A broker that answers with fixed bytes and remembers what it was asked.
#[derive(Debug)]
pub struct RecordingBroker {
    answer: Vec<u8>,
    seen: Mutex<Seen>,
}

#[derive(Debug, Default)]
struct Seen {
    fetched: Vec<String>,
    emitted: Vec<Vec<u8>>,
    signed: Vec<String>,
    scopes: Vec<String>,
}

impl RecordingBroker {
    /// A broker whose every answer is `answer`.
    #[must_use]
    pub fn answering(answer: &[u8]) -> Self {
        Self {
            answer: answer.to_vec(),
            seen: Mutex::new(Seen::default()),
        }
    }

    /// Destinations the guest asked for.
    ///
    /// # Panics
    ///
    /// Panics if the recording lock was poisoned by a failing test.
    #[must_use]
    pub fn fetched(&self) -> Vec<String> {
        self.seen.lock().expect("broker lock").fetched.clone()
    }

    /// Payloads the guest emitted.
    ///
    /// # Panics
    ///
    /// Panics if the recording lock was poisoned by a failing test.
    #[must_use]
    pub fn emitted(&self) -> Vec<Vec<u8>> {
        self.seen.lock().expect("broker lock").emitted.clone()
    }

    /// Purposes the guest asked to sign for.
    ///
    /// # Panics
    ///
    /// Panics if the recording lock was poisoned by a failing test.
    #[must_use]
    pub fn signed(&self) -> Vec<String> {
        self.seen.lock().expect("broker lock").signed.clone()
    }

    /// Scopes the guest asked tokens for.
    ///
    /// # Panics
    ///
    /// Panics if the recording lock was poisoned by a failing test.
    #[must_use]
    pub fn scopes(&self) -> Vec<String> {
        self.seen.lock().expect("broker lock").scopes.clone()
    }
}

impl Broker for RecordingBroker {
    fn emit(&self, _run: &RunContext, bytes: &[u8]) -> Result<(), Refusal> {
        self.seen
            .lock()
            .expect("broker lock")
            .emitted
            .push(bytes.to_vec());
        Ok(())
    }

    fn http_fetch(&self, _run: &RunContext, destination: &str) -> Result<Vec<u8>, Refusal> {
        self.seen
            .lock()
            .expect("broker lock")
            .fetched
            .push(destination.to_owned());
        Ok(self.answer.clone())
    }

    fn sign(&self, _run: &RunContext, purpose: &str, _digest: &[u8]) -> Result<Vec<u8>, Refusal> {
        self.seen
            .lock()
            .expect("broker lock")
            .signed
            .push(purpose.to_owned());
        Ok(self.answer.clone())
    }

    fn token_acquire(&self, _run: &RunContext, scope: &str) -> Result<u32, Refusal> {
        let mut seen = self.seen.lock().expect("broker lock");
        seen.scopes.push(scope.to_owned());
        Ok(u32::try_from(seen.scopes.len()).unwrap_or(u32::MAX))
    }
}
