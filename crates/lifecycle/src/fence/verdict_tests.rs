//! Tests for the fence decision and its fail-closed posture.
//!
//! Split from a single `fence_tests.rs` so each file stays inside the
//! 400-line module budget (ADR 0093).

use super::*;
use crate::fence::Lineage;

const ROOT: &str = "0195c0de-0000-7000-8000-000000000001";
const CHILD: &str = "0195c0de-0000-7000-8000-000000000002";
const GRANDCHILD: &str = "0195c0de-0000-7000-8000-000000000003";
const STRANGER: &str = "0195c0de-0000-7000-8000-0000000000ff";

fn chain3() -> (Lineage, Lineage, Lineage) {
    let root = Lineage::root(ROOT).expect("root");
    let child = Lineage::child_of(&root, CHILD).expect("child");
    let grandchild = Lineage::child_of(&child, GRANDCHILD).expect("grandchild");
    (root, child, grandchild)
}

fn clear_reading(sequence: u64) -> FenceReading {
    FenceReading {
        observed_sequence: sequence,
        invalidations: vec![],
    }
}

fn revoked(grant_id: &str, sequence: u64) -> Invalidation {
    Invalidation {
        grant_id: grant_id.to_string(),
        sequence,
        reason: "owner revoked".to_string(),
    }
}

// —— the fence decision ———————————————————————————————————————————

#[test]
fn an_unfenced_chain_authorizes() {
    let (_, _, grandchild) = chain3();
    let verdict = evaluate_fence(&grandchild, &clear_reading(7), Freshness::any());
    assert!(verdict.authorizes());
    assert_eq!(
        verdict,
        FenceVerdict::Clear {
            root_grant_id: ROOT.to_string(),
            depth: 2,
            observed_sequence: 7,
        }
    );
}

#[test]
fn revoking_the_root_blocks_every_descendant_with_no_walk() {
    // The reading names only the root — no descendant row exists, and none is
    // needed. This is the property the fence exists for: the child is denied
    // at the instant the root's row is committed, not once a cascade has
    // reached it.
    let (root, child, grandchild) = chain3();
    let reading = FenceReading {
        observed_sequence: 12,
        invalidations: vec![revoked(ROOT, 12)],
    };
    for (lineage, expect_self) in [(&root, true), (&child, false), (&grandchild, false)] {
        let verdict = evaluate_fence(lineage, &reading, Freshness::any());
        assert!(
            !verdict.authorizes(),
            "{} still authorized under a dead root",
            lineage.grant_id()
        );
        assert_eq!(
            verdict,
            FenceVerdict::Invalidated {
                blocked_by: ROOT.to_string(),
                is_self: expect_self,
                sequence: 12,
                reason: "owner revoked".to_string(),
            }
        );
    }
}

#[test]
fn revoking_an_intermediate_blocks_below_it_and_spares_above_it() {
    let (root, child, grandchild) = chain3();
    let reading = FenceReading {
        observed_sequence: 4,
        invalidations: vec![revoked(CHILD, 4)],
    };

    // The root is untouched: a child's revocation never climbs.
    assert!(evaluate_fence(&root, &clear_reading(4), Freshness::any()).authorizes());

    assert!(!evaluate_fence(&child, &reading, Freshness::any()).authorizes());
    let below = evaluate_fence(&grandchild, &reading, Freshness::any());
    assert!(!below.authorizes());
    assert_eq!(
        below,
        FenceVerdict::Invalidated {
            blocked_by: CHILD.to_string(),
            is_self: false,
            sequence: 4,
            reason: "owner revoked".to_string(),
        }
    );
}

#[test]
fn a_siblings_revocation_does_not_touch_this_chain() {
    // Sibling rows are filtered by the store's lineage-scoped query, so a
    // clear reading is what arrives here. The assertion is that a chain whose
    // own ancestors are live keeps working while a sibling dies.
    let (_, child, _) = chain3();
    assert!(evaluate_fence(&child, &clear_reading(9), Freshness::any()).authorizes());
}

