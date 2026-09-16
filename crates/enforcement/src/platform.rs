//! The descriptors this repository can actually stand behind.
//!
//! Each entry names the code that holds it, and the two mobile entries name
//! nothing because there is nothing: there is no iOS adapter and no Android
//! adapter in this repository, so both declare
//! [`AdapterStatus::Absent`](crate::descriptor::AdapterStatus::Absent) and
//! answer every dimension with [`UnsupportedReason::NoAdapter`]. A preflight
//! against them refuses with that reason attached, which is the behaviour we
//! want: an operator is told the platform is unsupported, not handed a grant
//! whose terms nothing keeps.
//!
//! The first three entries are the argument for the whole crate. They run on
//! the same host, under the same gateway, and they answer the three dimensions
//! differently, because what decides the answer is who holds the value:
//!
//! | platform | expiry | termination | isolation |
//! |---|---|---|---|
//! | `host-brokered-invocation` | broker re-reads the deadline | broker declines the next call | egress allowlist |
//! | `host-minted-token` | provider TTL, inferred | *unsupported* | *unsupported* |
//! | `host-minted-token-revocable` | provider TTL, inferred | provider revocation | *unsupported* |
//!
//! No scalar orders those rows. A deployment that needs termination must
//! broker the calls or pick a provider that offers revocation; a deployment
//! that needs isolation must broker the calls, full stop.

use crate::conformance::ConformanceViolation;
use crate::descriptor::{AdapterStatus, EnforcementDescriptor};
use crate::dimension::Dimension;
use crate::guarantee::{Bypass, Guarantee, Latency, Mechanism, Observability, Survival};
use crate::ownership::{EnforcementPoint, SubjectSurface};
use crate::unsupported::{Remedy, Unsupported, UnsupportedReason};

/// Every descriptor, already audited.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Catalog {
    entries: Vec<EnforcementDescriptor>,
}

impl Catalog {
    /// Every entry.
    #[must_use]
    pub fn all(&self) -> &[EnforcementDescriptor] {
        &self.entries
    }

    /// One platform's descriptor.
    #[must_use]
    pub fn find(&self, platform: &str) -> Option<&EnforcementDescriptor> {
        self.entries
            .iter()
            .find(|descriptor| descriptor.platform() == platform)
    }

    /// Every descriptor for one surface.
    #[must_use]
    pub fn with_surface(&self, surface: SubjectSurface) -> Vec<&EnforcementDescriptor> {
        self.entries
            .iter()
            .filter(|descriptor| descriptor.surface() == surface)
            .collect()
    }
}

/// One platform's descriptor failing its own audit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogError {
    /// Which platform.
    pub platform: &'static str,
    /// What it claimed that it may not.
    pub violations: Vec<ConformanceViolation>,
}

/// Build the catalog.
///
/// Fallible on purpose: a descriptor is audited as it is built, so an entry
/// added here with an inconsistent claim fails at the one call site every
/// caller goes through rather than being discovered by whoever relied on it.
///
/// # Errors
///
/// A [`CatalogError`] per non-conforming entry.
pub fn catalog() -> Result<Catalog, Vec<CatalogError>> {
    let built = [
        ("host-brokered-invocation", brokered_invocation()),
        ("host-minted-token", minted_token()),
        ("host-minted-token-revocable", minted_token_revocable()),
        ("apple-ios", apple_ios()),
        ("android", android()),
        ("discord-live", discord_live()),
        ("blocky-live-saas", blocky_live_saas()),
    ];
    let mut entries = Vec::new();
    let mut errors = Vec::new();
    for (platform, result) in built {
        match result {
            Ok(descriptor) => entries.push(descriptor),
            Err(violations) => errors.push(CatalogError {
                platform,
                violations,
            }),
        }
    }
    if errors.is_empty() {
        Ok(Catalog { entries })
    } else {
        Err(errors)
    }
}

type Built = Result<EnforcementDescriptor, Vec<ConformanceViolation>>;

/// The subject never holds the value: `crates/invoke-through` brokers the call
/// and `apps/gateway` decides it.
fn brokered_invocation() -> Built {
    EnforcementDescriptor::builder(
        "host-brokered-invocation",
        SubjectSurface::BrokeredInvocation,
        AdapterStatus::Implemented {
            module: "apps/gateway + crates/invoke-through",
        },
    )
    .enforced(
        Dimension::Expiry,
        Guarantee::new(
            Mechanism::GrantExpiryCheck,
            EnforcementPoint::HostBroker,
            Bypass::DistinctAuthority,
            Latency::BeforeNextUse,
            Survival::ProcessRestart,
            Observability::Reported,
        ),
    )
    .enforced(
        Dimension::Termination,
        Guarantee::new(
            Mechanism::BrokerRefusal,
            EnforcementPoint::HostBroker,
            Bypass::DistinctAuthority,
            Latency::BeforeNextUse,
            Survival::ProcessRestart,
            Observability::Reported,
        ),
    )
    .enforced(
        Dimension::Isolation,
        Guarantee::new(
            Mechanism::EgressAllowlist,
            EnforcementPoint::NetworkBroker,
            Bypass::DistinctAuthority,
            Latency::BeforeNextUse,
            // The allowlist is memory-resident by design (ADR 0048): it holds
            // for the life of the broker process and is rebuilt, not reloaded.
            Survival::ProcessLifetime,
            Observability::Reported,
        ),
    )
    .build()
}

