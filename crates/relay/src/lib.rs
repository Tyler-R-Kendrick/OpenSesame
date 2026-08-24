//! Admission rules for relayed execution (ADR 0046).
//!
//! When an upstream credential cannot be attenuated, a delegation may run in
//! `relay` mode: the credential stays with its holder and the delegate's
//! *request* travels to the holder's runtime, which executes it. Transport for
//! that is not built — the ADR describes a JSON-RPC channel over the existing
//! per-principal bus inbox, with WSS and WebRTC tiers after it.
//!
//! What is built here is the part that must exist before any transport does:
//! the rules under which a relayed request may run at all. They are written as
//! pure functions so they can be tested without a network, and so the answer to
//! "may this execute?" cannot quietly diverge between the gateway and the
//! holder — both call this.
//!
//! Every rule fails closed. The tempting behaviors — queue a request until the
//! holder returns, or run it against the digest the delegate supplied — are
//! exactly the ones that turn delegation into unbounded access, so they are
//! refusals here rather than TODOs later.

use opensesame_domain::{AvailabilityClass, OfflineUse};
use serde::{Deserialize, Serialize};

/// How a delegation item is exercised.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    /// The gateway holds the sealed credential and invokes (ADR 0044).
    Broker,
    /// The holder's own runtime executes; the credential never leaves it.
    Relay,
}

/// Whether the holder's runtime is reachable right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HolderLiveness {
    Online,
    Offline,
}

/// Why a relayed request was refused. Every variant is a deliberate closed door.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelayRefusal {
    /// The delegation is brokered; relaying it would bypass its own model.
    NotRelayMode,
    /// The holder is not reachable. Authority-required work does not queue.
    HolderOffline,
    /// What is about to run is not what was approved.
    DigestMismatch,
    /// Approval was required and has not been given.
    ApprovalRequired,
    /// Materialization is never reachable through a relay.
    MaterializeDenied,
}

/// A relayed request, reduced to what admission actually depends on.
#[derive(Clone, Debug)]
pub struct RelayAdmission<'a> {
    pub mode: ExecutionMode,
    pub liveness: HolderLiveness,
    /// Class of the operation being asked for.
    pub class: AvailabilityClass,
    /// The delegation's offline stance, from its grant constraints.
    pub offline_use: OfflineUse,
    /// Digest recorded when the request was approved.
    pub approved_digest: &'a str,
    /// Digest of what the executor is actually about to run.
    pub executing_digest: &'a str,
    /// Whether an approval was required for this request.
    pub approval_required: bool,
    /// Whether that approval has been given.
    pub approved: bool,
    /// Whether the request asks to materialize a credential.
    pub materialize: bool,
}

