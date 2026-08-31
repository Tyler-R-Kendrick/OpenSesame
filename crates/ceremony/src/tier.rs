use serde::{Deserialize, Serialize};

/// How a ceremony gets a provider registered, cheapest and safest first.
///
/// Deliberately the same shape as ADR 0076 §2's rotation ladder. The
/// discipline is the point, not the symmetry: a run resolves to the highest
/// tier that covers the work, and a model appears only where nothing else can.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    /// The provider's own registration flow — GitHub's App Manifest, RFC 7591
    /// Dynamic Client Registration discovered through RFC 8414, or any
    /// documented registration endpoint.
    ///
    /// No browser, no recipe, no model. This is the tier whose coverage is the
    /// number worth tracking (ADR 0082 consequences).
    ProviderNative,
    /// A signed, checked-in step IR over the provider's own UI, replayed with
    /// no model in the loop. Covers what C0 does not: sign-in state, org
    /// selection, and the install step that registration does not perform.
    Deterministic,
    /// A model plans against a redacted DOM. Gated, and requires the user
    /// present and watching (ADR 0082 §4, §5).
    Agentic,
    /// Nothing resolved. Notify, park, and leave the user the instructions they
    /// would have had anyway — never a dead end (ADR 0082 alternatives).
    Blocked,
}

impl Tier {
    pub const ALL: [Self; 4] = [
        Self::ProviderNative,
        Self::Deterministic,
        Self::Agentic,
        Self::Blocked,
    ];

    /// Frozen wire name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ProviderNative => "c0_provider_native",
            Self::Deterministic => "c1_deterministic",
            Self::Agentic => "c2_agentic",
            Self::Blocked => "c3_blocked",
        }
    }

    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|tier| tier.as_str() == raw)
    }

    /// Whether this tier puts a model in the loop.
    #[must_use]
    pub const fn uses_a_model(self) -> bool {
        matches!(self, Self::Agentic)
    }

    /// Whether this tier drives a browser at all.
    #[must_use]
    pub const fn drives_a_browser(self) -> bool {
        matches!(self, Self::Deterministic | Self::Agentic)
    }

    /// Whether the user must be present and watching for this tier to run.
    ///
    /// C2 requires it by ADR 0082 §5. C1 gets it too: a ceremony creates
    /// authority on somebody's account at a third party, and ADR 0082 §9 turns
    /// live preview on by default for exactly that reason. C0 touches no
    /// browser, so there is nothing to watch.
    #[must_use]
    pub const fn requires_a_present_user(self) -> bool {
        self.drives_a_browser()
    }
}

/// What a provider offers, as the catalog records it.
///
/// Three independent facts rather than a precomputed tier, because the tier is
/// a *decision* and recomputing it from the facts is what keeps a stale catalog
/// entry from pinning a provider to a tier its capabilities no longer match.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderCapability {
    /// The provider publishes a registration endpoint we can call.
    pub has_native_registration: bool,
    /// A signed recipe covering this provider is checked in.
    pub has_recipe: bool,
    /// The deployment permits a model to drive this provider's UI.
    pub agentic_allowed: bool,
}

impl ProviderCapability {
    /// Nothing available: the honest default for a provider nobody has covered.
    #[must_use]
    pub const fn none() -> Self {
        Self {
            has_native_registration: false,
            has_recipe: false,
            agentic_allowed: false,
        }
    }
}

/// What part of a ceremony is being resolved.
///
/// Registration and installation are separate steps at GitHub and at every
/// provider shaped like it, and treating them as one is the failure ADR 0082
/// §1 names: an app registered and never installed fails months later and looks
/// like a bug in `OpenSesame`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Have an account, be signed in, be signed in as the right identity.
    Preconditions,
    /// Create the app or client and capture what it returns.
    Registration,
    /// Grant it to an organization. Separate, consent-bearing, and the step
    /// most often skipped.
    Installation,
    /// Use the captured credential once, for real (ADR 0082 §6).
    Verification,
}

impl Phase {
    pub const ALL: [Self; 4] = [
        Self::Preconditions,
        Self::Registration,
        Self::Installation,
        Self::Verification,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Preconditions => "preconditions",
            Self::Registration => "registration",
            Self::Installation => "installation",
            Self::Verification => "verification",
        }
    }

    /// Whether a provider's own registration endpoint can cover this phase.
    ///
    /// Only registration. A manifest endpoint mints an app; it cannot make
    /// somebody signed in, it cannot install on an org the user has not named,
    /// and it cannot prove the result works. Those are why the ceremony exists
    /// at all — ADR 0082 §1's "the ceremony worth automating is the
    /// orchestration, not the form".
    #[must_use]
    pub const fn native_registration_can_cover(self) -> bool {
        matches!(self, Self::Registration)
    }
}