/// The value was minted to the subject and the provider offers no control
/// beyond the lifetime it stamped on the token.
fn minted_token() -> Built {
    EnforcementDescriptor::builder(
        "host-minted-token",
        SubjectSurface::MintedCredential,
        AdapterStatus::Implemented {
            module: "crates/connection-broker",
        },
    )
    .enforced(Dimension::Expiry, provider_ttl())
    .unsupported(
        Dimension::Termination,
        Unsupported::new(
            UnsupportedReason::ProviderDoesNotOffer,
            Remedy::ChooseProviderWithControl,
            "the provider publishes no revocation endpoint",
        ),
    )
    .unsupported(Dimension::Isolation, value_left_the_boundary())
    .build()
}

/// The value was minted, but the provider will revoke on request.
fn minted_token_revocable() -> Built {
    EnforcementDescriptor::builder(
        "host-minted-token-revocable",
        SubjectSurface::MintedCredential,
        AdapterStatus::Implemented {
            module: "crates/connection-broker",
        },
    )
    .enforced(Dimension::Expiry, provider_ttl())
    .enforced(
        Dimension::Termination,
        Guarantee::new(
            Mechanism::ProviderRevocation,
            EnforcementPoint::Provider,
            Bypass::DistinctAuthority,
            // A revocation call that returns is a report; how long the
            // provider's own caches take is theirs, and a minute is the bound
            // we will state on its behalf.
            Latency::WithinSeconds(60),
            Survival::NetworkPartition,
            Observability::Reported,
        ),
    )
    .unsupported(Dimension::Isolation, value_left_the_boundary())
    .build()
}

fn provider_ttl() -> Guarantee {
    Guarantee::new(
        Mechanism::ProviderTokenTtl,
        EnforcementPoint::Provider,
        Bypass::DistinctAuthority,
        // Clock skew and the provider's own token caches. We set the lifetime;
        // we do not watch it lapse.
        Latency::WithinSeconds(300),
        Survival::NetworkPartition,
        Observability::Inferred,
    )
}

fn value_left_the_boundary() -> Unsupported {
    Unsupported::new(
        UnsupportedReason::ValueLeftTheBoundary,
        Remedy::BrokerTheInvocation,
        "nothing stands between the holder and the credential once it is minted",
    )
}

/// No iOS adapter exists in this repository.
///
/// Written out rather than omitted: a platform missing from the catalogue
/// looks like an oversight, and the code that looks it up would fall back to
/// something. An entry that refuses every dimension by name cannot be mistaken
/// for either.
fn apple_ios() -> Built {
    foreign_platform_without_adapter("apple-ios", "no iOS enforcement adapter exists")
}

/// No Android adapter exists in this repository.
fn android() -> Built {
    foreign_platform_without_adapter("android", "no Android enforcement adapter exists")
}

/// Live Discord guild enforcement is not a catalogued guarantee.
///
/// `crates/collab-adapter` has an HTTP fixture and an `#[ignore]`d opt-in live
/// test. Neither is an issuance-path adapter: a grant that needs Discord to
/// hold expiry/termination/isolation must refuse here rather than borrow the
/// fixture's self-consistency as proof the guild will enforce.
fn discord_live() -> Built {
    foreign_platform_without_adapter(
        "discord-live",
        "live Discord guild enforcement is unsupported; fixture/opt-in only",
    )
}

/// Remote Blocky-as-a-service is not a catalogued guarantee.
///
/// `crates/dns-enforcement` talks to a local disposable Blocky and refuses with
/// `CapabilityUnavailable` when none is present. A remote SaaS endpoint is a
/// different trust boundary and must not inherit the local adapter's claims.
fn blocky_live_saas() -> Built {
    foreign_platform_without_adapter(
        "blocky-live-saas",
        "remote Blocky SaaS enforcement is unsupported; local disposable only",
    )
}

fn foreign_platform_without_adapter(platform: &'static str, detail: &'static str) -> Built {
    let absent = Unsupported::new(UnsupportedReason::NoAdapter, Remedy::NoneKnown, detail);
    EnforcementDescriptor::builder(
        platform,
        SubjectSurface::ForeignPlatformApp,
        AdapterStatus::Absent,
    )
    .unsupported(Dimension::Expiry, absent)
    .unsupported(Dimension::Termination, absent)
    .unsupported(Dimension::Isolation, absent)
    .build()
}
