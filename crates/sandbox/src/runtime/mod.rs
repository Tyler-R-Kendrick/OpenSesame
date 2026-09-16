//! SBOX-SPAWN — one run, on a real engine, inside a real fence.
//!
//! A [`Sandbox`] holds an engine, a profile, and a broker. Every call to
//! [`Sandbox::spawn`] builds a **fresh store**: new linear memory, new
//! state, new fuel, new deadline. Nothing survives a run, so nothing can be
//! left behind for the next one.
//!
//! The order of checks in `spawn` is the contract:
//!
//! 1. the revocation fence, before any work at all;
//! 2. the payload's format — a native binary is refused here, and refusing
//!    is the whole answer, because "run it some other way" would step
//!    outside every boundary this crate has;
//! 3. the import audit, which is what makes ambient authority impossible
//!    rather than merely unlikely;
//! 4. fuel, deadline, and memory, set on the store before the guest runs a
//!    single instruction.

mod imports;
mod limits;
mod state;

use std::sync::Arc;

use wasmtime::{Config, Engine, ExternType, Linker, Module, Store, Trap};

use crate::boundary::{audit_import, Broker, ImportKind, RunContext};
use crate::capability::ENTRY_POINT;
use crate::error::SandboxError;
use crate::format::GuestFormat;
use crate::profile::SandboxProfile;
use crate::revoke::RevocationFence;

use self::limits::{deadline_ticks, EpochTicker, GuestLimiter};
use self::state::GuestState;

pub use self::state::RunOutcome;

/// A configured sandbox: one profile, one broker, one revocation fence.
pub struct Sandbox {
    engine: Engine,
    profile: SandboxProfile,
    broker: Arc<dyn Broker>,
    fence: RevocationFence,
    _ticker: EpochTicker,
}

/// Stops a run that is already executing.
///
/// Cloneable and `Send`, so the thread that learns about a revocation is
/// never the thread that has to be running the guest.
#[derive(Clone)]
pub struct KillSwitch {
    engine: Engine,
    fence: RevocationFence,
    ticks: u64,
}

impl KillSwitch {
    /// Close the boundary and trap the guest wherever it is.
    ///
    /// Both halves matter: the fence stops brokered calls from doing any
    /// more work, and the epoch bump stops a guest that makes no calls at
    /// all — a bare loop would otherwise run until its fuel ran out.
    pub fn kill(&self) {
        self.fence.kill();
        for _ in 0..=self.ticks {
            self.engine.increment_epoch();
        }
    }

    /// Whether the run this switch controls is still authorized.
    #[must_use]
    pub fn is_live(&self) -> bool {
        self.fence.is_live()
    }
}

impl Sandbox {
    /// Build a sandbox for one profile.
    ///
    /// # Errors
    ///
    /// Returns [`SandboxError::Runtime`] when the engine cannot be built
    /// with fuel metering and epoch interruption — without both, the
    /// profile's budget would be decorative, so failing here is correct.
    pub fn new(
        profile: SandboxProfile,
        broker: Arc<dyn Broker>,
        fence: RevocationFence,
    ) -> Result<Self, SandboxError> {
        let mut config = Config::new();
        config.consume_fuel(true);
        config.epoch_interruption(true);
        // Threads and shared memory are absent from the workspace's Wasmtime
        // feature set, so there is no `wasm_threads` knob to turn off here —
        // a shared memory would sit outside the per-store limiter that
        // enforces this profile's memory cap, and none can be created.
        let engine =
            Engine::new(&config).map_err(|e| SandboxError::Runtime(format!("engine: {e}")))?;
        let ticker = EpochTicker::spawn(&engine);
        Ok(Self {
            engine,
            profile,
            broker,
            fence,
            _ticker: ticker,
        })
    }

    /// The profile this sandbox enforces.
    #[must_use]
    pub const fn profile(&self) -> &SandboxProfile {
        &self.profile
    }

    /// A handle that can stop a run from another thread.
    #[must_use]
    pub fn kill_switch(&self) -> KillSwitch {
        KillSwitch {
            engine: self.engine.clone(),
            fence: self.fence.clone(),
            ticks: deadline_ticks(self.profile.budget().deadline()),
        }
    }

