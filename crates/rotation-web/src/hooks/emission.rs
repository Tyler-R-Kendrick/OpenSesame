//! One emission: reserve a sequence, dispatch without a lock, settle in order.
//!
//! See the `session` module documentation for the shape and `recipe` for why a
//! fresh SDK emitter per emission is the same emitter. This module is the
//! only place the three steps meet.

use agent_hooks::{
    finalize, AgentContext, AgentContextBuilder, FinalizeMeta, HostError, InterceptionEmitter,
    InterceptionPoint, InterceptionRecord, Verdict,
};
use serde_json::Value;

use super::labels::Noted;
use super::phase::{admits, after, overlaps, Phase};
use super::refusal::{Refusal, OUT_OF_ORDER};
use super::session::HookSession;

/// What a caller decided about an emission once its record was in: the
/// answer it returns, and what the session records about the outcome.
pub(super) struct Concluded<R> {
    pub(super) result: R,
    /// Whether the host acted on the emission (§5.4: labels persist only then).
    pub(super) applied: bool,
    /// The phase the session moves to.
    pub(super) phase: Phase,
    /// The refusal to remember as the latest, if the emission ended in one.
    pub(super) refusal: Option<Refusal>,
}

/// An emission that holds a sequence number.
///
/// Every sequence handed out is completed exactly once: by
/// [`HookSession::settle`] with its record, or — if the emission is dropped
/// first, say because its caller gave up on a verb parked on an approval, or
/// the run's deadline cut it off — here, with a record that says so
/// ([`abandoned`]), so the records behind it are not held back forever and
/// the attempt does not vanish from the audit trail. A `post_model_call`
/// dropped this way hands back the open `pre_model_call` it had claimed,
/// since it never happened.
///
/// The record is a deny, so the session's phase moves as it does for any
/// deny: a boundary emission cut off still changes what may follow it. A cut
/// `agent_startup` is a startup deny, after which the closing
/// `agent_shutdown` is admitted (§6.1a); a cut `agent_shutdown` closes the
/// session, so no second one is emitted (§3.1).
struct Flight<'a> {
    session: &'a HookSession,
    sequence: u64,
    context: AgentContext,
    emitter: InterceptionEmitter,
    noted: Noted,
    point: InterceptionPoint,
    /// Whether this emission holds the `pre_model_call` it pairs with.
    claimed: bool,
    open: bool,
}

impl Drop for Flight<'_> {
    fn drop(&mut self) {
        if self.open {
            let mut state = self.session.lock();
            if self.claimed {
                state.open_model_calls += 1;
            }
            let record = abandoned(self.session, &self.context);
            state.phase = after(state.phase, self.point, false);
            if self.point == InterceptionPoint::Output {
                // As in `settle`: a turn's end closes the model calls left open.
                state.open_model_calls = 0;
            }
            state.log.complete(self.sequence, Some(record));
        }
    }
}

/// The record of an emission dropped before its verdict was known: a deny the
/// guarded action never got past, with the reserved reason
/// `host_error:interceptor_timeout` (§11) — dispatch, an interceptor or the
/// approval seam it was waiting on, did not conclude. Built by the SDK's own
/// `finalize` from the context alone, so it carries the same payload-free
/// projection and identities as any other record, and nothing about what
/// answer might have come.
fn abandoned(session: &HookSession, context: &AgentContext) -> InterceptionRecord {
    let recipe = &session.recipe;
    let (identity_provider, identity) = recipe.identity.describe(context);
    let meta = FinalizeMeta {
        input_identity: identity.clone(),
        identity_provider,
        enforced_identity: identity,
        unchanged_since_input: true,
        composition: recipe.composition,
        interceptors_registered: u32::try_from(recipe.interceptors.len()).unwrap_or(u32::MAX),
        ..FinalizeMeta::default()
    };
    finalize(
        context,
        Verdict::host_error(HostError::InterceptorTimeout, None),
        recipe.mode,
        meta,
    )
}

