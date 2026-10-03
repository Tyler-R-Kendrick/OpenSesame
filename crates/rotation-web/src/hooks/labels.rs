//! Result labels, carried forward (agent-hooks/0.1 §5.4).
//!
//! §5.4: a host MUST persist a verdict's `result_labels` alongside the data
//! the emission's `target` produced, MUST NOT persist them for an action that
//! did not proceed, and SHOULD resurface them as
//! `extensions.<interceptor-namespace>.source_labels` on later hooks whose
//! `target` derives from that data. `OpenSesame`'s own interceptor refuses
//! label flows on that channel (`crates/agent-hooks`), so a host that dropped
//! the labels would quietly disable the control.
//!
//! Two facts this host cannot know shape the rule here:
//!
//! - **Which later target derives from which result.** The model is remote
//!   (ADR 0076 §8): it reads a DOM and proposes the next verb on the far side
//!   of the tool boundary. So labels are *session-sticky* — once an emission
//!   that proceeded carried a label, every later emission in the run
//!   resurfaces it. Over-labelling can only make a label policy refuse more;
//!   under-labelling would launder provenance.
//! - **Which interceptor said which label.** The combined verdict holds only
//!   the union (§7.3). Each registered interceptor is therefore wrapped in
//!   [`Labelled`], which notes its own permit verdict's labels under the
//!   namespace it registers as ([`Interceptor::name`]). A label is carried
//!   only when the combined verdict also names it, so nothing the SDK dropped
//!   (a deny's labels, a truncated fold) comes back. An interceptor with no
//!   name, or a name that is not a legal §4.6 namespace, has nowhere to be
//!   resurfaced to, and its labels stay in the record alone.
//!
//! Emissions overlap (§12.2), so notes are kept **per emission**: every
//! emission gets its own wrapped interceptors and its own buffer
//! ([`instrument`]), and settling it reads only that buffer. A label an
//! emission persists rides the contexts built after it settles; a context
//! already built — a verb the remote model proposed before this result
//! existed — cannot have derived from it, and does not carry it.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, PoisonError};

use agent_hooks::{AgentContext, Interceptor, Verdict};
use async_trait::async_trait;
use serde_json::{json, Map, Value};

/// §4.6: namespaces the specification keeps for itself.
const RESERVED: [&str; 3] = ["acs", "ctk", "agent_hooks"];

/// Labels noted during one emission, by namespace.
pub(crate) type Noted = Arc<Mutex<Vec<(String, Vec<String>)>>>;

/// `^[a-z][a-z0-9_]*$` and not reserved (§4.6).
fn namespace(name: Option<String>) -> Option<String> {
    let name = name?;
    let mut chars = name.chars();
    let legal = chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    (legal && !RESERVED.contains(&name.as_str())).then_some(name)
}

/// An interceptor as registered: shared between emissions, with the
/// namespace its labels are resurfaced under.
#[derive(Clone)]
pub(crate) struct Registered {
    inner: Arc<dyn Interceptor>,
    namespace: Option<String>,
}

impl Registered {
    pub(crate) fn new(interceptor: Box<dyn Interceptor>) -> Self {
        Self {
            namespace: namespace(interceptor.name()),
            inner: Arc::from(interceptor),
        }
    }
}

/// The registered interceptors, each wrapped to note its labels into one
/// fresh buffer — one per emission, so two emissions in flight at once never
/// see each other's notes.
pub(crate) fn instrument(registered: &[Registered]) -> (Vec<Box<dyn Interceptor>>, Noted) {
    let noted = Noted::default();
    let wrapped = registered
        .iter()
        .map(|entry| {
            Box::new(Labelled {
                inner: Arc::clone(&entry.inner),
                namespace: entry.namespace.clone(),
                noted: Arc::clone(&noted),
            }) as Box<dyn Interceptor>
        })
        .collect();
    (wrapped, noted)
}

/// A registered interceptor that notes the labels on its own permit verdicts.
struct Labelled {
    inner: Arc<dyn Interceptor>,
    namespace: Option<String>,
    noted: Noted,
}

#[async_trait]
impl Interceptor for Labelled {
    async fn intercept(&self, context: &AgentContext) -> Verdict {
        let verdict = self.inner.intercept(context).await;
        if let Some(namespace) = &self.namespace {
            if verdict.decision.permits() && !verdict.result_labels.is_empty() {
                self.noted
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push((namespace.clone(), verdict.result_labels.clone()));
            }
        }
        verdict
    }

    fn name(&self) -> Option<String> {
        self.inner.name()
    }
}

/// The labels a session has persisted.
#[derive(Default)]
pub(crate) struct LabelLedger {
    carried: BTreeMap<String, Vec<String>>,
}

impl LabelLedger {
    /// Close the emission that filled `noted`. Its noted labels are persisted
    /// only when the host acted on it (`applied`) and the combined verdict —
    /// the record's — names them; otherwise they are discarded (§5.4).
    ///
    /// Returns the `extensions` object to put on every later context when the
    /// carried set grew, `None` when it did not.
    pub(crate) fn settle(
        &mut self,
        noted: &Noted,
        applied: bool,
        combined: &Verdict,
    ) -> Option<Value> {
        let noted = std::mem::take(&mut *noted.lock().unwrap_or_else(PoisonError::into_inner));
        if !applied || !combined.decision.permits() {
            return None;
        }
        let mut grew = false;
        for (namespace, labels) in noted {
            let carried = self.carried.entry(namespace).or_default();
            let fresh: Vec<String> = labels
                .into_iter()
                .filter(|label| combined.result_labels.contains(label))
                .collect();
            grew |= carry(carried, fresh);
        }
        grew.then(|| self.extensions())
    }

    fn extensions(&self) -> Value {
        let mut extensions = Map::new();
        for (namespace, labels) in &self.carried {
            if !labels.is_empty() {
                extensions.insert(namespace.clone(), json!({ "source_labels": labels }));
            }
        }
        Value::Object(extensions)
    }
}

/// Append each label `carried` does not hold yet; whether any was new.
fn carry(carried: &mut Vec<String>, labels: Vec<String>) -> bool {
    let before = carried.len();
    for label in labels {
        if !carried.contains(&label) {
            carried.push(label);
        }
    }
    carried.len() > before
}

#[cfg(test)]
mod tests {
    use super::namespace;

    #[test]
    fn only_a_legal_unreserved_namespace_is_resurfaced_to() {
        assert_eq!(
            namespace(Some("opensesame".into())).as_deref(),
            Some("opensesame")
        );
        assert_eq!(namespace(Some("a1_b".into())).as_deref(), Some("a1_b"));
        for bad in ["", "Acme", "1acme", "ac-me", "ctk", "acs", "agent_hooks"] {
            assert_eq!(namespace(Some(bad.into())), None, "{bad}");
        }
        assert_eq!(namespace(None), None);
    }
}
