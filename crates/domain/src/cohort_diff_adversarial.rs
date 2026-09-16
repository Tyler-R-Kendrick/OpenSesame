//! Adversarial tests for the cohort diff — in particular for eligibility that
//! survives a removal, which is the mistake nesting makes easy (COH-DIFF).

#[cfg(test)]
mod tests {
    use crate::cohort_fixture::{
        graph_with_team, live_cohort, principal_member, snapshot_cohort, t0, team_member,
    };
    use crate::{
        Cohort, CohortDiff, CohortGraph, CohortId, CohortResolution, CohortSnapshot,
        CohortSnapshotId, DomainError, OrganizationId, PrincipalId, TeamId,
    };
    use chrono::Duration;
    use std::collections::BTreeSet;

    /// A cohort that names Dana directly and two teams. Enough shapes to make
    /// every interesting change expressible by moving one person between rosters.
    struct Scene {
        cohort: Cohort,
        first_team: TeamId,
        second_team: TeamId,
        dana: PrincipalId,
        ridley: PrincipalId,
    }

    fn scene() -> Scene {
        let organization_id = OrganizationId::new();
        let (dana, ridley) = (PrincipalId::new(), PrincipalId::new());
        let (first_team, second_team) = (TeamId::new(), TeamId::new());
        let cohort = live_cohort(
            CohortId::new(),
            organization_id,
            &[
                principal_member(dana),
                team_member(first_team),
                team_member(second_team),
            ],
        );
        Scene {
            cohort,
            first_team,
            second_team,
            dana,
            ridley,
        }
    }

    impl Scene {
        fn resolve(&self, first: &[PrincipalId], second: &[PrincipalId]) -> CohortResolution {
            let graph = CohortGraph::new().with_cohort(self.cohort.clone());
            let graph = graph_with_team(graph, self.first_team, first);
            let graph = graph_with_team(graph, self.second_team, second);
            graph.resolve(self.cohort.id, t0()).unwrap()
        }
    }

    #[test]
    fn a_diff_names_who_gained_and_who_lost() {
        let scene = scene();
        let before = scene.resolve(&[scene.dana, scene.ridley], &[]);
        let after = scene.resolve(&[scene.dana], &[]);

        let diff = CohortDiff::between_resolutions(&before, &after).unwrap();
        assert_eq!(
            diff.removed.keys().copied().collect::<BTreeSet<_>>(),
            BTreeSet::from([scene.ridley])
        );
        assert!(diff.added.is_empty());
        assert!(diff.narrows());
        assert!(!diff.widens());
        assert_eq!(diff.cohort_id, Some(scene.cohort.id));

        // The route they used to hold is kept, so the readout can say what ended
        // rather than only that something did.
        assert!(diff.removed[&scene.ridley].is_via_team());
    }

    #[test]
    fn a_removal_that_ended_nothing_is_reported_as_a_removal_that_ended_nothing() {
        // The mistake this module exists for. Dana is taken out of the team, and
        // she is still eligible, because she was also named directly. She is not
        // in `removed` — and rather than leaving that as an absence somebody has
        // to notice, the diff carries the change to her routes.
        let scene = scene();
        let before = scene.resolve(&[scene.dana, scene.ridley], &[]);
        let after = scene.resolve(&[scene.ridley], &[]);

        let diff = CohortDiff::between_resolutions(&before, &after).unwrap();
        assert!(
            diff.removed.is_empty(),
            "taking Dana out of the team did not end her eligibility"
        );
        assert!(!diff.narrows());
        let change = &diff.rerouted[&scene.dana];
        assert!(change.admissions_changed());
        assert!(!change.path_changed(), "she was always admitted directly");
        assert_eq!(change.before.additional_admissions, 1);
        assert_eq!(change.after.additional_admissions, 0);
        assert!(!change.became_harder_to_revoke());

        // Stated from the other side too: before the edit, removing the route she
        // was shown on would not have ended anything.
        assert!(change
            .before
            .survives_removal_of(change.before.path.admitting_cohort()));
        assert!(!change
            .after
            .survives_removal_of(change.after.path.admitting_cohort()));
    }

    #[test]
    fn somebody_becoming_harder_to_remove_has_its_own_readout() {
        // Nothing about Ridley's access changed, only the number of things that
        // would now have to change to end it. Invisible in `added`/`removed`.
        let scene = scene();
        let before = scene.resolve(&[scene.dana, scene.ridley], &[]);
        let after = scene.resolve(&[scene.dana, scene.ridley], &[scene.ridley]);

        let diff = CohortDiff::between_resolutions(&before, &after).unwrap();
        assert!(diff.added.is_empty() && diff.removed.is_empty());
        assert_eq!(diff.harder_to_revoke(), vec![scene.ridley]);
        assert!(diff.rerouted[&scene.ridley].became_harder_to_revoke());
    }