/// What an emission meant to the host, for a verb that consumes its target.
fn judge<T>(
    point: InterceptionPoint,
    decode: impl FnOnce(Value) -> Option<T>,
    record: &mut InterceptionRecord,
    context: &AgentContext,
    phase: Phase,
) -> Concluded<Result<T, Refusal>> {
    let outcome = if record.proceeds() {
        let target = context.get("target").cloned().unwrap_or(Value::Null);
        decode(target).ok_or_else(|| {
            // §10.3: `decided_by` is null for a transform-application
            // failure, and `enforced_identity` equals `input_identity` when
            // no transform was applied — the transformed context the SDK
            // hashed is one the host refused to act on.
            record.verdict = Verdict::host_error(HostError::TransformInvalid, None);
            record.decided_by = None;
            record.enforced_identity.clone_from(&record.input_identity);
            Refusal::of(record)
        })
    } else {
        Err(Refusal::of(record))
    };
    Concluded {
        applied: outcome.is_ok(),
        phase: after(phase, point, outcome.is_ok()),
        refusal: outcome.as_ref().err().cloned(),
        result: outcome,
    }
}

impl HookSession {
    /// Emit one context and hand back the effective target, decoded.
    ///
    /// `decode` turns the post-composition target back into what the guarded
    /// action consumes. When a transform produced something it cannot take —
    /// a string where the verb takes a selector object, an image that is not
    /// in the context — the transform could not be applied, and the host
    /// substitutes `host_error:transform_invalid` (§5.2, §11) in the record
    /// rather than ignoring the verdict or delivering a record that says the
    /// transform happened.
    pub(crate) async fn emit<T>(
        &self,
        point: InterceptionPoint,
        build: impl FnOnce(&mut AgentContextBuilder) -> AgentContext,
        decode: impl FnOnce(Value) -> Option<T>,
    ) -> Result<T, Refusal> {
        let concluded = self
            .emit_with(point, build, move |record, context, phase| {
                judge(point, decode, record, context, phase)
            })
            .await;
        concluded.unwrap_or_else(|refusal| {
            // Refused without an emission (§3.1): remember why, too.
            self.lock().last_refusal = Some(refusal.clone());
            Err(refusal)
        })
    }

    /// Run one emission and let `conclude` say what it meant.
    ///
    /// `Err` is a refusal with **no emission** — the phase does not admit
    /// `point`, so emitting would break §3.1. `conclude` runs inside the
    /// settling critical section, after dispatch: it may amend the record
    /// (a transform the host could not apply) and must not block.
    pub(super) async fn emit_with<R>(
        &self,
        point: InterceptionPoint,
        build: impl FnOnce(&mut AgentContextBuilder) -> AgentContext,
        conclude: impl FnOnce(&mut InterceptionRecord, &AgentContext, Phase) -> Concluded<R>,
    ) -> Result<R, Refusal> {
        // Interior points share the gate; a run's boundary takes it alone, so
        // it queues behind everything in flight and everything after queues
        // behind it. The guard is the whole of what ordering needs, and it
        // outlives only the emission it was taken for.
        if overlaps(point) {
            let _shared = self.gate.read().await;
            self.run(point, build, conclude).await
        } else {
            let _alone = self.gate.write().await;
            self.run(point, build, conclude).await
        }
    }

    async fn run<R>(
        &self,
        point: InterceptionPoint,
        build: impl FnOnce(&mut AgentContextBuilder) -> AgentContext,
        conclude: impl FnOnce(&mut InterceptionRecord, &AgentContext, Phase) -> Concluded<R>,
    ) -> Result<R, Refusal> {
        let mut flight = self.reserve(point, build)?;
        // No lock is held here: this is where an interceptor, or a person,
        // may take as long as they take.
        let record = flight.emitter.emit_unchecked(&mut flight.context).await;
        Ok(self.settle(&mut flight, record, conclude))
    }

