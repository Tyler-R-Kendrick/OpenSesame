//! Enforcement units and the isolation that keeps them apart (DNS-INSTANCE).
//!
//! An *enforcement unit* is one subject whose DNS reach is decided independently
//! of every other subject's. The obvious way to build that on Blocky is to give
//! each unit its own list group, and it does not work.
//!
//! Measured against [`crate::blocky::PINNED_VERSION`]: with one client subscribed
//! to groups `unit-alpha` and `unit-beta`, a name denied by `unit-alpha`'s
//! denylist was let through as soon as it was written into `unit-beta`'s
//! *allowlist* — Blocky answered `failed to resolve allowlisted domain` for it.
//! Allowlists are evaluated across all of the client's groups, so two units
//! sharing a client share each other's allowances. Repeating the same test with
//! `127.0.0.1` bound to `unit-alpha` alone and `127.0.0.2` bound to `unit-beta`
//! alone, the allowance in beta left alpha's client blocked.
//!
//! So the isolation boundary is the **client identity**, not the group, and
//! [`Topology::audit`] refuses any arrangement that binds one client to more than
//! one unit. That is not a style preference: such an arrangement compiles,
//! starts, serves traffic, and leaks allowances between units without ever
//! logging a complaint. `harness/blocky-env.sh probe-isolation` reproduces both
//! halves of the measurement.
//!
//! The second refusal is quieter and just as real. A client that appears in no
//! `clientGroupsBlock` entry is matched by no group, and a client matched by no
//! group is *unfiltered* — measured, not inferred. A topology that does not say
//! what happens to an unrecognised client is therefore fail-open, so
//! [`Unmatched`] makes the caller state which it meant, and
//! [`Unmatched::Unfiltered`] is a decision recorded rather than a default arrived
//! at.

pub mod ids;

pub use ids::{ClientId, IdError, UnitId};

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

/// Blocky's own key for "every client not matched by a more specific entry".
pub(crate) const DEFAULT_CLIENT_KEY: &str = "default";

/// Why a topology would not enforce what it appears to enforce.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum IsolationError {
    /// One client was bound to more than one unit, which shares allowances
    /// between them.
    #[error("client `{client}` is bound to units {units:?}; allowances would leak between them")]
    ClientSharedBetweenUnits {
        /// The over-bound client.
        client: String,
        /// Every unit claiming it, in a stable order.
        units: Vec<String>,
    },
    /// A unit had no client bound to it, so its lists decide nothing.
    #[error("unit `{unit}` has no client bound to it, so its lists enforce nothing")]
    UnitWithoutClients {
        /// The inert unit.
        unit: String,
    },
    /// The fallback named a unit that is not in the topology.
    #[error("fallback unit `{unit}` is not part of this topology")]
    FallbackUnitMissing {
        /// The dangling fallback.
        unit: String,
    },
}

/// What happens to a client no unit claims.
///
/// Measured: a client matched by no `clientGroupsBlock` entry is filtered by no
/// group at all. There is no safe default to pick on the caller's behalf, so this
/// is an explicit choice.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Unmatched {
    /// Unrecognised clients resolve without any filtering. Fail-open, stated out
    /// loud so it appears in a review rather than in an incident.
    Unfiltered,
    /// Unrecognised clients fall to this unit's lists.
    FallBackTo(UnitId),
}

/// The set of enforcement units on one Blocky instance, and their clients.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Topology {
    units: BTreeMap<UnitId, BTreeSet<ClientId>>,
    unmatched: Unmatched,
}

impl Topology {
    /// An empty topology with the stated handling for unrecognised clients.
    #[must_use]
    pub fn new(unmatched: Unmatched) -> Self {
        Self {
            units: BTreeMap::new(),
            unmatched,
        }
    }

    /// Bind a client to a unit, creating the unit if this is its first client.
    #[must_use]
    pub fn bind(mut self, unit: UnitId, client: ClientId) -> Self {
        self.units.entry(unit).or_default().insert(client);
        self
    }

    /// Declare a unit that has no client yet. [`Self::audit`] will refuse it,
    /// which is the point: an inert unit is visible instead of invisible.
    #[must_use]
    pub fn declare(mut self, unit: UnitId) -> Self {
        self.units.entry(unit).or_default();
        self
    }

    /// Every unit, in a stable order.
    pub fn units(&self) -> impl Iterator<Item = &UnitId> {
        self.units.keys()
    }

    /// Whether this topology enforces what it looks like it enforces.
    ///
    /// # Errors
    ///
    /// Returns [`IsolationError`] for a client shared between units (which leaks
    /// allowances), a unit with no clients (which enforces nothing), or a fallback
    /// naming a unit that is not here.
    pub fn audit(&self) -> Result<(), IsolationError> {
        let mut owners: BTreeMap<&ClientId, Vec<&UnitId>> = BTreeMap::new();
        for (unit, clients) in &self.units {
            if clients.is_empty() {
                return Err(IsolationError::UnitWithoutClients {
                    unit: unit.as_str().to_owned(),
                });
            }
            for client in clients {
                owners.entry(client).or_default().push(unit);
            }
        }

        for (client, units) in owners {
            if units.len() > 1 {
                return Err(IsolationError::ClientSharedBetweenUnits {
                    client: client.as_str().to_owned(),
                    units: units.iter().map(|u| u.as_str().to_owned()).collect(),
                });
            }
        }

        if let Unmatched::FallBackTo(unit) = &self.unmatched {
            if !self.units.contains_key(unit) {
                return Err(IsolationError::FallbackUnitMissing {
                    unit: unit.as_str().to_owned(),
                });
            }
        }

        Ok(())
    }

