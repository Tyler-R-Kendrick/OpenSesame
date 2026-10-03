//! Where a session's records go, in `sequence` order, and what it keeps.
//!
//! Emissions finish in any order — one may be parked on an approval while
//! later ones complete — but §12.2.3 makes `sequence` "the audit order of
//! records under concurrency", so a record leaves the session (to the sink,
//! and into the retained list) only once every record sequenced before it has
//! left. A record that finished early waits here for as long as an earlier
//! emission stays parked (an approval has no deadline of its own), so the
//! buffer grows with the emissions that complete meanwhile, not only with
//! those in flight, and a sink sees none of them until the parked one settles.
//! Each sequence is completed exactly once, with its record or — for an
//! emission with nothing to record — with nothing, so no sequence ever stalls
//! the ones behind it. (A dropped emission is completed with a record that
//! says it was abandoned: see `emission::abandoned`.)

use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;

use agent_hooks::InterceptionRecord;

/// Where each emitted record goes, as it is made.
///
/// Called once per emission, in `sequence` order, with the payload-free
/// §10.3 projection — never the context. This is how a run's observation log
/// or audit trail persists them. It runs inside the session's short critical
/// section, so it must be quick and must not call back into the session.
pub type RecordSink = Arc<dyn Fn(&InterceptionRecord) + Send + Sync>;

/// Whether delivered records are also kept for [`HookSession::records`].
///
/// [`HookSession::records`]: super::HookSession::records
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Retention {
    /// The default: keep them unless a sink is the record's home.
    Auto,
    /// Asked for explicitly, sink or not.
    Kept,
}

pub(super) struct RecordLog {
    /// The next `sequence` to deliver; everything below it has been.
    next: u64,
    /// Completed but not yet deliverable, by `sequence`. `None` is an
    /// emission that will never produce a record.
    waiting: BTreeMap<u64, Option<InterceptionRecord>>,
    sink: Option<RecordSink>,
    retention: Retention,
    retained: VecDeque<InterceptionRecord>,
    limit: Option<usize>,
    dropped: u64,
}

impl RecordLog {
    pub(super) const fn new() -> Self {
        Self {
            next: 0,
            waiting: BTreeMap::new(),
            sink: None,
            retention: Retention::Auto,
            retained: VecDeque::new(),
            limit: None,
            dropped: 0,
        }
    }

    pub(super) fn set_sink(&mut self, sink: RecordSink) {
        self.sink = Some(sink);
    }

    pub(super) const fn keep(&mut self) {
        self.retention = Retention::Kept;
    }

    pub(super) const fn set_limit(&mut self, limit: usize) {
        self.limit = Some(limit);
    }

    fn retaining(&self) -> bool {
        self.retention == Retention::Kept || self.sink.is_none()
    }

    /// The retained records, oldest first.
    pub(super) fn retained(&self) -> Vec<InterceptionRecord> {
        self.retained.iter().cloned().collect()
    }

    /// Retained records evicted by the limit.
    pub(super) const fn dropped(&self) -> u64 {
        self.dropped
    }

    /// Emissions completed but held for an earlier one.
    #[cfg(test)]
    pub(super) fn waiting(&self) -> usize {
        self.waiting.len()
    }

    /// Emission `sequence` is over: it made `record`, or was dropped
    /// without one. Delivers everything that is now next in line.
    pub(super) fn complete(&mut self, sequence: u64, record: Option<InterceptionRecord>) {
        self.waiting.insert(sequence, record);
        while let Some(entry) = self.waiting.first_entry() {
            if *entry.key() != self.next {
                break;
            }
            self.next += 1;
            if let Some(record) = entry.remove() {
                self.deliver(record);
            }
        }
    }

