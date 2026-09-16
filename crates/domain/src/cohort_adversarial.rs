//! Adversarial tests for the bounded cohort graph: what shapes resolve, what
//! shapes are refused, and who a resolution admits (COH-GRAPH).

#[cfg(test)]
mod tests {
    use crate::cohort_fixture::{
        cohort_with_id, graph_with_team, live_cohort, member_set, nested_chain, nested_member,
        principal_member, t0, team_member,
    };
    use crate::{
        AdmissionMode, Cohort, CohortGraph, CohortId, CohortMember, DomainError, NewCohort,
        OrganizationId, PrincipalId, TeamId, MAX_COHORT_DEPTH, MAX_COHORT_MEMBERS,
        MAX_COHORT_NODES,
    };

    fn cohort_named(label: &str, members: &[CohortMember]) -> Result<Cohort, DomainError> {
        Cohort::new(NewCohort {
            id: CohortId::new(),
            organization_id: OrganizationId::new(),
            label: label.to_string(),
            members: member_set(members),
            admission: AdmissionMode::Live,
            created_at: t0(),
        })
    }

    #[test]
    fn a_cohort_that_makes_nobody_eligible_is_refused() {
        // Not a closed door — a mistake. An operator who means "nobody" deletes
        // the cohort; one who saves an empty one has lost their edit.
        assert_eq!(
            cohort_named("empty", &[]).unwrap_err(),
            DomainError::CohortEmpty
        );
    }

    #[test]
    fn a_cohort_naming_itself_is_refused_without_the_rest_of_the_graph() {
        let id = CohortId::new();
        let error = Cohort::new(NewCohort {
            id,
            organization_id: OrganizationId::new(),
            label: "self".to_string(),
            members: member_set(&[nested_member(id)]),
            admission: AdmissionMode::Live,
            created_at: t0(),
        })
        .unwrap_err();
        assert!(matches!(error, DomainError::CohortCycle(_)), "{error:?}");
    }

    #[test]
    fn a_label_is_bounded_and_refuses_control_characters() {
        let subject = principal_member(PrincipalId::new());
        assert!(matches!(
            cohort_named("   ", &[subject]).unwrap_err(),
            DomainError::CohortLabelInvalid(_)
        ));
        assert!(matches!(
            cohort_named(&"x".repeat(121), &[subject]).unwrap_err(),
            DomainError::CohortLabelInvalid(_)
        ));
        // Refused rather than stripped: a newline here is somebody forging a
        // second line in whatever renders the roster, and repairing it quietly
        // would hide the attempt.
        assert!(matches!(
            cohort_named("on-call\nadmin", &[subject]).unwrap_err(),
            DomainError::CohortLabelInvalid(_)
        ));
        assert_eq!(
            cohort_named("  on-call  ", &[subject]).unwrap().label,
            "on-call"
        );
    }

    #[test]
    fn a_cohort_cannot_be_grown_past_its_member_bound() {
        let members: Vec<CohortMember> = (0..=MAX_COHORT_MEMBERS)
            .map(|_| principal_member(PrincipalId::new()))
            .collect();
        assert_eq!(
            cohort_named("huge", &members).unwrap_err(),
            DomainError::CohortTooManyMembers(MAX_COHORT_MEMBERS + 1)
        );

        // And not one push at a time either: editing holds the same bound.
        let held = cohort_named("small", &members[..2]).unwrap();
        assert_eq!(
            held.with_members(member_set(&members), t0()).unwrap_err(),
            DomainError::CohortTooManyMembers(MAX_COHORT_MEMBERS + 1)
        );
    }

    #[test]
    fn a_team_is_named_rather_than_copied() {
        // The reuse path: the cohort says "the platform team", the team keeps its
        // own roster, and the path says so.
        let (dana, ridley) = (PrincipalId::new(), PrincipalId::new());
        let team_id = TeamId::new();
        let organization_id = OrganizationId::new();
        let root = CohortId::new();
        let graph = graph_with_team(
            CohortGraph::new().with_cohort(cohort_with_id(
                root,
                organization_id,
                &[team_member(team_id)],
                AdmissionMode::Live,
            )),
            team_id,
            &[dana, ridley],
        );

        let resolved = graph.resolve(root, t0()).unwrap();
        assert_eq!(resolved.len(), 2);
        for principal_id in [dana, ridley] {
            let eligibility = resolved.eligibility(principal_id).unwrap();
            assert!(eligibility.path.is_via_team());
            assert_eq!(eligibility.path.depth(), 1);
            assert_eq!(eligibility.path.admitted_by(), team_member(team_id));
        }
    }

