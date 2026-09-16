use chrono::{Duration, Utc};
use opensesame_domain::ValidatedGrantChain;

use crate::budget::{keys, ResourceBudget};
use crate::capability::{AmbientKind, BrokeredCapability};
use crate::error::SandboxError;
use crate::fixtures::{chain, child_of, root_grant, single_chain};
use crate::profile::{AmbientDenial, SandboxProfile};

fn profile_from(chain: &ValidatedGrantChain) -> SandboxProfile {
    SandboxProfile::from_grant_chain(chain, Utc::now()).expect("profile derives")
}

#[test]
fn a_profile_carries_only_the_capabilities_the_chain_named() {
    let granted = single_chain(&["sandbox.emit", "sandbox.http"], &[]);
    let profile = profile_from(&granted);
    assert!(profile.grants(BrokeredCapability::Emit));
    assert!(profile.grants(BrokeredCapability::HttpFetch));
    assert!(!profile.grants(BrokeredCapability::Sign));
    assert!(!profile.grants(BrokeredCapability::TokenAcquire));
    assert_eq!(profile.capabilities().len(), 2);
}

#[test]
fn actions_that_merely_sound_ambient_confer_nothing() {
    // A grant may name whatever its issuer likes. None of it becomes a
    // filesystem, an environment, or a socket, because no such import
    // exists to link.
    let noisy = single_chain(
        &[
            "fs.read",
            "net.connect",
            "env.get",
            "process.spawn",
            "sandbox.emit",
        ],
        &[],
    );
    let profile = profile_from(&noisy);
    assert_eq!(
        profile.capabilities().iter().copied().collect::<Vec<_>>(),
        vec![BrokeredCapability::Emit]
    );
    assert_eq!(profile.ambient_denial(), AmbientDenial::TOTAL);
    assert!(profile.ambient_denial().is_total());
}

#[test]
fn a_chain_with_no_sandbox_action_gets_a_guest_that_can_only_compute() {
    let profile = profile_from(&single_chain(&["repository.read"], &[]));
    assert!(profile.capabilities().is_empty());
    // It is still a runnable profile — bounded compute with no reach is the
    // floor of this sandbox, not an error.
    assert!(profile.budget().is_runnable());
}

#[test]
fn delegation_narrows_capabilities_and_never_widens_them() {
    let root = root_grant(
        &["sandbox.emit", "sandbox.http", "sandbox.sign"],
        &[(keys::FUEL, 100_000)],
        Duration::hours(1),
    );
    let leaf = child_of(&root, &["sandbox.emit"], &[(keys::FUEL, 10_000)]);
    let delegated = chain(&[root, leaf], 0).expect("chain validates");
    let profile = profile_from(&delegated);

    assert_eq!(
        profile.capabilities().iter().copied().collect::<Vec<_>>(),
        vec![BrokeredCapability::Emit]
    );
    assert_eq!(profile.budget().fuel(), 10_000);
    assert_ne!(profile.root_grant_id(), profile.leaf_grant_id());
}

#[test]
fn the_tightest_hop_wins_even_when_the_leaf_asks_for_more() {
    // The leaf cannot ask for more than its parent — attenuation refuses
    // that outright — so the fold is checked the other way: a strict root
    // with a leaf that re-states the parent value still yields the strict
    // number, and nothing in the fold can raise it.
    let root = root_grant(
        &["sandbox.emit"],
        &[(keys::FUEL, 7_000), (keys::MEMORY_BYTES, 131_072)],
        Duration::hours(1),
    );
    let leaf = child_of(&root, &["sandbox.emit"], &[(keys::FUEL, 999_999_999)]);
    let delegated = chain(&[root, leaf], 0).expect("chain validates");
    let profile = profile_from(&delegated);
    assert_eq!(profile.budget().fuel(), 7_000);
    assert_eq!(profile.budget().max_memory_bytes(), 131_072);
}