/// Decide whether a relayed request may execute.
///
/// Order matters only for which refusal is reported first; every check is
/// independently sufficient to refuse.
///
/// # Errors
///
/// Returns the first fail-closed refusal applicable to the relay request.
pub fn admit(request: &RelayAdmission<'_>) -> Result<(), RelayRefusal> {
    if request.mode != ExecutionMode::Relay {
        return Err(RelayRefusal::NotRelayMode);
    }

    // Level 3 is denied on every path (ADR 0005); a relay does not become the
    // exception just because the credential is already local to the executor.
    if request.materialize {
        return Err(RelayRefusal::MaterializeDenied);
    }

    // The holder's live runtime *is* the authority in relay mode, so an absent
    // holder is not a delay to queue through — it is the end of the request.
    //
    // Neither `class` nor `offline_use` can soften this, and the rule says so
    // outright rather than deriving it: A2/A3 work already fails closed without
    // quorum, and `PreAuthorized` — which does legitimize acting while an
    // approver is away — assumes a bounded capability issued in advance, which
    // is exactly what a non-attenuable connector could not issue. An earlier
    // version computed the answer from those two fields and happened to agree
    // for every case that occurs; a surviving mutant showed the derivation was
    // doing no work, and that it would have let an `A0Local` request through.
    if request.liveness == HolderLiveness::Offline {
        return Err(RelayRefusal::HolderOffline);
    }

    if request.approval_required && !request.approved {
        return Err(RelayRefusal::ApprovalRequired);
    }

    // The whole point of approving something. Compared in full: a prefix match
    // would let a request be extended after consent.
    if request.approved_digest.is_empty() || request.approved_digest != request.executing_digest {
        return Err(RelayRefusal::DigestMismatch);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIGEST: &str = "b9b1b3f0c0e5a1d2b9b1b3f0c0e5a1d2b9b1b3f0c0e5a1d2b9b1b3f0c0e5a1d2";

    fn admissible() -> RelayAdmission<'static> {
        RelayAdmission {
            mode: ExecutionMode::Relay,
            liveness: HolderLiveness::Online,
            class: AvailabilityClass::A3ExternalSideEffect,
            offline_use: OfflineUse::Forbidden,
            approved_digest: DIGEST,
            executing_digest: DIGEST,
            approval_required: true,
            approved: true,
            materialize: false,
        }
    }

    #[test]
    fn contract_an_approved_live_request_runs() {
        assert_eq!(admit(&admissible()), Ok(()));
    }

    #[test]
    fn adversarial_digest_drift_is_refused() {
        // The request was approved, then changed. This is the check that makes
        // an approval mean anything at all.
        let other = "0000000000000000000000000000000000000000000000000000000000000000";
        let request = RelayAdmission {
            executing_digest: other,
            ..admissible()
        };
        assert_eq!(admit(&request), Err(RelayRefusal::DigestMismatch));

        // A prefix must not pass either.
        let prefix = &DIGEST[..32];
        let request = RelayAdmission {
            executing_digest: prefix,
            ..admissible()
        };
        assert_eq!(admit(&request), Err(RelayRefusal::DigestMismatch));
    }

    #[test]
    fn adversarial_an_offline_holder_never_queues() {
        for class in [
            AvailabilityClass::A2AuthorityRequired,
            AvailabilityClass::A3ExternalSideEffect,
        ] {
            let request = RelayAdmission {
                liveness: HolderLiveness::Offline,
                class,
                ..admissible()
            };
            assert_eq!(admit(&request), Err(RelayRefusal::HolderOffline));
        }
    }

    #[test]
    fn property_no_class_or_offline_stance_lets_an_offline_holder_through() {
        // The matrix, not a sample: the previous derivation agreed with this
        // rule for every case a test happened to name, which is how it survived
        // review and why a mutant found it instead.
        for class in [
            AvailabilityClass::A0Local,
            AvailabilityClass::A1Preauthorized,
            AvailabilityClass::A2AuthorityRequired,
            AvailabilityClass::A3ExternalSideEffect,
        ] {
            for offline_use in [
                OfflineUse::Forbidden,
                OfflineUse::ReadOnly,
                OfflineUse::PreAuthorized,
            ] {
                // OfflineUse is not Copy; name the case before it moves.
                let label = format!("{class:?} + {offline_use:?}");
                let request = RelayAdmission {
                    liveness: HolderLiveness::Offline,
                    class,
                    offline_use,
                    ..admissible()
                };
                let outcome = admit(&request);
                assert_eq!(
                    outcome,
                    Err(RelayRefusal::HolderOffline),
                    "{label} must not reach a runtime that is not there"
                );
            }
        }
    }

    #[test]
    fn adversarial_preauthorized_offline_use_does_not_open_the_relay() {
        // `PreAuthorized` legitimizes acting while the approver is away for a
        // bounded capability issued in advance. A relay exists because no such
        // capability could be issued, so the exemption must not apply.
        let request = RelayAdmission {
            liveness: HolderLiveness::Offline,
            offline_use: OfflineUse::PreAuthorized,
            class: AvailabilityClass::A1Preauthorized,
            ..admissible()
        };
        assert_eq!(admit(&request), Err(RelayRefusal::HolderOffline));
    }

    #[test]
    fn contract_unapproved_and_brokered_requests_are_refused() {
        let request = RelayAdmission {
            approved: false,
            ..admissible()
        };
        assert_eq!(admit(&request), Err(RelayRefusal::ApprovalRequired));

        let request = RelayAdmission {
            mode: ExecutionMode::Broker,
            ..admissible()
        };
        assert_eq!(admit(&request), Err(RelayRefusal::NotRelayMode));
    }

    #[test]
    fn adversarial_materialize_is_denied_even_at_the_holder() {
        let request = RelayAdmission {
            materialize: true,
            ..admissible()
        };
        assert_eq!(admit(&request), Err(RelayRefusal::MaterializeDenied));
    }

    #[test]
    fn property_an_empty_approved_digest_never_admits() {
        // An unapproved request must not slip through by carrying no digest on
        // either side.
        let request = RelayAdmission {
            approved_digest: "",
            executing_digest: "",
            ..admissible()
        };
        assert_eq!(admit(&request), Err(RelayRefusal::DigestMismatch));
    }
}