    fn deliver(&mut self, record: InterceptionRecord) {
        if let Some(sink) = &self.sink {
            // Audit delivery must not take the run down with it; the SDK's
            // own sink contract makes the same choice.
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sink(&record)));
        }
        if !self.retaining() {
            return;
        }
        if let Some(limit) = self.limit {
            while self.retained.len() >= limit.max(1) {
                self.retained.pop_front();
                self.dropped += 1;
            }
        }
        self.retained.push_back(record);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use agent_hooks::{
        AgentContextBuilder, EnforcementMode, InterceptionEmitter, Interceptor, Verdict,
    };
    use async_trait::async_trait;

    use super::*;

    struct Allow;

    #[async_trait]
    impl Interceptor for Allow {
        async fn intercept(&self, _: &agent_hooks::AgentContext) -> Verdict {
            Verdict::allow()
        }
    }

    /// `count` real records with sequences `0..count`.
    fn records(count: usize) -> Vec<InterceptionRecord> {
        let mut emitter = InterceptionEmitter::new(EnforcementMode::Enforce, None);
        emitter.register(Box::new(Allow));
        let mut builder = AgentContextBuilder::new("agent", "test", "session");
        (0..count)
            .map(|_| {
                let mut context = builder.agent_startup(Vec::new());
                futures::executor::block_on(emitter.emit_unchecked(&mut context))
            })
            .collect()
    }

    fn sequences(log: &RecordLog) -> Vec<i64> {
        log.retained().iter().map(|r| r.sequence).collect()
    }

    fn sinking(log: &mut RecordLog) -> Arc<Mutex<Vec<i64>>> {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let into = Arc::clone(&seen);
        log.set_sink(Arc::new(move |record| {
            into.lock().unwrap().push(record.sequence);
        }));
        seen
    }

    #[test]
    fn a_record_that_finishes_early_waits_for_the_ones_before_it() {
        let mut all = records(4).into_iter();
        let mut log = RecordLog::new();
        let (r0, r1, r2, r3) = (
            all.next().unwrap(),
            all.next().unwrap(),
            all.next().unwrap(),
            all.next().unwrap(),
        );
        log.complete(2, Some(r2));
        log.complete(3, Some(r3));
        assert!(sequences(&log).is_empty());
        assert_eq!(log.waiting(), 2);
        log.complete(0, Some(r0));
        assert_eq!(sequences(&log), [0]);
        log.complete(1, Some(r1));
        assert_eq!(sequences(&log), [0, 1, 2, 3]);
        assert_eq!(log.waiting(), 0);
    }

    #[test]
    fn a_dropped_emission_releases_the_records_behind_it() {
        let mut all = records(3).into_iter();
        let mut log = RecordLog::new();
        let (r0, _, r2) = (all.next().unwrap(), all.next(), all.next().unwrap());
        log.complete(2, Some(r2));
        log.complete(1, None);
        log.complete(0, Some(r0));
        assert_eq!(sequences(&log), [0, 2]);
        assert_eq!(log.waiting(), 0);
    }

    #[test]
    fn with_a_sink_records_go_to_it_in_order_and_are_not_kept_unless_asked() {
        let mut log = RecordLog::new();
        let seen = sinking(&mut log);
        for (sequence, record) in records(3).into_iter().enumerate().rev() {
            log.complete(sequence as u64, Some(record));
        }
        assert_eq!(*seen.lock().unwrap(), [0, 1, 2]);
        assert!(log.retained().is_empty());

        let mut kept = RecordLog::new();
        kept.keep();
        let seen = sinking(&mut kept);
        for (sequence, record) in records(3).into_iter().enumerate() {
            kept.complete(sequence as u64, Some(record));
        }
        assert_eq!(*seen.lock().unwrap(), [0, 1, 2]);
        assert_eq!(sequences(&kept), [0, 1, 2]);
    }

    #[test]
    fn without_a_sink_every_record_is_kept() {
        let mut log = RecordLog::new();
        for (sequence, record) in records(3).into_iter().enumerate() {
            log.complete(sequence as u64, Some(record));
        }
        assert_eq!(sequences(&log), [0, 1, 2]);
        assert_eq!(log.dropped(), 0);
    }

    #[test]
    fn the_limit_drops_the_oldest_and_counts_them() {
        let mut log = RecordLog::new();
        log.set_limit(2);
        for (sequence, record) in records(5).into_iter().enumerate() {
            log.complete(sequence as u64, Some(record));
        }
        assert_eq!(sequences(&log), [3, 4]);
        assert_eq!(log.dropped(), 3);
    }

    #[test]
    fn a_zero_limit_still_keeps_the_latest_record() {
        let mut log = RecordLog::new();
        log.set_limit(0);
        for (sequence, record) in records(2).into_iter().enumerate() {
            log.complete(sequence as u64, Some(record));
        }
        assert_eq!(sequences(&log), [1]);
        assert_eq!(log.dropped(), 1);
    }

    #[test]
    fn a_panicking_sink_takes_neither_the_log_nor_the_run_down() {
        let mut log = RecordLog::new();
        log.keep();
        log.set_sink(Arc::new(|_| panic!("audit sink down")));
        for (sequence, record) in records(2).into_iter().enumerate() {
            log.complete(sequence as u64, Some(record));
        }
        assert_eq!(sequences(&log), [0, 1]);
    }
}
