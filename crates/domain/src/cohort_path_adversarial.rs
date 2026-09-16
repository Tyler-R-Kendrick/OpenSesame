//! Adversarial tests for the eligibility path — the answer to "why is this
//! principal eligible", which is the part nesting makes hard (COH-PATHS).

#[cfg(test)]
mod tests {
    use crate::cohort_fixture::{nested_chain, nested_member, principal_member, t0, team_member};
    use crate::{
        AdmissionMode, CohortId, DomainError, EligibilityPath, PrincipalId, TeamId,
        MAX_COHORT_DEPTH,
    };
    use proptest::prelude::*;

    #[test]
    fn a_path_must_end_where_the_answer_is() {
        let root = CohortId::new();
        // A nested cohort explains nothing on its own: the path stops before the
        // row that actually admitted anybody.
        let error = EligibilityPath::direct(root, nested_member(CohortId::new())).unwrap_err();
        assert!(
            matches!(error, DomainError::CohortPathInvalid(_)),
            "{error:?}"
        );

        // A route that revisits a cohort is a loop, not a route.
        let repeated = CohortId::new();
        let error = EligibilityPath::new(
            root,
            vec![repeated, repeated],
            principal_member(PrincipalId::new()),
        )
        .unwrap_err();
        assert!(
            matches!(error, DomainError::CohortPathInvalid(_)),
            "{error:?}"
        );

        // And the depth bound is re-enforced here rather than assumed from the
        // traversal that produced it.
        let hops: Vec<CohortId> = (0..MAX_COHORT_DEPTH).map(|_| CohortId::new()).collect();
        assert_eq!(
            EligibilityPath::new(root, hops, principal_member(PrincipalId::new())).unwrap_err(),
            DomainError::CohortDepthExceeded(MAX_COHORT_DEPTH + 1)
        );
    }

    #[test]
    fn a_path_reads_as_one_line_and_names_what_to_edit() {
        let (root, mid) = (CohortId::new(), CohortId::new());
        let team_id = TeamId::new();
        let path = EligibilityPath::new(root, vec![mid], team_member(team_id)).unwrap();

        assert_eq!(path.canonical(), format!("{root} > {mid} > {team_id}"));
        assert_eq!(path.to_string(), path.canonical());
        // The cohort an operator edits to end this route is the last one on it,
        // not the one they asked about.
        assert_eq!(path.admitting_cohort(), mid);
        assert!(path.passes_through(root));
        assert!(path.passes_through(mid));
        assert!(!path.passes_through(CohortId::new()));
        assert!(path.is_via_team());
    }

    #[test]
    fn a_direct_path_is_one_hop_and_names_the_root() {
        let root = CohortId::new();
        let subject = PrincipalId::new();
        let path = EligibilityPath::direct(root, principal_member(subject)).unwrap();
        assert_eq!(path.depth(), 1);
        assert_eq!(path.root(), root);
        assert_eq!(path.admitting_cohort(), root);
        assert!(path.hops().is_empty());
        assert!(!path.is_via_team());
    }

    proptest! {
        /// However deep a chain is, either it is refused for depth or every path
        /// it produces is inside the bound. There is no third outcome, and in
        /// particular no resolution that quietly returns an over-deep path.
        #[test]
        fn a_chain_either_stays_inside_the_depth_bound_or_is_refused(length in 1_usize..8) {
            let subject = PrincipalId::new();
            let (graph, root) = nested_chain(length, subject, AdmissionMode::Live);
            match graph.resolve(root, t0()) {
                Ok(resolved) => {
                    prop_assert!(length <= MAX_COHORT_DEPTH);
                    let path = &resolved.eligibility(subject).unwrap().path;
                    prop_assert_eq!(path.depth(), length);
                    prop_assert!(path.depth() <= MAX_COHORT_DEPTH);
                    prop_assert_eq!(path.hops().len(), length - 1);
                }
                Err(error) => {
                    prop_assert!(length > MAX_COHORT_DEPTH);
                    prop_assert_eq!(error, DomainError::CohortDepthExceeded(length));
                }
            }
        }
    }
}
