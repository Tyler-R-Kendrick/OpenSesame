//! The brokered host functions, and the memory discipline around them.
//!
//! Each shim does the same four things in the same order, and the order is
//! the point:
//!
//! 1. check the revocation fence — a run whose authority is gone gets no
//!    further work done on its behalf, including work it already paid for;
//! 2. read the guest's arguments out of *its* memory, with every pointer
//!    bounds-checked against that memory's current length;
//! 3. ask the [`Broker`], which is the only thing here that can reach the
//!    outside world;
//! 4. write at most `out_cap` bytes back, capped again by the profile.
//!
//! A refusal is a small negative integer and nothing else. Failing to read
//! a pointer, being denied by the broker, and asking for too much are
//! distinguishable to the *host*, which logs them; to the guest they are
//! all just "no".

use std::sync::Arc;

use wasmtime::{Caller, Extern, Linker, Memory};

use crate::boundary::Refusal;
use crate::capability::{BrokeredCapability, BROKERED_MODULE, GUEST_MEMORY};
use crate::error::SandboxError;
use crate::runtime::state::GuestState;

/// Why a shim stopped: a refusal the guest may observe, or a trap that ends
/// the run.
enum ShimStop {
    /// Answered to the guest as a negative code.
    Refused(Refusal),
    /// Ends the run. Revocation and a missing memory are both host-side
    /// facts the guest has no business continuing past.
    Trap(SandboxError),
}

impl From<Refusal> for ShimStop {
    fn from(refusal: Refusal) -> Self {
        Self::Refused(refusal)
    }
}

fn finish(result: Result<i32, ShimStop>) -> wasmtime::Result<i32> {
    match result {
        Ok(value) => Ok(value),
        Err(ShimStop::Refused(refusal)) => Ok(refusal.code()),
        Err(ShimStop::Trap(error)) => Err(wasmtime::Error::new(error)),
    }
}

fn guest_memory(caller: &mut Caller<'_, GuestState>) -> Result<Memory, ShimStop> {
    caller
        .get_export(GUEST_MEMORY)
        .and_then(Extern::into_memory)
        .ok_or(ShimStop::Trap(SandboxError::MissingMemory))
}

/// Refuse before doing anything the run is no longer authorized to do.
fn still_authorized(caller: &Caller<'_, GuestState>) -> Result<(), ShimStop> {
    caller.data().fence.check().map_err(ShimStop::Trap)
}

/// Copy `len` bytes out of guest memory, bounds-checked and capped.
fn read_bytes(
    caller: &mut Caller<'_, GuestState>,
    ptr: i32,
    len: i32,
    cap: usize,
) -> Result<Vec<u8>, ShimStop> {
    let (Ok(start), Ok(length)) = (usize::try_from(ptr), usize::try_from(len)) else {
        return Err(Refusal::BadPointer.into());
    };
    if length > cap {
        return Err(Refusal::Oversized.into());
    }
    let memory = guest_memory(caller)?;
    let data = memory.data(&caller);
    let end = start
        .checked_add(length)
        .ok_or(ShimStop::from(Refusal::BadPointer))?;
    data.get(start..end)
        .map(<[u8]>::to_vec)
        .ok_or_else(|| Refusal::BadPointer.into())
}

/// Read guest bytes as UTF-8 text.
fn read_text(
    caller: &mut Caller<'_, GuestState>,
    ptr: i32,
    len: i32,
    cap: usize,
) -> Result<String, ShimStop> {
    let bytes = read_bytes(caller, ptr, len, cap)?;
    String::from_utf8(bytes).map_err(|_| Refusal::Malformed.into())
}

/// Write broker output into guest memory, returning the byte count.
fn write_bytes(
    caller: &mut Caller<'_, GuestState>,
    ptr: i32,
    cap: i32,
    bytes: &[u8],
) -> Result<i32, ShimStop> {
    let (Ok(start), Ok(capacity)) = (usize::try_from(ptr), usize::try_from(cap)) else {
        return Err(Refusal::BadPointer.into());
    };
    let ceiling = caller
        .data()
        .profile
        .budget()
        .max_broker_response_bytes()
        .min(capacity);
    if bytes.len() > ceiling {
        return Err(Refusal::Oversized.into());
    }
    let memory = guest_memory(caller)?;
    memory
        .write(&mut *caller, start, bytes)
        .map_err(|_| ShimStop::from(Refusal::BadPointer))?;
    i32::try_from(bytes.len()).map_err(|_| Refusal::Oversized.into())
}

fn emit_impl(caller: &mut Caller<'_, GuestState>, ptr: i32, len: i32) -> Result<i32, ShimStop> {
    still_authorized(caller)?;
    let cap = caller.data().profile.budget().max_emit_bytes();
    let bytes = read_bytes(caller, ptr, len, cap)?;
    caller.data_mut().count_call();
    // Check the running total before the broker is told anything. Emitting
    // in small pieces must not get a guest past the cap, and the broker
    // must not be handed bytes the host is about to discard.
    let state = caller.data_mut();
    if state.emitted.len().saturating_add(bytes.len()) > cap {
        return Err(Refusal::Oversized.into());
    }
    let run = state.run;
    let broker = Arc::clone(&state.broker);
    broker.emit(&run, &bytes)?;
    caller.data_mut().emitted.extend_from_slice(&bytes);
    Ok(0)
}