    #[test]
    fn a_snapshot_diff_says_exactly_what_retaking_would_change() {
        // A snapshot cohort's revocation runbook ends in this call: the drift is
        // named, and whether re-taking widens is answerable before anybody does it.
        let organization_id = OrganizationId::new();
        let team_id = TeamId::new();
        let (dana, ridley) = (PrincipalId::new(), PrincipalId::new());
        let cohort = snapshot_cohort(CohortId::new(), organization_id, &[team_member(team_id)]);
        let resolve = |members: &[PrincipalId]| {
            graph_with_team(
                CohortGraph::new().with_cohort(cohort.clone()),
                team_id,
                members,
            )
            .resolve(cohort.id, t0())
            .unwrap()
        };

        let held = CohortSnapshot::take(CohortSnapshotId::new(), &resolve(&[dana])).unwrap();
        let live = resolve(&[dana, ridley]);

        let drift = CohortDiff::since_snapshot(&held, &live).unwrap();
        assert!(drift.widens(), "re-taking would let Ridley in");
        assert_eq!(
            drift.added.keys().copied().collect::<BTreeSet<_>>(),
            BTreeSet::from([ridley])
        );

        // Re-take it, and the same comparison is now empty.
        let retaken = CohortSnapshot::take(CohortSnapshotId::new(), &live).unwrap();
        let settled = CohortDiff::since_snapshot(&retaken, &live).unwrap();
        assert!(settled.is_empty());
        assert!(CohortDiff::between_snapshots(&retaken, &retaken)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn a_diff_refuses_a_comparison_that_would_mean_nothing() {
        let first = scene();
        let second = scene();
        let one = first.resolve(&[first.dana], &[]);
        let other = second.resolve(&[second.dana], &[]);

        // Two different cohorts: the "diff" would be a list of everybody in both.
        assert_eq!(
            CohortDiff::between_resolutions(&one, &other).unwrap_err(),
            DomainError::CohortSnapshotCohortMismatch
        );
        let one_snapshot = CohortSnapshot::take(CohortSnapshotId::new(), &one).unwrap();
        let other_snapshot = CohortSnapshot::take(CohortSnapshotId::new(), &other).unwrap();
        assert_eq!(
            CohortDiff::between_snapshots(&one_snapshot, &other_snapshot).unwrap_err(),
            DomainError::CohortSnapshotCohortMismatch
        );
        assert_eq!(
            CohortDiff::since_snapshot(&other_snapshot, &one).unwrap_err(),
            DomainError::CohortSnapshotCohortMismatch
        );

        // A roster that failed its digest: a diff computed from it would invite
        // somebody to act on a change that never happened, so there is no diff.
        let mut tampered = one_snapshot.clone();
        tampered.roster.remove(&first.dana);
        assert_eq!(
            CohortDiff::since_snapshot(&tampered, &one).unwrap_err(),
            DomainError::CohortSnapshotDigestMismatch
        );
        assert_eq!(
            CohortDiff::between_snapshots(&one_snapshot, &tampered).unwrap_err(),
            DomainError::CohortSnapshotDigestMismatch
        );
    }

    #[test]
    fn a_diff_read_backwards_is_the_same_diff() {
        // Reversing the two readings swaps who gained and who lost, exactly. A
        // diff that failed this would be reporting something about traversal order
        // rather than about membership.
        let scene = scene();
        let before = scene.resolve(&[scene.dana, scene.ridley], &[]);
        let after = scene.resolve(&[], &[scene.ridley]);

        let forward = CohortDiff::between_resolutions(&before, &after).unwrap();
        let backward = CohortDiff::between_resolutions(&after, &before).unwrap();

        assert_eq!(
            forward.added.keys().copied().collect::<BTreeSet<_>>(),
            backward.removed.keys().copied().collect::<BTreeSet<_>>()
        );
        assert_eq!(
            forward.removed.keys().copied().collect::<BTreeSet<_>>(),
            backward.added.keys().copied().collect::<BTreeSet<_>>()
        );
        assert_eq!(
            forward.rerouted.keys().copied().collect::<BTreeSet<_>>(),
            backward.rerouted.keys().copied().collect::<BTreeSet<_>>()
        );
        for (principal_id, change) in &forward.rerouted {
            let mirrored = &backward.rerouted[principal_id];
            assert_eq!(change.before, mirrored.after);
            assert_eq!(change.after, mirrored.before);
        }
    }

    #[test]
    fn closing_a_snapshot_keeps_the_first_closing_time() {
        // When it stopped counting is a fact about the past, not something a
        // second call gets to restate.
        let scene = scene();
        let resolution = scene.resolve(&[scene.dana], &[]);
        let snapshot = CohortSnapshot::take(CohortSnapshotId::new(), &resolution).unwrap();
        let closed = snapshot.close(t0());
        assert_eq!(
            closed.clone().close(t0() + Duration::hours(1)).closed_at,
            Some(t0())
        );
    }
}