    /// Step one, under the state lock: admit, build (which assigns the
    /// `sequence`) and take an emitter.
    fn reserve(
        &self,
        point: InterceptionPoint,
        build: impl FnOnce(&mut AgentContextBuilder) -> AgentContext,
    ) -> Result<Flight<'_>, Refusal> {
        let (emitter, noted) = self
            .recipe
            .emitter()
            .map_err(|error| Refusal::new(point, Some(error.to_string())))?;
        let mut state = self.lock();
        // §3.1.4: a `post_model_call` answers a `pre_model_call` that
        // proceeded. With none open, emitting it would break the pairing; with
        // one, this emission takes it *now*, under the lock, so two posts in
        // flight cannot both answer the same pre.
        let claims = point == InterceptionPoint::PostModelCall;
        if !admits(state.phase, point) || (claims && state.open_model_calls == 0) {
            return Err(Refusal::new(point, Some(OUT_OF_ORDER.to_owned())));
        }
        let context = build(&mut state.builder);
        let sequence = context
            .get("sequence")
            .and_then(Value::as_u64)
            .ok_or_else(|| Refusal::new(point, Some(OUT_OF_ORDER.to_owned())))?;
        if claims {
            state.open_model_calls -= 1;
        }
        drop(state);
        Ok(Flight {
            session: self,
            sequence,
            context,
            emitter,
            noted,
            point,
            claimed: claims,
            open: true,
        })
    }

    /// Step three, under the state lock: apply what the emission meant, and
    /// let its record leave once every earlier one has.
    fn settle<R>(
        &self,
        flight: &mut Flight<'_>,
        mut record: InterceptionRecord,
        conclude: impl FnOnce(&mut InterceptionRecord, &AgentContext, Phase) -> Concluded<R>,
    ) -> R {
        let mut state = self.lock();
        let done = conclude(&mut record, &flight.context, state.phase);
        state.phase = done.phase;
        match flight.point {
            // Opens a pair only once the host may act on it.
            InterceptionPoint::PreModelCall if done.applied => state.open_model_calls += 1,
            // A turn's end closes the model calls it left open. (A post's own
            // pair was closed when it was reserved, whatever its verdict.)
            InterceptionPoint::Output => state.open_model_calls = 0,
            _ => {}
        }
        // §5.4: labels persist only for an emission the host acted on, and
        // ride every later context (the `labels` module says why every one).
        if let Some(extensions) = state
            .labels
            .settle(&flight.noted, done.applied, &record.verdict)
        {
            state.builder.with_optional("extensions", extensions);
        }
        if let Some(refusal) = done.refusal {
            state.last_refusal = Some(refusal);
        }
        state.log.complete(flight.sequence, Some(record));
        flight.open = false;
        done.result
    }
}

#[cfg(test)]
mod tests {
    use agent_hooks::Interceptor;
    use async_trait::async_trait;

    use super::*;
    use crate::hooks::SessionConfig;

    struct Allow;

    #[async_trait]
    impl Interceptor for Allow {
        async fn intercept(&self, _: &AgentContext) -> Verdict {
            Verdict::allow()
        }
    }

    #[tokio::test]
    async fn a_context_with_no_sequence_is_refused_without_an_emission() {
        let session =
            HookSession::new(SessionConfig::new("run:test"), vec![Box::new(Allow)], None).unwrap();
        // A context the builder did not number cannot be placed in the order.
        let refusal = session
            .emit(
                InterceptionPoint::AgentStartup,
                |_| AgentContext::new(),
                |_| Some(()),
            )
            .await
            .unwrap_err();
        assert_eq!(refusal.reason.as_deref(), Some(OUT_OF_ORDER));
        assert_eq!(session.last_refusal().await, Some(refusal));
        assert!(session.records().await.is_empty());
        // Nothing was emitted, so the session is exactly as it was.
        session.startup(&[]).await.unwrap();
        assert_eq!(session.records().await[0].sequence, 0);
    }
}