fn http_fetch_impl(
    caller: &mut Caller<'_, GuestState>,
    url: (i32, i32),
    out: (i32, i32),
) -> Result<i32, ShimStop> {
    still_authorized(caller)?;
    let destination = read_text(caller, url.0, url.1, MAX_TEXT_ARG)?;
    caller.data_mut().count_call();
    let state = caller.data();
    let run = state.run;
    let broker = Arc::clone(&state.broker);
    let body = broker.http_fetch(&run, &destination)?;
    write_bytes(caller, out.0, out.1, &body)
}

fn sign_impl(
    caller: &mut Caller<'_, GuestState>,
    purpose: (i32, i32),
    digest: (i32, i32),
    out: (i32, i32),
) -> Result<i32, ShimStop> {
    still_authorized(caller)?;
    let purpose = read_text(caller, purpose.0, purpose.1, MAX_TEXT_ARG)?;
    if purpose.trim().is_empty() {
        return Err(Refusal::Malformed.into());
    }
    let digest = read_bytes(caller, digest.0, digest.1, MAX_DIGEST_ARG)?;
    caller.data_mut().count_call();
    let state = caller.data();
    let run = state.run;
    let broker = Arc::clone(&state.broker);
    let signature = broker.sign(&run, &purpose, &digest)?;
    write_bytes(caller, out.0, out.1, &signature)
}

fn token_impl(caller: &mut Caller<'_, GuestState>, ptr: i32, len: i32) -> Result<i32, ShimStop> {
    still_authorized(caller)?;
    let scope = read_text(caller, ptr, len, MAX_TEXT_ARG)?;
    caller.data_mut().count_call();
    let state = caller.data();
    let run = state.run;
    let broker = Arc::clone(&state.broker);
    let handle = broker.token_acquire(&run, &scope)?;
    // An opaque handle, never bytes. Handles above i32::MAX cannot be named
    // in this ABI, so a broker that mints one is refused rather than wrapped.
    i32::try_from(handle).map_err(|_| Refusal::Denied.into())
}

/// Cap on a text argument (a destination, a purpose, a scope).
const MAX_TEXT_ARG: usize = 8 * 1024;
/// Cap on a digest argument — far more than any hash in use.
const MAX_DIGEST_ARG: usize = 1024;

/// Define exactly the granted capabilities on the linker, and nothing else.
///
/// An ungranted capability is not defined at all, so a guest importing it
/// fails to link. That is stricter than defining a stub that refuses: a
/// refusing stub still tells the guest the function exists.
///
/// # Errors
///
/// Returns [`SandboxError::Runtime`] if the linker rejects a definition,
/// which would mean two definitions collided.
pub fn define(
    linker: &mut Linker<GuestState>,
    granted: &std::collections::BTreeSet<BrokeredCapability>,
) -> Result<(), SandboxError> {
    for capability in granted {
        let outcome = match capability {
            BrokeredCapability::Emit => linker.func_wrap(
                BROKERED_MODULE,
                capability.import_name(),
                |mut caller: Caller<'_, GuestState>, ptr: i32, len: i32| {
                    finish(emit_impl(&mut caller, ptr, len))
                },
            ),
            BrokeredCapability::HttpFetch => linker.func_wrap(
                BROKERED_MODULE,
                capability.import_name(),
                |mut caller: Caller<'_, GuestState>,
                 url_ptr: i32,
                 url_len: i32,
                 out_ptr: i32,
                 out_cap: i32| {
                    finish(http_fetch_impl(
                        &mut caller,
                        (url_ptr, url_len),
                        (out_ptr, out_cap),
                    ))
                },
            ),
            BrokeredCapability::Sign => linker.func_wrap(
                BROKERED_MODULE,
                capability.import_name(),
                |mut caller: Caller<'_, GuestState>,
                 purpose_ptr: i32,
                 purpose_len: i32,
                 digest_ptr: i32,
                 digest_len: i32,
                 out_ptr: i32,
                 out_cap: i32| {
                    finish(sign_impl(
                        &mut caller,
                        (purpose_ptr, purpose_len),
                        (digest_ptr, digest_len),
                        (out_ptr, out_cap),
                    ))
                },
            ),
            BrokeredCapability::TokenAcquire => linker.func_wrap(
                BROKERED_MODULE,
                capability.import_name(),
                |mut caller: Caller<'_, GuestState>, ptr: i32, len: i32| {
                    finish(token_impl(&mut caller, ptr, len))
                },
            ),
        };
        outcome.map_err(|e| SandboxError::Runtime(format!("linking {capability}: {e}")))?;
    }
    Ok(())
}