#[test]
fn the_cause_named_is_the_one_closest_to_the_root() {
    // Both an ancestor and the grant itself are revoked. The answer must name
    // the ancestor: that is the fact an operator needs, and it is stable
    // regardless of row order.
    let (_, _, grandchild) = chain3();
    let reading = FenceReading {
        observed_sequence: 20,
        invalidations: vec![
            revoked(GRANDCHILD, 20),
            revoked(CHILD, 15),
            revoked(ROOT, 11),
        ],
    };
    assert_eq!(
        evaluate_fence(&grandchild, &reading, Freshness::any()),
        FenceVerdict::Invalidated {
            blocked_by: ROOT.to_string(),
            is_self: false,
            sequence: 11,
            reason: "owner revoked".to_string(),
        }
    );
}

// —— fail closed ——————————————————————————————————————————————————

#[test]
fn a_stale_reading_denies_rather_than_allowing() {
    // The caller has already seen sequence 30. A reading from 29 might not
    // carry a revocation it has observed, so it proves nothing.
    let (_, child, _) = chain3();
    let verdict = evaluate_fence(&child, &clear_reading(29), Freshness::at_least(30));
    assert!(!verdict.authorizes());
    assert_eq!(
        verdict,
        FenceVerdict::Indeterminate {
            cause: Uncertainty::Stale {
                observed_sequence: 29,
                required_sequence: 30,
            }
        }
    );
    // Caught up exactly is fresh enough.
    assert!(evaluate_fence(&child, &clear_reading(30), Freshness::at_least(30)).authorizes());
}

#[test]
fn freshness_is_checked_before_anything_else_can_clear_it() {
    // A stale reading must not be rescued by being otherwise clean.
    let (_, child, _) = chain3();
    let verdict = evaluate_fence(&child, &clear_reading(0), Freshness::at_least(1));
    assert!(matches!(
        verdict,
        FenceVerdict::Indeterminate {
            cause: Uncertainty::Stale { .. }
        }
    ));
}

#[test]
fn a_reading_about_another_chain_says_nothing_about_this_one() {
    let (_, child, _) = chain3();
    let verdict = evaluate_fence(
        &child,
        &FenceReading {
            observed_sequence: 3,
            invalidations: vec![revoked(STRANGER, 3)],
        },
        Freshness::any(),
    );
    assert!(!verdict.authorizes());
    assert_eq!(
        verdict,
        FenceVerdict::Indeterminate {
            cause: Uncertainty::ReadingMismatched {
                grant_id: CHILD.to_string(),
                foreign: STRANGER.to_string(),
            }
        }
    );
}

#[test]
fn a_grant_with_no_lineage_is_denied() {
    let verdict = missing_lineage(CHILD);
    assert!(!verdict.authorizes());
    assert_eq!(
        verdict,
        FenceVerdict::Indeterminate {
            cause: Uncertainty::LineageMissing {
                grant_id: CHILD.to_string(),
            }
        }
    );
    assert!(verdict.reason().contains("no recorded lineage"));
}

#[test]
fn a_store_that_cannot_answer_is_denied() {
    let verdict = store_unavailable("database is locked");
    assert!(!verdict.authorizes());
    assert!(verdict.reason().contains("database is locked"));
}

#[test]
fn every_indeterminate_cause_denies() {
    // The contract is the variant, not the cause: no uncertainty authorizes.
    for cause in [
        Uncertainty::LineageMissing {
            grant_id: CHILD.to_string(),
        },
        Uncertainty::LineageUnusable {
            grant_id: CHILD.to_string(),
            detail: "bad path".to_string(),
        },
        Uncertainty::LineageInconsistent {
            grant_id: CHILD.to_string(),
            detail: "root disagrees".to_string(),
        },
        Uncertainty::ReadingMismatched {
            grant_id: CHILD.to_string(),
            foreign: STRANGER.to_string(),
        },
        Uncertainty::StoreUnavailable {
            detail: "timeout".to_string(),
        },
        Uncertainty::Stale {
            observed_sequence: 1,
            required_sequence: 2,
        },
    ] {
        let verdict = FenceVerdict::Indeterminate {
            cause: cause.clone(),
        };
        assert!(!verdict.authorizes(), "{cause:?} authorized");
        assert!(!verdict.reason().is_empty());
    }
}

#[test]
fn only_clear_authorizes() {
    assert!(FenceVerdict::Clear {
        root_grant_id: ROOT.to_string(),
        depth: 0,
        observed_sequence: 1,
    }
    .authorizes());
    assert!(!FenceVerdict::Invalidated {
        blocked_by: ROOT.to_string(),
        is_self: true,
        sequence: 1,
        reason: "x".to_string(),
    }
    .authorizes());
}
