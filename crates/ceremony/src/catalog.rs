//! Which providers have a ceremony, and how far it gets (ADR 0082 §7).
//!
//! Checked in rather than fetched. Asking a server which ceremony recipe to use
//! for `provider-x` tells that server which provider this user is onboarding,
//! which is precisely the kind of question the sealed store exists so nobody
//! has to answer — ADR 0052 §12's "a lookup is a disclosure", applied to
//! onboarding.
//!
//! The catalog records *capabilities*, never tiers. A tier is a decision, and
//! [`crate::tier::resolve`] makes it per phase from these facts, so a stale
//! entry cannot pin a provider to a tier its capabilities no longer match.
//!
//! Absence is meaningful and is not a gap: a provider with no entry resolves to
//! C3 for every phase and gets the copy-paste instructions it has today. ADR
//! 0082's alternatives section is explicit that a ceremony which cannot run
//! must leave the user exactly where they started, never at a dead end.

use serde::{Deserialize, Serialize};

use crate::capture::Slot;
use crate::tier::{resolve, Phase, ProviderCapability, Tier};

/// The checked-in catalog, compiled in.
///
/// `include_str!` rather than a read: this crate does no I/O, and the data is
/// reviewed and versioned with the code that reads it.
const CATALOG_JSON: &str = include_str!("../catalog.json");

/// One provider's ceremony coverage, as the catalog records it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogEntry {
    /// Must name a provider in `crates/connection-broker/src/catalog.json`.
    pub provider_id: String,
    #[serde(default)]
    pub native_registration: bool,
    /// Where the native flow is implemented or documented, for a reviewer.
    #[serde(default)]
    pub native_registration_note: Option<String>,
    #[serde(default)]
    pub recipe: bool,
    #[serde(default)]
    pub agentic_allowed: bool,
    /// The capture slots this ceremony declares, by wire name.
    #[serde(default)]
    pub declares: Vec<String>,
    /// The round trip that proves the credential works (ADR 0082 §6), in
    /// words rather than as a URL.
    #[serde(default)]
    pub verifies_by: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

impl CatalogEntry {
    /// The three facts [`resolve`] needs.
    #[must_use]
    pub const fn capability(&self) -> ProviderCapability {
        ProviderCapability {
            has_native_registration: self.native_registration,
            has_recipe: self.recipe,
            agentic_allowed: self.agentic_allowed,
        }
    }

    /// The declared slots, as slots rather than strings.
    ///
    /// A name the closed set does not contain is dropped rather than erroring,
    /// and [`Catalog::load`]'s own test refuses one — so a typo fails review
    /// instead of failing a user's ceremony at 2am.
    #[must_use]
    pub fn declared_slots(&self) -> Vec<Slot> {
        self.declares
            .iter()
            .filter_map(|name| Slot::parse(name))
            .collect()
    }

    /// What tier each phase of this provider's ceremony resolves to.
    #[must_use]
    pub fn plan(&self) -> Vec<(Phase, Tier)> {
        let capability = self.capability();
        Phase::ALL
            .into_iter()
            .map(|phase| (phase, resolve(phase, capability)))
            .collect()
    }

    /// Whether any part of this ceremony can run at all.
    ///
    /// False when every phase is C3, which is a provider the user must still
    /// set up by hand. Reported rather than hidden: a catalog that listed it as
    /// covered would be the "looks configured, does nothing" failure again.
    #[must_use]
    pub fn is_runnable(&self) -> bool {
        self.plan().iter().any(|(_, tier)| *tier != Tier::Blocked)
    }
}

#[derive(Deserialize)]
struct CatalogFile {
    ceremonies: Vec<CatalogEntry>,
}

/// Every provider the ceremony catalog covers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Catalog {
    entries: Vec<CatalogEntry>,
}

impl Catalog {
    /// Parse the checked-in catalog.
    ///
    /// # Panics
    ///
    /// If the compiled-in JSON is malformed. That is a build-time fact about a
    /// reviewed file, not a runtime condition, and a `Result` here would push
    /// every caller into handling an error that cannot occur in a shipped
    /// binary.
    #[must_use]
    pub fn load() -> Self {
        let file: CatalogFile = serde_json::from_str(CATALOG_JSON)
            .expect("the checked-in ceremony catalog is valid JSON");
        Self {
            entries: file.ceremonies,
        }
    }

    #[must_use]
    pub fn entries(&self) -> &[CatalogEntry] {
        &self.entries
    }

    /// One provider's entry, if the catalog covers it.
    #[must_use]
    pub fn get(&self, provider_id: &str) -> Option<&CatalogEntry> {
        self.entries
            .iter()
            .find(|entry| entry.provider_id == provider_id)
    }

