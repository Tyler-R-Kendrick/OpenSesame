//! Tests for lineage shape and the subtree range.
//!
//! Split from a single `fence_tests.rs` so each file stays inside the
//! 400-line module budget (ADR 0093).

use super::*;

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

// —— lineage shape ————————————————————————————————————————————————

#[test]
fn a_root_is_its_own_lineage_and_a_path_closes_both_ends() {
    let root = Lineage::root(ROOT).expect("root");
    assert_eq!(root.depth(), 0);
    assert_eq!(root.root_id(), ROOT);
    assert_eq!(root.grant_id(), ROOT);
    assert_eq!(root.parent_id(), None);
    assert_eq!(root.path(), format!("/{ROOT}/"));
    // Self-coverage is not a special case: revoking a root must stop the root.
    assert!(root.covers(ROOT));
}

#[test]
fn a_chain_records_every_ancestor_root_first() {
    let (_, _, grandchild) = chain3();
    assert_eq!(grandchild.depth(), 2);
    assert_eq!(grandchild.root_id(), ROOT);
    assert_eq!(grandchild.grant_id(), GRANDCHILD);
    assert_eq!(grandchild.parent_id(), Some(CHILD));
    assert_eq!(grandchild.chain(), [ROOT, CHILD, GRANDCHILD]);
    assert_eq!(grandchild.path(), format!("/{ROOT}/{CHILD}/{GRANDCHILD}/"));
    for id in [ROOT, CHILD, GRANDCHILD] {
        assert!(grandchild.covers(id), "{id} is an ancestor");
    }
    assert!(!grandchild.covers(STRANGER));
}

#[test]
fn a_stored_path_round_trips() {
    let (_, _, grandchild) = chain3();
    let parsed = Lineage::from_path(&grandchild.path()).expect("parse");
    assert_eq!(parsed, grandchild);
}

#[test]
fn a_malformed_path_is_refused_rather_than_guessed_at() {
    for bad in [
        "",
        "/",
        "//",
        ROOT,                          // unterminated
        &format!("/{ROOT}"),           // no trailing separator
        &format!("{ROOT}/"),           // no leading separator
        &format!("/{ROOT}//{CHILD}/"), // empty segment
    ] {
        assert!(
            Lineage::from_path(bad).is_err(),
            "`{bad}` parsed as a lineage"
        );
    }
}

#[test]
fn an_id_that_could_forge_an_ancestor_or_widen_a_prefix_is_refused() {
    // The store matches paths by prefix, so a separator inside an id would
    // let a child claim an ancestor it never had, and a LIKE metacharacter
    // would let a cascade reach into a sibling subtree.
    for hostile in [
        "",
        "a/b",
        "%",
        "_",
        "a%b",
        "a_b",
        "a\\b",
        "a b",
        "'; DROP TABLE grants--",
    ] {
        assert!(!is_fence_safe_id(hostile), "`{hostile}` passed as safe");
        assert!(
            Lineage::root(hostile).is_err(),
            "`{hostile}` became a lineage"
        );
    }
    assert!(is_fence_safe_id(ROOT));
}

#[test]
fn the_prefixed_spelling_the_grants_table_uses_is_accepted() {
    // `grants.id` holds `GrantId::to_string()`, which is `grant:<uuid>`. The
    // fence stores paths in that same spelling, so the colon has to pass.
    let prefixed = format!("grant:{ROOT}");
    assert!(is_fence_safe_id(&prefixed));
    let root = Lineage::root(&prefixed).expect("prefixed root");
    assert_eq!(root.path(), format!("/grant:{ROOT}/"));
    let child = Lineage::child_of(&root, &format!("grant:{CHILD}")).expect("prefixed child");
    assert_eq!(child.parent_id(), Some(prefixed.as_str()));
    assert_eq!(
        Lineage::from_path(&child.path()).expect("round trip"),
        child
    );
}

#[test]
fn a_cycle_is_refused_so_the_chain_stays_bounded() {
    let root = Lineage::root(ROOT).expect("root");
    let child = Lineage::child_of(&root, CHILD).expect("child");
    assert_eq!(
        Lineage::child_of(&child, ROOT),
        Err(LineageError::Cycle(ROOT.to_string()))
    );
    assert!(Lineage::from_path(&format!("/{ROOT}/{CHILD}/{ROOT}/")).is_err());
}

#[test]
fn a_chain_past_the_ceiling_is_refused_not_truncated() {
    // Truncating would mean the ancestors above the cut were never checked.
    let mut lineage = Lineage::root(&format!("{:0>8}", 0)).expect("root");
    for step in 1..MAX_FENCE_DEPTH {
        lineage = Lineage::child_of(&lineage, &format!("{step:0>8}")).expect("within budget");
    }
    assert_eq!(lineage.chain().len(), MAX_FENCE_DEPTH);
    let over = Lineage::child_of(&lineage, "deadbeef");
    assert_eq!(over, Err(LineageError::TooDeep(MAX_FENCE_DEPTH + 1)));
    assert!(Lineage::from_path(&format!("{}deadbeef/", lineage.path())).is_err());
}

// —— subtree bounds ———————————————————————————————————————————————

/// Whether `path` falls inside the half-open range, the way the store's
/// `>= low AND < high` predicate decides it.
fn in_range(bounds: &(String, String), path: &str) -> bool {
    path >= bounds.0.as_str() && path < bounds.1.as_str()
}

#[test]
fn a_subtree_range_covers_the_grant_and_everything_under_it() {
    let (root, child, grandchild) = chain3();
    let bounds = root.subtree_bounds();
    assert_eq!(bounds, (format!("/{ROOT}/"), format!("/{ROOT}0")));
    for lineage in [&root, &child, &grandchild] {
        assert!(
            in_range(&bounds, &lineage.path()),
            "{} escaped its root's subtree",
            lineage.grant_id()
        );
    }
}

#[test]
fn a_subtree_range_stops_at_its_own_subtree() {
    let (root, child, grandchild) = chain3();
    // A child's range must not reach its parent or a cousin.
    let bounds = child.subtree_bounds();
    assert!(in_range(&bounds, &child.path()));
    assert!(in_range(&bounds, &grandchild.path()));
    assert!(!in_range(&bounds, &root.path()));

    let cousin = Lineage::child_of(&root, STRANGER).expect("cousin");
    assert!(!in_range(&bounds, &cousin.path()));
}

#[test]
fn a_sibling_whose_id_extends_this_one_is_not_swept_up() {
    // The bug a bare string prefix would have: `/ab/` must not match `/abc/`.
    // The separator sits inside the bound, so it cannot.
    let short = Lineage::root("ab").expect("short");
    let longer = Lineage::root("abc").expect("longer");
    let bounds = short.subtree_bounds();
    assert!(in_range(&bounds, &short.path()));
    assert!(
        !in_range(&bounds, &longer.path()),
        "/abc/ was swept into /ab/'s subtree"
    );

    // ...and a real child of the short one still is.
    let real_child = Lineage::child_of(&short, "abc").expect("child");
    assert!(in_range(&bounds, &real_child.path()));
}
