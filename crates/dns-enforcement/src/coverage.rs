//! What DNS enforcement actually covers, and the claims it refuses (DNS-TRUTH).
//!
//! A DNS filter answers exactly one question: when *this client* asks *this
//! resolver* for *this name*, does it get an address. Everything a product might
//! want to say on the back of that — "sites are blocked", "usage is limited",
//! "screen time is enforced" — is a larger claim than the mechanism supports,
//! and the gap is where a person's trust gets spent.
//!
//! So the enforceable claims are a closed set ([`Claim`]), most of them are
//! refused ([`Coverage::attest`]), and the ones that are honoured arrive with
//! their gaps attached ([`Attestation::uncovered`]). There is no way to obtain
//! an attestation without the caveats, because the caveats are the part that
//! gets dropped when a screen gets built.
//!
//! # Screen time is not a DNS claim
//!
//! [`Claim::ScreenTime`] and its neighbours are refused outright rather than
//! approximated. A resolver cannot see time spent: it sees a lookup, once,
//! before a connection it never observes, for a session whose length it never
//! learns — and it does not see the lookup at all once the answer is cached, or
//! when the app talks to an address it already holds. A device can sit on a
//! blocked network all day and a device can be handed back after four hours of
//! a cached video stream, and DNS tells those apart not at all. "Screen time
//! enforced" on this mechanism is not an overstatement, it is a different
//! subject.

use serde::{Deserialize, Serialize};

/// A thing a platform might claim about a subject's reach.
///
/// Closed on purpose: a new claim has to be argued for here, against the
/// mechanism, rather than asserted at whichever surface needed it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Claim {
    /// A name on this unit's denylist does not resolve for this unit's client,
    /// through this resolver. Supported.
    DomainResolutionBlocked,
    /// A denied name resolves again for a bounded window, for this unit only.
    /// Supported.
    TimeBoxedDomainAllowance,
    /// One unit's allowance does not change what another unit resolves.
    /// Supported — and it is the reason [`crate::topology`] refuses shared
    /// clients.
    PerUnitIsolation,
    /// Traffic to a destination is prevented. Refused: DNS withholds a name, it
    /// does not stand between the subject and a socket.
    NetworkEgressBlocked,
    /// Time spent on a device or in an application is limited. Refused.
    ScreenTime,
    /// An application's own usage is capped. Refused.
    ApplicationUsageLimited,
    /// Content inside an application is filtered. Refused.
    InAppContentFiltered,
    /// The device is supervised. Refused: a resolver is not a device-management
    /// authority and cannot notice being replaced.
    DeviceSupervised,
}

impl Claim {
    /// Every claim, in a stable order.
    pub const ALL: [Self; 8] = [
        Self::DomainResolutionBlocked,
        Self::TimeBoxedDomainAllowance,
        Self::PerUnitIsolation,
        Self::NetworkEgressBlocked,
        Self::ScreenTime,
        Self::ApplicationUsageLimited,
        Self::InAppContentFiltered,
        Self::DeviceSupervised,
    ];

    /// The wire name, which is also the key in a refusal payload.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::DomainResolutionBlocked => "domain_resolution_blocked",
            Self::TimeBoxedDomainAllowance => "time_boxed_domain_allowance",
            Self::PerUnitIsolation => "per_unit_isolation",
            Self::NetworkEgressBlocked => "network_egress_blocked",
            Self::ScreenTime => "screen_time",
            Self::ApplicationUsageLimited => "application_usage_limited",
            Self::InAppContentFiltered => "in_app_content_filtered",
            Self::DeviceSupervised => "device_supervised",
        }
    }
}

/// A way past a DNS filter, or a thing it never saw in the first place.
///
/// These are not hypotheticals to be closed later by a better adapter. Each one
/// is outside what a recursive resolver can observe, so each survives any amount
/// of work on this crate.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Uncovered {
    /// The subject connects to an address instead of a name. No lookup happens.
    IpLiteral,
    /// The subject asks a different resolver — configured, hardcoded, or handed
    /// out by DHCP on another network.
    ForeignResolver,
    /// The subject uses DNS-over-HTTPS or DNS-over-TLS to somewhere else, which
    /// this resolver cannot see and a browser may prefer by default.
    EncryptedDnsElsewhere,
    /// A tunnel carries the query and the traffic past this resolver entirely.
    VpnOrProxy,
    /// The answer is already in the subject's cache, so no query is made and a
    /// revoked allowance keeps working until the record's TTL runs out.
    CachedAnswer,
    /// The traffic is not DNS: a peer-to-peer transport, a mesh, a relay.
    NonDnsTransport,
    /// How long anything was used. A resolver sees a lookup, not a session.
    TimeSpentUnobserved,
}

impl Uncovered {
    /// Every gap, in a stable order.
    pub const ALL: [Self; 7] = [
        Self::IpLiteral,
        Self::ForeignResolver,
        Self::EncryptedDnsElsewhere,
        Self::VpnOrProxy,
        Self::CachedAnswer,
        Self::NonDnsTransport,
        Self::TimeSpentUnobserved,
    ];

    /// The wire name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::IpLiteral => "ip_literal",
            Self::ForeignResolver => "foreign_resolver",
            Self::EncryptedDnsElsewhere => "encrypted_dns_elsewhere",
            Self::VpnOrProxy => "vpn_or_proxy",
            Self::CachedAnswer => "cached_answer",
            Self::NonDnsTransport => "non_dns_transport",
            Self::TimeSpentUnobserved => "time_spent_unobserved",
        }
    }
}

/// Why a claim is not this mechanism's to make.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("DNS filtering cannot support `{claim}`: {because}")]
pub struct TruthError {
    /// The refused claim's wire name.
    pub claim: &'static str,
    /// The mechanical reason, phrased for an operator reading a refusal.
    pub because: &'static str,
}

