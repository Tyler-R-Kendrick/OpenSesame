//! POL-COMBINE: the combining rule is deny-overrides over a closed world, and
//! it is a function of the verdicts rather than of the order they arrive in.

use opensesame_authz::{
    deny_overrides, AuthZenObligation, DenyReason, Effect, LayerOutcome, PolicyFault, PolicyLayer,
};
use serde_json::json;

fn obligation(id: &str) -> AuthZenObligation {
    AuthZenObligation {
        id: id.to_owned(),
        attributes: json!({"signed": true}),
    }
}

#[test]
fn a_denial_anywhere_denies_whatever_order_the_layers_arrive_in() {
    let permit = || LayerOutcome::permit(PolicyLayer::Relationship);
    let deny = || {
        LayerOutcome::deny(
            PolicyLayer::Conditions,
            DenyReason::GrantAction("repository.delete".into()),
        )
    };
    let other_permit = || LayerOutcome::permit(PolicyLayer::Availability);

    for outcomes in [
        vec![permit(), deny(), other_permit()],
        vec![deny(), permit(), other_permit()],
        vec![other_permit(), permit(), deny()],
    ] {
        let combined = deny_overrides(outcomes);
        assert!(!combined.permitted());
        assert_eq!(
            combined.reason().map(DenyReason::code),
            Some("grant_action")
        );
        assert!(
            combined.obligations().is_empty(),
            "a denial has nothing to discharge"
        );
    }
}

#[test]
fn a_layer_that_could_not_evaluate_has_not_permitted() {
    let combined = deny_overrides(vec![
        LayerOutcome::permit(PolicyLayer::Relationship),
        LayerOutcome::fault(
            PolicyLayer::Evidence,
            PolicyFault::MissingEvidence(opensesame_authz::RequirementKind::Assurance),
        ),
        LayerOutcome::permit(PolicyLayer::Executability),
    ]);
    assert!(!combined.permitted());
    assert_eq!(
        combined.reason().map(DenyReason::code),
        Some("evidence_missing")
    );
}

#[test]
fn an_unreachable_authority_outranks_a_later_denial() {
    // Both refuse. Which one is reported matters: "the authority plane is down"
    // is a retry, "you are not permitted" is not.
    let combined = deny_overrides(vec![
        LayerOutcome::deny(
            PolicyLayer::Conditions,
            DenyReason::GrantResource("repo:victim/secrets".into()),
        ),
        LayerOutcome::fault(PolicyLayer::Availability, PolicyFault::AuthorityUnavailable),
    ]);
    assert_eq!(
        combined.reason().map(DenyReason::code),
        Some("authority_unavailable")
    );
}

#[test]
fn nothing_applying_is_not_permission() {
    let combined = deny_overrides(vec![
        LayerOutcome::not_applicable(PolicyLayer::GrantAuthority),
        LayerOutcome::not_applicable(PolicyLayer::Evidence),
    ]);
    assert!(!combined.permitted());
    assert_eq!(
        combined.reason().map(DenyReason::code),
        Some("no_applicable_rule")
    );
    assert!(
        !deny_overrides(vec![]).permitted(),
        "an empty policy set permits nothing"
    );
}

#[test]
fn every_permitting_layers_obligations_survive_the_combination() {
    let combined = deny_overrides(vec![
        LayerOutcome::permit_with(
            PolicyLayer::Executability,
            vec![obligation("receipt.required")],
        ),
        LayerOutcome::permit_with(
            PolicyLayer::Evidence,
            vec![obligation("receipt.required"), obligation("notify.owner")],
        ),
        LayerOutcome::not_applicable(PolicyLayer::Lineage),
    ]);
    assert!(combined.permitted());
    let ids: Vec<&str> = combined
        .obligations()
        .iter()
        .map(|obligation| obligation.id.as_str())
        .collect();
    // Deduplicated, and neither obligation dropped: a permit that quietly loses
    // "write a signed receipt" is a different permit.
    assert_eq!(ids, vec!["receipt.required", "notify.owner"]);
}

#[test]
fn the_explanation_lists_every_layer_in_precedence_order() {
    let combined = deny_overrides(vec![
        LayerOutcome::permit(PolicyLayer::Executability),
        LayerOutcome::permit(PolicyLayer::Availability),
        LayerOutcome::permit(PolicyLayer::Relationship),
    ]);
    let layers: Vec<&str> = combined
        .outcomes()
        .iter()
        .map(|outcome| outcome.layer.as_str())
        .collect();
    assert_eq!(
        layers,
        vec!["availability", "relationship", "executability"]
    );
    assert!(combined.effect() == Effect::Permit);
}