    /// Compile and run a guest payload to completion.
    ///
    /// # Errors
    ///
    /// Returns [`SandboxError::UnsupportedPayload`] for anything that is not
    /// a wasm core module, [`SandboxError::AmbientImport`] or a sibling for
    /// a guest that asks for more than the profile grants,
    /// [`SandboxError::Revoked`] when authority is gone, and the budget
    /// stops — [`SandboxError::FuelExhausted`],
    /// [`SandboxError::DeadlineExceeded`], [`SandboxError::MemoryLimit`] —
    /// when the run outgrows its profile.
    pub fn spawn(&self, guest: &[u8]) -> Result<RunOutcome, SandboxError> {
        self.fence.check()?;
        let format = GuestFormat::detect(guest);
        if !format.is_runnable() {
            return Err(SandboxError::unsupported(format));
        }
        let module = Module::new(&self.engine, guest)
            .map_err(|e| SandboxError::Runtime(format!("compile: {e}")))?;
        self.audit(&module)?;

        let mut linker: Linker<GuestState> = Linker::new(&self.engine);
        imports::define(&mut linker, self.profile.capabilities())?;
        let mut store = self.fresh_store();
        let instance = linker
            .instantiate(&mut store, &module)
            .map_err(|e| Self::map_instantiation_error(&mut store, &e))?;
        let entry = instance
            .get_typed_func::<(), i32>(&mut store, ENTRY_POINT)
            .map_err(|_| SandboxError::MissingEntryPoint(ENTRY_POINT))?;

        // Re-check immediately before the guest executes. Compiling and
        // instantiating a module takes real time, and a kill that lands in
        // that window bumps an epoch the store has not been armed against
        // yet — so without this check the guest would start anyway and run
        // until some other limit stopped it.
        self.fence.check()?;

        let called = entry.call(&mut store, ());
        let fuel_used = self
            .profile
            .budget()
            .fuel()
            .saturating_sub(store.get_fuel().unwrap_or(0));
        let status = called.map_err(|e| self.map_guest_error(&mut store, &e))?;
        let data = store.into_data();
        Ok(RunOutcome {
            status,
            emitted: data.emitted,
            fuel_used,
            broker_calls: data.broker_calls,
        })
    }

    /// Refuse a guest whose declared imports exceed the profile.
    fn audit(&self, module: &Module) -> Result<(), SandboxError> {
        for import in module.imports() {
            let kind = match import.ty() {
                ExternType::Func(_) => ImportKind::Function,
                ExternType::Memory(_) => ImportKind::Memory,
                ExternType::Table(_) => ImportKind::Table,
                ExternType::Global(_) => ImportKind::Global,
                ExternType::Tag(_) => ImportKind::Tag,
            };
            audit_import(
                import.module(),
                import.name(),
                kind,
                self.profile.capabilities(),
            )?;
        }
        Ok(())
    }

    fn fresh_store(&self) -> Store<GuestState> {
        let budget = self.profile.budget();
        let state = GuestState {
            limiter: GuestLimiter::new(budget.max_memory_bytes(), MAX_TABLE_ELEMENTS),
            profile: self.profile.clone(),
            broker: Arc::clone(&self.broker),
            fence: self.fence.clone(),
            run: RunContext {
                organization_id: self.profile.organization_id(),
                leaf_grant_id: self.profile.leaf_grant_id(),
                root_grant_id: self.profile.root_grant_id(),
            },
            emitted: Vec::new(),
            broker_calls: 0,
        };
        let mut store = Store::new(&self.engine, state);
        store.limiter(|s| &mut s.limiter);
        // Both are infallible on an engine configured above; a failure here
        // would mean the config silently changed, so report it rather than
        // running unmetered.
        if store.set_fuel(budget.fuel()).is_err() {
            store.set_fuel(0).ok();
        }
        store.set_epoch_deadline(deadline_ticks(budget.deadline()));
        store
    }

    fn map_instantiation_error(
        store: &mut Store<GuestState>,
        error: &wasmtime::Error,
    ) -> SandboxError {
        if store.data().limiter.hit_a_limit() {
            return SandboxError::MemoryLimit;
        }
        SandboxError::Runtime(format!("instantiate: {error}"))
    }

    fn map_guest_error(
        &self,
        store: &mut Store<GuestState>,
        error: &wasmtime::Error,
    ) -> SandboxError {
        // A shim that stopped the run carries its own reason; prefer it.
        if let Some(inner) = error.downcast_ref::<SandboxError>() {
            return clone_error(inner);
        }
        // Revocation outranks every other explanation. A run whose authority
        // is gone must not be reported as merely out of fuel or past its
        // deadline: those read as "give it a bigger budget", and this one
        // must never be retried. The ordering also covers the window where a
        // kill lands while the guest is still executing under a budget the
        // epoch bump could not reach.
        if let Err(revoked) = self.fence.check() {
            return revoked;
        }
        if store.data().limiter.hit_a_limit() {
            return SandboxError::MemoryLimit;
        }
        match error.downcast_ref::<Trap>() {
            Some(Trap::OutOfFuel) => SandboxError::FuelExhausted,
            Some(Trap::Interrupt) => SandboxError::DeadlineExceeded,
            Some(other) => SandboxError::Trap(other.to_string()),
            None => SandboxError::Trap(error.to_string()),
        }
    }
}

/// Cap on table elements; the profile meters memory and fuel, and a guest
/// has no reason to need a large indirect-call table.
const MAX_TABLE_ELEMENTS: usize = 10_000;

/// `SandboxError` is not `Clone` (it carries no clonable payload worth the
/// derive); rebuild the variant so a borrowed error can be returned owned.
fn clone_error(error: &SandboxError) -> SandboxError {
    match error {
        SandboxError::Revoked { expected, observed } => SandboxError::Revoked {
            expected: *expected,
            observed: *observed,
        },
        SandboxError::MissingMemory => SandboxError::MissingMemory,
        other => SandboxError::Trap(other.to_string()),
    }
}