    #[test]
    fn nesting_resolves_through_to_the_leaves() {
        let subject = PrincipalId::new();
        let (graph, root) = nested_chain(MAX_COHORT_DEPTH, subject, AdmissionMode::Live);
        let resolved = graph.resolve(root, t0()).unwrap();

        let path = &resolved.eligibility(subject).unwrap().path;
        assert_eq!(path.depth(), MAX_COHORT_DEPTH);
        assert_eq!(path.root(), root);
        assert_eq!(path.admitted_by(), principal_member(subject));
        assert_eq!(resolved.shape.depth, MAX_COHORT_DEPTH);
        assert_eq!(resolved.shape.cohorts_visited, MAX_COHORT_DEPTH);
    }

    #[test]
    fn a_cycle_is_refused_however_the_walk_arrives_at_it() {
        // a → c → b → a, entered from a root that names both a and b. A check
        // that only looked at the route it happened to take would miss this
        // depending on which of a or b it expanded first, so the loop is looked
        // for across the whole reachable graph.
        let organization_id = OrganizationId::new();
        let (root, a, b, c) = (
            CohortId::new(),
            CohortId::new(),
            CohortId::new(),
            CohortId::new(),
        );
        let graph = CohortGraph::new()
            .with_cohort(live_cohort(
                root,
                organization_id,
                &[nested_member(a), nested_member(b)],
            ))
            .with_cohort(live_cohort(a, organization_id, &[nested_member(c)]))
            .with_cohort(live_cohort(c, organization_id, &[nested_member(b)]))
            .with_cohort(live_cohort(b, organization_id, &[nested_member(a)]));

        let error = graph.validate(root).unwrap_err();
        assert!(matches!(error, DomainError::CohortCycle(_)), "{error:?}");
        assert!(graph.resolve(root, t0()).is_err());
    }

    #[test]
    fn a_diamond_is_reuse_rather_than_a_cycle() {
        // Two cohorts naming the same third is the shape reuse produces, and it
        // must resolve — cheaply, and without inventing a second route for
        // anybody it admits.
        let organization_id = OrganizationId::new();
        let subject = PrincipalId::new();
        let (root, left, right, shared) = (
            CohortId::new(),
            CohortId::new(),
            CohortId::new(),
            CohortId::new(),
        );
        let graph = CohortGraph::new()
            .with_cohort(live_cohort(
                root,
                organization_id,
                &[nested_member(left), nested_member(right)],
            ))
            .with_cohort(live_cohort(left, organization_id, &[nested_member(shared)]))
            .with_cohort(live_cohort(
                right,
                organization_id,
                &[nested_member(shared)],
            ))
            .with_cohort(live_cohort(
                shared,
                organization_id,
                &[principal_member(subject)],
            ));

        let resolved = graph.resolve(root, t0()).unwrap();
        let eligibility = resolved.eligibility(subject).unwrap();
        assert_eq!(eligibility.path.depth(), 3);
        assert_eq!(eligibility.path.admitting_cohort(), shared);
        // One row admitted them, seen once.
        assert_eq!(eligibility.additional_admissions, 0);
        assert_eq!(resolved.shape.cohorts_visited, 4);
    }

    #[test]
    fn nesting_deeper_than_the_bound_is_refused() {
        let subject = PrincipalId::new();
        let (graph, root) = nested_chain(MAX_COHORT_DEPTH + 1, subject, AdmissionMode::Live);
        assert_eq!(
            graph.validate(root).unwrap_err(),
            DomainError::CohortDepthExceeded(MAX_COHORT_DEPTH + 1)
        );
    }

    #[test]
    fn a_graph_wider_than_the_node_bound_is_refused() {
        // Shallow but broad: the depth bound says nothing about this shape, so
        // the node bound is what keeps the traversal finite.
        let organization_id = OrganizationId::new();
        let root = CohortId::new();
        let children: Vec<CohortId> = (0..MAX_COHORT_NODES + 8).map(|_| CohortId::new()).collect();
        let mut graph = CohortGraph::new().with_cohort(live_cohort(
            root,
            organization_id,
            &children
                .iter()
                .copied()
                .map(nested_member)
                .collect::<Vec<_>>(),
        ));
        for child in &children {
            graph = graph.with_cohort(live_cohort(
                *child,
                organization_id,
                &[principal_member(PrincipalId::new())],
            ));
        }
        assert_eq!(
            graph.validate(root).unwrap_err(),
            DomainError::CohortGraphTooLarge(MAX_COHORT_NODES)
        );
    }