    /// What tier each phase resolves to for a provider.
    ///
    /// A provider the catalog does not cover is not an error: every phase is
    /// C3, which is the honest answer and the one that routes the user to the
    /// instructions rather than to a dead end.
    #[must_use]
    pub fn plan_for(&self, provider_id: &str) -> Vec<(Phase, Tier)> {
        self.get(provider_id).map_or_else(
            || {
                Phase::ALL
                    .into_iter()
                    .map(|phase| (phase, Tier::Blocked))
                    .collect()
            },
            CatalogEntry::plan,
        )
    }
}

impl Default for Catalog {
    fn default() -> Self {
        Self::load()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_checked_in_catalog_parses() {
        let catalog = Catalog::load();
        assert!(
            !catalog.entries().is_empty(),
            "a catalog with no entries would silently make every provider C3",
        );
    }

    #[test]
    fn every_declared_slot_is_a_slot_the_closed_set_knows() {
        // A typo here would silently drop a capture the ceremony depends on,
        // and the run would report success having sealed one thing less.
        let catalog = Catalog::load();
        for entry in catalog.entries() {
            for name in &entry.declares {
                assert!(
                    Slot::parse(name).is_some(),
                    "{}: `{name}` is not a capture slot",
                    entry.provider_id,
                );
            }
            assert_eq!(
                entry.declared_slots().len(),
                entry.declares.len(),
                "{}: a declared slot was dropped in parsing",
                entry.provider_id,
            );
        }
    }

    #[test]
    fn provider_ids_are_unique() {
        let catalog = Catalog::load();
        let mut ids: Vec<&str> = catalog
            .entries()
            .iter()
            .map(|entry| entry.provider_id.as_str())
            .collect();
        ids.sort_unstable();
        let before = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), before, "two entries claim the same provider");
    }

    #[test]
    fn a_ceremony_that_can_run_says_how_it_proves_itself() {
        // ADR 0082 §6: success is a round trip. An entry that is reachable and
        // names no verification is one that would report success on a form.
        let catalog = Catalog::load();
        for entry in catalog.entries() {
            if entry.is_runnable() {
                assert!(
                    entry
                        .verifies_by
                        .as_deref()
                        .is_some_and(|proof| proof.len() > 5),
                    "{}: runnable, and does not say how it proves the credential works",
                    entry.provider_id,
                );
            }
        }
    }

    #[test]
    fn github_registration_resolves_to_its_own_manifest_endpoint() {
        // The motivating case, read from the data rather than from a fixture.
        let catalog = Catalog::load();
        let github = catalog.get("github").expect("github is in the catalog");
        assert!(github.native_registration);
        assert_eq!(
            github
                .plan()
                .into_iter()
                .find(|(phase, _)| *phase == Phase::Registration)
                .map(|(_, tier)| tier),
            Some(Tier::ProviderNative),
        );
        assert!(github.declared_slots().contains(&Slot::InstallationId));
    }

    #[test]
    fn a_provider_the_catalog_does_not_cover_is_blocked_rather_than_missing() {
        // Absence is an answer: C3, and the instructions the user has today.
        let catalog = Catalog::load();
        assert!(catalog.get("a-provider-nobody-has-covered").is_none());
        let plan = catalog.plan_for("a-provider-nobody-has-covered");
        assert_eq!(plan.len(), Phase::ALL.len());
        assert!(plan.iter().all(|(_, tier)| *tier == Tier::Blocked));
    }

    #[test]
    fn a_plan_covers_every_phase_exactly_once() {
        let catalog = Catalog::load();
        for entry in catalog.entries() {
            let plan = entry.plan();
            assert_eq!(plan.len(), Phase::ALL.len(), "{}", entry.provider_id);
            for phase in Phase::ALL {
                assert_eq!(
                    plan.iter().filter(|(p, _)| *p == phase).count(),
                    1,
                    "{}: {phase:?} appears other than once",
                    entry.provider_id,
                );
            }
        }
    }

    #[test]
    fn nothing_in_the_catalog_enables_a_model_without_a_recipe_to_fall_back_on() {
        // Not a rule ADR 0082 states, and the one shape worth refusing anyway:
        // C2 with no C1 beneath it means a provider whose *only* automated path
        // is a model driving somebody's logged-in browser. Every entry that
        // enables agentic must also ship the recipe it can fall back to.
        let catalog = Catalog::load();
        for entry in catalog.entries() {
            if entry.agentic_allowed {
                assert!(
                    entry.recipe,
                    "{}: agentic is enabled with no recipe beneath it",
                    entry.provider_id,
                );
            }
        }
    }
}