/// Resolve one phase to the tier that will run it.
///
/// The rule ADR 0082 §1 states as a bug class rather than a preference: a
/// provider with a C0 path is never driven at C1 or C2 *for the part C0
/// covers*. Scraping a form the provider offers an endpoint for is more
/// fragile, discards a supported path, and puts an agent in a consent screen
/// that exists to be read by a person.
#[must_use]
pub fn resolve(phase: Phase, capability: ProviderCapability) -> Tier {
    if capability.has_native_registration && phase.native_registration_can_cover() {
        return Tier::ProviderNative;
    }
    if capability.has_recipe {
        return Tier::Deterministic;
    }
    if capability.agentic_allowed {
        return Tier::Agentic;
    }
    Tier::Blocked
}

#[cfg(test)]
mod tests {
    use super::*;

    fn github() -> ProviderCapability {
        ProviderCapability {
            has_native_registration: true,
            has_recipe: true,
            agentic_allowed: true,
        }
    }

    #[test]
    fn wire_names_are_frozen() {
        let names: Vec<&str> = Tier::ALL.iter().map(|tier| tier.as_str()).collect();
        assert_eq!(
            names,
            [
                "c0_provider_native",
                "c1_deterministic",
                "c2_agentic",
                "c3_blocked"
            ]
        );
        for tier in Tier::ALL {
            assert_eq!(Tier::parse(tier.as_str()), Some(tier));
        }
        assert_eq!(Tier::parse("c4_magic"), None);
    }

    #[test]
    fn a_provider_with_a_registration_endpoint_is_never_scraped_for_registration() {
        // ADR 0082 §1 states this as a bug class, so it gets a test rather than
        // a comment: GitHub has a manifest flow *and* a recipe *and* agentic
        // enabled, and registration still resolves to the endpoint.
        assert_eq!(resolve(Phase::Registration, github()), Tier::ProviderNative);
    }

    #[test]
    fn the_phases_a_registration_endpoint_cannot_cover_fall_through_to_a_recipe() {
        // Being signed in, choosing an org, and installing are not things a
        // manifest endpoint does — which is the whole reason the ceremony is
        // about orchestration rather than the form.
        for phase in [
            Phase::Preconditions,
            Phase::Installation,
            Phase::Verification,
        ] {
            assert_eq!(
                resolve(phase, github()),
                Tier::Deterministic,
                "{phase:?} must not be claimed by the registration endpoint",
            );
        }
    }

    #[test]
    fn a_provider_with_nothing_blocks_rather_than_improvising() {
        for phase in Phase::ALL {
            assert_eq!(resolve(phase, ProviderCapability::none()), Tier::Blocked);
        }
    }

    #[test]
    fn agentic_is_reached_only_when_no_recipe_exists_and_it_is_permitted() {
        let no_recipe = ProviderCapability {
            has_native_registration: false,
            has_recipe: false,
            agentic_allowed: true,
        };
        assert_eq!(resolve(Phase::Installation, no_recipe), Tier::Agentic);

        let gated = ProviderCapability {
            agentic_allowed: false,
            ..no_recipe
        };
        assert_eq!(
            resolve(Phase::Installation, gated),
            Tier::Blocked,
            "a deployment that has not enabled C2 gets C3, never C2 anyway",
        );
    }

    #[test]
    fn a_recipe_beats_a_model_wherever_both_are_available() {
        let both = ProviderCapability {
            has_native_registration: false,
            has_recipe: true,
            agentic_allowed: true,
        };
        for phase in Phase::ALL {
            assert_eq!(resolve(phase, both), Tier::Deterministic, "{phase:?}");
        }
    }

    #[test]
    fn every_tier_that_touches_a_browser_needs_the_user_watching() {
        // ADR 0082 §4 and §9: the user is present by definition, and a
        // ceremony creating authority on their account is one they should see.
        assert!(!Tier::ProviderNative.requires_a_present_user());
        assert!(Tier::Deterministic.requires_a_present_user());
        assert!(Tier::Agentic.requires_a_present_user());
        for tier in Tier::ALL {
            assert_eq!(tier.requires_a_present_user(), tier.drives_a_browser());
        }
    }

    #[test]
    fn only_the_agentic_tier_puts_a_model_in_the_loop() {
        for tier in Tier::ALL {
            assert_eq!(tier.uses_a_model(), tier == Tier::Agentic);
        }
    }

    #[test]
    fn the_ladder_is_ordered_cheapest_and_safest_first() {
        assert!(Tier::ProviderNative < Tier::Deterministic);
        assert!(Tier::Deterministic < Tier::Agentic);
        assert!(Tier::Agentic < Tier::Blocked);
    }
}