#[test]
fn a_grant_cannot_buy_itself_a_bigger_budget_than_the_platform_ceiling() {
    let greedy = single_chain(
        &["sandbox.emit"],
        &[
            (keys::FUEL, i64::MAX),
            (keys::MEMORY_BYTES, i64::MAX),
            (keys::DEADLINE_MS, i64::MAX),
            (keys::EMIT_BYTES, i64::MAX),
        ],
    );
    let profile = profile_from(&greedy);
    let ceiling = ResourceBudget::CEILING;
    assert_eq!(profile.budget().fuel(), ceiling.fuel());
    assert_eq!(
        profile.budget().max_memory_bytes(),
        ceiling.max_memory_bytes()
    );
    assert_eq!(profile.budget().max_emit_bytes(), ceiling.max_emit_bytes());
}

#[test]
fn raw_credential_export_is_refused_outright_not_downgraded() {
    let mut root = root_grant(&["sandbox.emit"], &[], Duration::hours(1));
    root.constraints.raw_credential_export = true;
    let exporting = chain(&[root], 0).expect("chain validates");
    assert!(matches!(
        SandboxProfile::from_grant_chain(&exporting, Utc::now()),
        Err(SandboxError::RawExportDenied)
    ));
}

#[test]
fn a_run_is_clamped_to_the_time_left_on_the_authority() {
    let brief = root_grant(&["sandbox.emit"], &[], Duration::milliseconds(400));
    let brief = chain(&[brief], 0).expect("chain validates");
    let profile = profile_from(&brief);
    assert!(
        profile.budget().deadline() <= std::time::Duration::from_millis(400),
        "deadline {:?} outlives the grant",
        profile.budget().deadline()
    );
    assert!(profile.budget().deadline() > std::time::Duration::ZERO);
}

#[test]
fn an_authority_with_no_time_left_admits_no_profile() {
    let chain = single_chain(&["sandbox.emit"], &[]);
    let after_expiry = chain.leaf().constraints.expires_at + Duration::seconds(1);
    assert!(matches!(
        SandboxProfile::from_grant_chain(&chain, after_expiry),
        Err(SandboxError::Profile(_))
    ));
}

#[test]
fn a_malformed_budget_is_refused_rather_than_floored() {
    let zeroed = single_chain(&["sandbox.emit"], &[(keys::FUEL, 0)]);
    assert!(matches!(
        SandboxProfile::from_grant_chain(&zeroed, Utc::now()),
        Err(SandboxError::Profile(_))
    ));
}

#[test]
fn a_profile_binds_the_chain_it_came_from_and_no_other() {
    let mine = single_chain(&["sandbox.emit"], &[]);
    let theirs = single_chain(&["sandbox.emit"], &[]);
    let profile = profile_from(&mine);
    assert!(profile.binds_chain(&mine));
    assert!(!profile.binds_chain(&theirs));
}

#[test]
fn a_profile_carries_the_generation_it_was_minted_against() {
    let root = root_grant(&["sandbox.emit"], &[], Duration::hours(1));
    let at_seven = chain(&[root], 7).expect("chain validates");
    assert_eq!(profile_from(&at_seven).invalidation_generation(), 7);
}

#[test]
fn ambient_denial_has_no_partial_value_reachable_from_a_profile() {
    // Every capability set, including the full one, denies every ambient
    // surface. If a field ever became settable this sweep would catch it.
    for actions in [
        vec!["repository.read"],
        vec!["sandbox.emit"],
        vec![
            "sandbox.emit",
            "sandbox.http",
            "sandbox.sign",
            "sandbox.token",
        ],
    ] {
        let profile = profile_from(&single_chain(&actions, &[]));
        let denial = profile.ambient_denial();
        for kind in AmbientKind::ALL {
            assert!(denial.denies(kind), "{kind:?} must be out of reach");
        }
        assert!(denial.is_total());
    }
}
