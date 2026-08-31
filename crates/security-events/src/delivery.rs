//! How a subscription receives security events.
//!
//! One closed vocabulary shared by the schema's `CHECK`, the route layer's
//! validation, and the delivery worker. Adding a sink means adding a variant
//! here and the three of them move together, which is the only way the
//! database's idea of a valid row and the API's idea of one stay the same.
//!
//! There is no `syslog` variant, and that is deliberate. RFC 5424 is a *line
//! format*, not a transport we should be inventing egress for: shipping one
//! over plaintext TCP to an arbitrary host would put credential metadata on
//! the wire in cleartext, and the collectors that want syslog already read the
//! host's own log stream. So the built-in notifier writes RFC 5424 lines
//! locally ([`crate::render::syslog`]) and every *outbound* sink here is
//! HTTPS, sharing one egress guard and one retry ledger.

use serde::{Deserialize, Serialize};

/// Where a matched event goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Delivery {
    /// A Standard Webhooks POST to a subscriber's own endpoint.
    Webhook,
    /// A platform-owned responder that runs in-process. Never community code.
    Internal,
    /// A Prometheus Alertmanager v2 `POST /api/v2/alerts`.
    Alertmanager,
    /// A `PagerDuty` Events API v2 `enqueue`.
    PagerDuty,
}

impl Delivery {
    pub const ALL: [Self; 4] = [
        Self::Webhook,
        Self::Internal,
        Self::Alertmanager,
        Self::PagerDuty,
    ];

    /// Frozen wire name, stored verbatim in `security_hooks.delivery`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Webhook => "webhook",
            Self::Internal => "internal",
            Self::Alertmanager => "alertmanager",
            Self::PagerDuty => "pagerduty",
        }
    }

    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == raw)
    }

    /// Whether this sink leaves the process.
    ///
    /// The inverse of "is a platform responder": an internal row documents
    /// something that runs in-process, so queueing an outbound delivery for it
    /// would write a ledger row nobody ever drains.
    #[must_use]
    pub const fn is_outbound(self) -> bool {
        !matches!(self, Self::Internal)
    }

    /// Whether the row must carry an absolute `https://` endpoint.
    ///
    /// `PagerDuty`'s is required too, even though the API has one well-known
    /// URL: storing it makes the row self-describing, lets an operator point
    /// at the EU service or an egress proxy, and keeps the schema's `CHECK` a
    /// single rule rather than a per-sink special case.
    #[must_use]
    pub const fn requires_endpoint(self) -> bool {
        self.is_outbound()
    }

    /// Whether the row must carry sealed secret material.
    ///
    /// Webhook needs a `whsec_` signing key and `PagerDuty` needs a routing key.
    /// Alertmanager needs neither: its ingest API is unauthenticated by
    /// design, and operators put it behind network policy or a proxy instead.
    #[must_use]
    pub const fn requires_secret(self) -> bool {
        matches!(self, Self::Webhook | Self::PagerDuty)
    }

    /// Whether the row may carry sealed secret material at all.
    ///
    /// An internal responder is called in process: there is nothing to sign
    /// and nothing to authenticate, so a secret on such a row could only ever
    /// be an accident. Alertmanager may carry one for a proxy that wants a
    /// bearer token.
    #[must_use]
    pub const fn allows_secret(self) -> bool {
        self.is_outbound()
    }

    /// Whether the row names a platform responder.
    #[must_use]
    pub const fn requires_responder(self) -> bool {
        matches!(self, Self::Internal)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_names_are_frozen() {
        let names: Vec<&str> = Delivery::ALL.iter().map(|kind| kind.as_str()).collect();
        assert_eq!(names, ["webhook", "internal", "alertmanager", "pagerduty"]);
    }

    #[test]
    fn every_wire_name_round_trips() {
        for kind in Delivery::ALL {
            assert_eq!(Delivery::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(Delivery::parse("syslog"), None);
    }

    #[test]
    fn only_the_internal_sink_stays_in_process() {
        for kind in Delivery::ALL {
            assert_eq!(kind.is_outbound(), kind != Delivery::Internal);
        }
    }

    #[test]
    fn an_endpoint_is_required_exactly_when_the_sink_leaves_the_process() {
        for kind in Delivery::ALL {
            assert_eq!(kind.requires_endpoint(), kind.is_outbound());
        }
    }

    #[test]
    fn a_required_secret_is_always_an_allowed_one() {
        for kind in Delivery::ALL {
            assert!(
                !kind.requires_secret() || kind.allows_secret(),
                "{kind:?} requires a secret it may not hold",
            );
        }
    }

    #[test]
    fn an_internal_responder_can_never_hold_a_secret() {
        assert!(!Delivery::Internal.allows_secret());
        assert!(Delivery::Internal.requires_responder());
    }

    #[test]
    fn only_the_internal_sink_names_a_responder() {
        for kind in Delivery::ALL {
            assert_eq!(kind.requires_responder(), kind == Delivery::Internal);
        }
    }

    #[test]
    fn alertmanager_authenticates_by_network_policy_not_by_a_stored_secret() {
        assert!(!Delivery::Alertmanager.requires_secret());
        assert!(Delivery::Alertmanager.allows_secret());
    }
}