    /// Render Blocky's `clientGroupsBlock` map for this topology.
    ///
    /// # Errors
    ///
    /// Returns [`IsolationError`] when [`Self::audit`] would: a topology that does
    /// not isolate is not rendered into a config file that would run.
    pub fn client_groups_block(&self) -> Result<BTreeMap<String, Vec<String>>, IsolationError> {
        self.audit()?;

        let mut rendered = BTreeMap::new();
        for (unit, clients) in &self.units {
            for client in clients {
                // One unit per client is the audited invariant, so this never
                // overwrites a previous group list.
                rendered.insert(client.as_str().to_owned(), vec![unit.group_name()]);
            }
        }
        if let Unmatched::FallBackTo(unit) = &self.unmatched {
            rendered.insert(DEFAULT_CLIENT_KEY.to_owned(), vec![unit.group_name()]);
        }
        Ok(rendered)
    }
}

#[cfg(test)]
mod tests {
    use super::{ClientId, IsolationError, Topology, UnitId, Unmatched};

    fn unit(raw: &str) -> UnitId {
        UnitId::parse(raw).expect("unit id should parse")
    }

    fn client(raw: &str) -> ClientId {
        ClientId::parse(raw).expect("client id should parse")
    }

    #[test]
    fn a_client_shared_between_units_is_refused() {
        // This is the measured leak: two units on one client share allowances,
        // and nothing at runtime says so.
        let topology = Topology::new(Unmatched::Unfiltered)
            .bind(unit("alpha"), client("127.0.0.1"))
            .bind(unit("beta"), client("127.0.0.1"));

        let error = topology
            .audit()
            .expect_err("sharing a client must be refused");
        assert_eq!(
            error,
            IsolationError::ClientSharedBetweenUnits {
                client: "127.0.0.1".to_owned(),
                units: vec!["alpha".to_owned(), "beta".to_owned()],
            }
        );
        // And it is refused before it can become a config file.
        assert!(topology.client_groups_block().is_err());
    }

    #[test]
    fn one_client_per_unit_is_the_arrangement_that_isolates() {
        let topology = Topology::new(Unmatched::Unfiltered)
            .bind(unit("alpha"), client("127.0.0.1"))
            .bind(unit("beta"), client("127.0.0.2"));
        topology.audit().expect("distinct clients isolate");

        let rendered = topology.client_groups_block().expect("render");
        assert_eq!(rendered["127.0.0.1"], vec!["unit-alpha".to_owned()]);
        assert_eq!(rendered["127.0.0.2"], vec!["unit-beta".to_owned()]);
        // No client is subscribed to two groups anywhere in the output.
        assert!(rendered.values().all(|groups| groups.len() == 1));
    }

    #[test]
    fn a_unit_with_no_clients_enforces_nothing_and_says_so() {
        let topology = Topology::new(Unmatched::Unfiltered).declare(unit("orphan"));
        assert_eq!(
            topology.audit(),
            Err(IsolationError::UnitWithoutClients {
                unit: "orphan".to_owned()
            })
        );
    }

    #[test]
    fn the_fallback_must_name_a_unit_that_exists() {
        let topology = Topology::new(Unmatched::FallBackTo(unit("ghost")))
            .bind(unit("alpha"), client("127.0.0.1"));
        assert_eq!(
            topology.audit(),
            Err(IsolationError::FallbackUnitMissing {
                unit: "ghost".to_owned()
            })
        );
    }

    #[test]
    fn a_fallback_becomes_blockys_default_key() {
        let topology = Topology::new(Unmatched::FallBackTo(unit("alpha")))
            .bind(unit("alpha"), client("127.0.0.1"));
        let rendered = topology.client_groups_block().expect("render");
        assert_eq!(rendered["default"], vec!["unit-alpha".to_owned()]);
    }

    #[test]
    fn opposite_unit_policies_cannot_disable_each_other() {
        use crate::blocky::{DisableGroups, Operation};

        let topology = Topology::new(Unmatched::Unfiltered)
            .bind(unit("alpha"), client("127.0.0.1"))
            .bind(unit("beta"), client("127.0.0.2"));
        topology.audit().expect("distinct clients isolate");

        let alpha = DisableGroups::new(["unit-alpha"]).expect("named group");
        let spec = Operation::Disable {
            groups: alpha,
            window: None,
        }
        .spec();
        let groups = spec
            .query
            .iter()
            .find(|(key, _)| key == "groups")
            .map(|(_, value)| value.as_str())
            .expect("disable names groups");
        assert_eq!(groups, "unit-alpha");
        assert!(!groups.contains("unit-beta"));
        assert_eq!(
            DisableGroups::new(Vec::<String>::new()),
            Err(crate::blocky::ProtocolError::DisableWithoutGroups)
        );
    }

    #[test]
    fn leaving_unmatched_clients_unfiltered_writes_no_default_key() {
        // Fail-open is a recorded choice, and its rendering is the absence of a
        // `default` entry — which is exactly what was measured to be unfiltered.
        let topology =
            Topology::new(Unmatched::Unfiltered).bind(unit("alpha"), client("127.0.0.1"));
        let rendered = topology.client_groups_block().expect("render");
        assert!(!rendered.contains_key("default"));
    }
}
