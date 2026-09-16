//! Why the decision came out that way (POL-EXPLAIN).
//!
//! An explanation is a projection, not a copy. It is built out of layer names,
//! effect names, stable reason codes and the sanitized detail a [`DenyReason`]
//! chooses to expose — and out of nothing else. In particular it never carries
//! the request's `context` or `subject.properties`, which are client-authored and
//! may hold anything at all, and it never carries what the caller *holds*: that a
//! request failed an assurance requirement is explainable, which authenticator
//! the caller actually used is not the requester's business.
//!
//! Structurally the type has no field a value could hide in: every field is a
//! `&'static str` or a bounded string that went through
//! [`crate::error::sanitize_term`], so being value-blind is a property of the
//! shape rather than a rule someone has to remember at each call site.

use crate::combine::{Combination, Effect, PolicyLayer};
use crate::error::DenyReason;
use serde::Serialize;
use serde_json::{json, Value};

/// One layer's verdict, flattened to codes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LayerVerdict {
    pub layer: &'static str,
    pub effect: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// The decision, layer by layer, in precedence order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Explanation {
    decision: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    layers: Vec<LayerVerdict>,
    obligations: Vec<String>,
}

impl Explanation {
    /// Project a combined decision into its explanation.
    #[must_use]
    pub fn of(combination: &Combination) -> Self {
        let layers = combination
            .outcomes()
            .iter()
            .map(|outcome| LayerVerdict {
                layer: outcome.layer.as_str(),
                effect: outcome.effect.as_str(),
                reason: outcome.reason.as_ref().map(DenyReason::code),
                detail: outcome.reason.as_ref().and_then(DenyReason::detail),
            })
            .collect();
        Self {
            decision: if combination.permitted() {
                "permit"
            } else {
                "deny"
            },
            reason: combination.reason().map(DenyReason::code),
            detail: combination.reason().and_then(DenyReason::detail),
            layers,
            obligations: combination
                .obligations()
                .iter()
                .map(|obligation| obligation.id.clone())
                .collect(),
        }
    }

    #[must_use]
    pub fn permitted(&self) -> bool {
        self.decision == "permit"
    }

    /// The stable code a receipt or a dashboard keys on.
    #[must_use]
    pub fn decisive_code(&self) -> Option<&'static str> {
        self.reason
    }

    #[must_use]
    pub fn detail(&self) -> Option<&str> {
        self.detail.as_deref()
    }

    #[must_use]
    pub fn layers(&self) -> &[LayerVerdict] {
        &self.layers
    }

    /// The verdict of one layer, for a caller that wants to know whether a
    /// particular question was even reached.
    #[must_use]
    pub fn layer(&self, layer: PolicyLayer) -> Option<&LayerVerdict> {
        self.layers
            .iter()
            .find(|verdict| verdict.layer == layer.as_str())
    }

    /// True when this layer reported the given effect.
    #[must_use]
    pub fn layer_effect(&self, layer: PolicyLayer, effect: Effect) -> bool {
        self.layer(layer)
            .is_some_and(|verdict| verdict.effect == effect.as_str())
    }

    /// The explanation as JSON, for a decision context or an audit record.
    #[must_use]
    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or_else(|_| json!({"decision": self.decision}))
    }
}