    #[test]
    fn a_member_that_cannot_be_resolved_is_refused_rather_than_contributing_nobody() {
        // The failure this refusal exists for: a directory that did not load
        // must not look like a group somebody emptied on purpose.
        let organization_id = OrganizationId::new();
        let root = CohortId::new();
        let missing_cohort = CohortId::new();
        let missing_team = TeamId::new();

        let without_nested = CohortGraph::new().with_cohort(live_cohort(
            root,
            organization_id,
            &[nested_member(missing_cohort)],
        ));
        assert_eq!(
            without_nested.validate(root).unwrap_err(),
            DomainError::CohortUnresolvedMember(missing_cohort.to_string())
        );

        let without_team = CohortGraph::new().with_cohort(live_cohort(
            root,
            organization_id,
            &[team_member(missing_team)],
        ));
        assert_eq!(
            without_team.resolve(root, t0()).unwrap_err(),
            DomainError::CohortUnresolvedMember(missing_team.to_string())
        );

        // An empty team, by contrast, is a real answer.
        let with_empty_team = graph_with_team(without_team, missing_team, &[]);
        assert!(with_empty_team.resolve(root, t0()).unwrap().is_empty());
    }

    #[test]
    fn a_nested_cohort_from_another_organization_is_refused() {
        let (root, nested) = (CohortId::new(), CohortId::new());
        let graph = CohortGraph::new()
            .with_cohort(live_cohort(
                root,
                OrganizationId::new(),
                &[nested_member(nested)],
            ))
            .with_cohort(live_cohort(
                nested,
                OrganizationId::new(),
                &[principal_member(PrincipalId::new())],
            ));
        assert_eq!(
            graph.validate(root).unwrap_err(),
            DomainError::OrganizationMismatch
        );
    }

    #[test]
    fn the_canonical_route_is_the_shortest_one_and_the_others_are_counted() {
        // Admitted twice: directly at the root, and again three levels down. The
        // shortest route is the one shown, and the count is what tells an
        // operator that editing it will not end anything.
        let organization_id = OrganizationId::new();
        let subject = PrincipalId::new();
        let (root, mid, deep) = (CohortId::new(), CohortId::new(), CohortId::new());
        let graph = CohortGraph::new()
            .with_cohort(live_cohort(
                root,
                organization_id,
                &[principal_member(subject), nested_member(mid)],
            ))
            .with_cohort(live_cohort(mid, organization_id, &[nested_member(deep)]))
            .with_cohort(live_cohort(
                deep,
                organization_id,
                &[principal_member(subject)],
            ));

        let resolved = graph.resolve(root, t0()).unwrap();
        let eligibility = resolved.eligibility(subject).unwrap();
        assert_eq!(eligibility.path.depth(), 1);
        assert_eq!(eligibility.path.admitting_cohort(), root);
        assert_eq!(eligibility.additional_admissions, 1);
        assert!(
            eligibility.survives_removal_of(root),
            "the deep route still admits them, so removing the root row is not a revocation"
        );

        // With only one route, the same question answers the other way.
        let single = CohortGraph::new().with_cohort(live_cohort(
            root,
            organization_id,
            &[principal_member(subject)],
        ));
        let only = single.resolve(root, t0()).unwrap();
        assert!(!only.eligibility(subject).unwrap().survives_removal_of(root));
    }

    #[test]
    fn a_resolution_is_deterministic_and_so_is_its_digest() {
        let subject = PrincipalId::new();
        let (graph, root) = nested_chain(3, subject, AdmissionMode::Live);
        let first = graph.resolve(root, t0()).unwrap();
        let second = graph.resolve(root, t0()).unwrap();
        assert_eq!(first, second);
        assert_eq!(
            first.roster_digest().unwrap(),
            second.roster_digest().unwrap()
        );
        assert!(first.roster_digest().unwrap().starts_with("sha256:"));
    }
}