/// A supported claim, carrying the gaps that come with it.
///
/// Serialisable but not deserialisable, and that asymmetry is intentional: an
/// attestation is something this crate produces by consulting the mechanism, not
/// something a caller can hand back having stored it. Reading one from JSON would
/// be a way to assert coverage without asking.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Attestation {
    /// What is being claimed.
    pub claim: Claim,
    /// The component that would have to fail for the claim to fail.
    pub enforced_by: &'static str,
    /// The ways the claim can be walked around. Never empty.
    pub uncovered: &'static [Uncovered],
}

/// The coverage of DNS-layer enforcement, as a set of answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Coverage;

impl Coverage {
    /// The gaps that apply to every DNS claim without exception.
    pub const UNCOVERED: &'static [Uncovered] = &Uncovered::ALL;

    /// Whether a claim is this mechanism's to make.
    #[must_use]
    pub const fn supports(claim: Claim) -> bool {
        matches!(
            claim,
            Claim::DomainResolutionBlocked
                | Claim::TimeBoxedDomainAllowance
                | Claim::PerUnitIsolation
        )
    }

    /// Attest a claim, or refuse it.
    ///
    /// # Errors
    ///
    /// Returns [`TruthError`] for any claim outside [`Coverage::supports`], with
    /// the mechanical reason — a refusal a caller can show a person is worth
    /// more than a boolean.
    pub const fn attest(claim: Claim) -> Result<Attestation, TruthError> {
        let because = match claim {
            Claim::DomainResolutionBlocked
            | Claim::TimeBoxedDomainAllowance
            | Claim::PerUnitIsolation => {
                return Ok(Attestation {
                    claim,
                    enforced_by: "the recursive resolver this client is configured to use",
                    uncovered: Self::UNCOVERED,
                })
            }
            Claim::NetworkEgressBlocked => {
                "a resolver withholds a name; it is not on the path to the socket, and an \
                 address obtained any other way still connects"
            }
            Claim::ScreenTime => {
                "a resolver observes a lookup, not a session; it sees nothing at all once the \
                 answer is cached, and cannot distinguish four hours of use from none"
            }
            Claim::ApplicationUsageLimited => {
                "a resolver cannot attribute a query to an application, nor measure how long \
                 that application ran"
            }
            Claim::InAppContentFiltered => {
                "a resolver decides whole names; it cannot see inside a connection it never \
                 carried"
            }
            Claim::DeviceSupervised => {
                "a resolver is not a device authority: it cannot tell that it was replaced, \
                 bypassed, or that the device left the network"
            }
        };
        Err(TruthError {
            claim: claim.as_str(),
            because,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{Claim, Coverage, Uncovered};

    #[test]
    fn screen_time_is_refused_with_a_mechanical_reason() {
        // The claim this crate exists to not make.
        let error = Coverage::attest(Claim::ScreenTime).expect_err("screen time must be refused");
        assert_eq!(error.claim, "screen_time");
        assert!(error.because.contains("not a session"));
        assert!(!Coverage::supports(Claim::ScreenTime));
    }

    #[test]
    fn every_usage_and_egress_claim_is_refused() {
        for claim in [
            Claim::NetworkEgressBlocked,
            Claim::ScreenTime,
            Claim::ApplicationUsageLimited,
            Claim::InAppContentFiltered,
            Claim::DeviceSupervised,
        ] {
            assert!(!Coverage::supports(claim), "{claim:?} must not be claimed");
            let error = Coverage::attest(claim).expect_err("must refuse");
            assert_eq!(error.claim, claim.as_str());
            assert!(!error.because.is_empty(), "a refusal needs its reason");
        }
    }

    #[test]
    fn the_three_supported_claims_are_the_dns_shaped_ones() {
        for claim in [
            Claim::DomainResolutionBlocked,
            Claim::TimeBoxedDomainAllowance,
            Claim::PerUnitIsolation,
        ] {
            assert!(Coverage::supports(claim), "{claim:?}");
            let attestation = Coverage::attest(claim).expect("supported");
            assert_eq!(attestation.claim, claim);
        }
    }

    #[test]
    fn no_attestation_is_ever_unconditional() {
        // The caveats cannot be dropped, because there is no attestation
        // without them.
        for claim in Claim::ALL
            .iter()
            .copied()
            .filter(|c| Coverage::supports(*c))
        {
            let attestation = Coverage::attest(claim).expect("supported");
            assert!(
                !attestation.uncovered.is_empty(),
                "{claim:?} attested with no gaps"
            );
            assert!(attestation
                .uncovered
                .contains(&Uncovered::TimeSpentUnobserved));
            assert!(attestation
                .uncovered
                .contains(&Uncovered::EncryptedDnsElsewhere));
            assert!(attestation.uncovered.contains(&Uncovered::CachedAnswer));
        }
    }

    #[test]
    fn every_claim_and_gap_has_a_distinct_wire_name() {
        let mut claims: Vec<&str> = Claim::ALL.iter().map(|c| c.as_str()).collect();
        claims.sort_unstable();
        claims.dedup();
        assert_eq!(claims.len(), Claim::ALL.len());

        let mut gaps: Vec<&str> = Uncovered::ALL.iter().map(|u| u.as_str()).collect();
        gaps.sort_unstable();
        gaps.dedup();
        assert_eq!(gaps.len(), Uncovered::ALL.len());
    }

    #[test]
    fn every_claim_is_answered_one_way_or_the_other() {
        // No claim may sit in the enum without a decision, which is what would
        // let a new surface assume "probably fine".
        for claim in Claim::ALL {
            assert_eq!(Coverage::supports(claim), Coverage::attest(claim).is_ok());
        }
    }
}
