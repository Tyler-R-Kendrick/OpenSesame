//! Adversarial tests for snapshot versus live admission: what a cohort's
//! membership is read from, and when that reading stops counting
//! (COH-SNAPSHOT, COH-LIVE).

#[cfg(test)]
mod tests {
    use crate::cohort_fixture::{fixture, mint, t0};
    use crate::{
        AdmissionBasis, AdmissionMode, CohortSnapshot, CohortSnapshotId, DomainError, PrincipalId,
        MAX_LIVE_RESOLUTION_AGE,
    };
    use chrono::Duration;

    #[test]
    fn a_removal_reaches_a_live_cohort_at_once_and_a_snapshot_only_when_retaken() {
        // The one difference between the two modes, stated as a test rather than
        // as a comment: same edit, same instant, two answers — each correct for
        // what its cohort declared.
        let live = fixture(AdmissionMode::Live);
        let after = live.without_ridley().resolve(live.cohort.id, t0()).unwrap();
        assert!(after.eligibility(live.dana).is_some());
        assert!(
            after.eligibility(live.ridley).is_none(),
            "a live cohort follows the team it names"
        );
        assert!(mint(
            &live.cohort,
            AdmissionBasis::Live(&after),
            live.ridley,
            t0()
        )
        .is_err());

        let frozen = fixture(AdmissionMode::Snapshot);
        let taken = CohortSnapshot::take(
            CohortSnapshotId::new(),
            &frozen.graph.resolve(frozen.cohort.id, t0()).unwrap(),
        )
        .unwrap();
        // Ridley leaves the team; the snapshot is untouched by that, on purpose.
        let _ = frozen.without_ridley();
        assert!(taken.eligibility(frozen.ridley).is_some());
        assert!(mint(
            &frozen.cohort,
            AdmissionBasis::Snapshot(&taken),
            frozen.ridley,
            t0()
        )
        .is_ok());

        // Re-taking is what makes the removal land, and closing the old snapshot
        // is what stops it admitting anybody afterwards.
        let retaken = CohortSnapshot::take(
            CohortSnapshotId::new(),
            &frozen
                .without_ridley()
                .resolve(frozen.cohort.id, t0())
                .unwrap(),
        )
        .unwrap();
        assert!(retaken.eligibility(frozen.ridley).is_none());
        let closed = taken.close(t0() + Duration::minutes(1));
        assert!(matches!(
            mint(
                &frozen.cohort,
                AdmissionBasis::Snapshot(&closed),
                frozen.ridley,
                t0()
            )
            .unwrap_err(),
            DomainError::CohortSnapshotClosed(_)
        ));
    }

    #[test]
    fn a_snapshot_whose_roster_was_edited_underneath_us_admits_nobody() {
        let frozen = fixture(AdmissionMode::Snapshot);
        let resolution = frozen.graph.resolve(frozen.cohort.id, t0()).unwrap();
        let mut tampered = CohortSnapshot::take(CohortSnapshotId::new(), &resolution).unwrap();
        assert!(tampered.verify_digest().is_ok());

        // Somebody adds themselves to the stored row. The digest no longer
        // matches, so the snapshot admits nobody at all — including the people
        // who were legitimately on it.
        let attacker = PrincipalId::new();
        let smuggled = tampered.roster.values().next().unwrap().clone();
        tampered.roster.insert(attacker, smuggled);

        assert_eq!(
            tampered.verify_digest().unwrap_err(),
            DomainError::CohortSnapshotDigestMismatch
        );
        assert_eq!(
            mint(
                &frozen.cohort,
                AdmissionBasis::Snapshot(&tampered),
                frozen.dana,
                t0()
            )
            .unwrap_err(),
            DomainError::CohortSnapshotDigestMismatch
        );
    }

    #[test]
    fn a_basis_must_match_the_cohort_and_the_mode_it_is_offered_for() {
        let live = fixture(AdmissionMode::Live);
        let frozen = fixture(AdmissionMode::Snapshot);
        let live_resolution = live.graph.resolve(live.cohort.id, t0()).unwrap();
        let frozen_resolution = frozen.graph.resolve(frozen.cohort.id, t0()).unwrap();
        let snapshot = CohortSnapshot::take(CohortSnapshotId::new(), &frozen_resolution).unwrap();

        // A roster loaded for one group cannot admit into another.
        assert_eq!(
            mint(
                &live.cohort,
                AdmissionBasis::Live(&frozen_resolution),
                frozen.dana,
                t0()
            )
            .unwrap_err(),
            DomainError::CohortSnapshotCohortMismatch
        );

        // A live reading offered to a snapshot cohort would widen a group whose
        // whole point is that it does not widen.
        assert!(matches!(
            mint(
                &frozen.cohort,
                AdmissionBasis::Live(&frozen_resolution),
                frozen.dana,
                t0()
            )
            .unwrap_err(),
            DomainError::CohortAdmissionModeMismatch(_)
        ));

        // And a snapshot offered to a live cohort would freeze one whose whole
        // point is that it moves.
        let live_snapshot =
            CohortSnapshot::take(CohortSnapshotId::new(), &live_resolution).unwrap();
        assert!(matches!(
            AdmissionBasis::Snapshot(&live_snapshot)
                .assert_usable(&live.cohort, t0())
                .unwrap_err(),
            DomainError::CohortAdmissionModeMismatch(_)
        ));
        assert!(matches!(
            AdmissionBasis::Snapshot(&snapshot)
                .assert_usable(&live.cohort, t0())
                .unwrap_err(),
            DomainError::CohortSnapshotCohortMismatch
        ));

        assert!(mint(
            &live.cohort,
            AdmissionBasis::Live(&live_resolution),
            live.dana,
            t0()
        )
        .is_ok());
    }

    #[test]
    fn live_admission_refuses_a_reading_that_is_not_actually_now() {
        // Without this bound, "live" degrades into "whatever was cached" — which
        // is strictly worse than a snapshot, because nobody wrote down when it
        // was taken or agreed to it.
        let live = fixture(AdmissionMode::Live);
        let resolution = live.graph.resolve(live.cohort.id, t0()).unwrap();
        let basis = AdmissionBasis::Live(&resolution);

        assert!(basis.assert_usable(&live.cohort, t0()).is_ok());
        assert!(basis
            .assert_usable(&live.cohort, t0() + MAX_LIVE_RESOLUTION_AGE)
            .is_ok());
        assert!(matches!(
            basis
                .assert_usable(
                    &live.cohort,
                    t0() + MAX_LIVE_RESOLUTION_AGE + Duration::seconds(1)
                )
                .unwrap_err(),
            DomainError::CohortResolutionStale(_)
        ));
        // A reading from ahead of the clock is refused too: it is either a bug or
        // somebody choosing their own timestamp.
        assert!(matches!(
            basis
                .assert_usable(&live.cohort, t0() - Duration::seconds(1))
                .unwrap_err(),
            DomainError::CohortResolutionStale(_)
        ));
    }

    #[test]
    fn a_snapshot_does_not_rot_on_a_timer_but_the_access_it_feeds_does() {
        // A snapshot is frozen on purpose and has no expiry — it stops counting
        // when an operator closes it. What bounds the access is the activation's
        // own short lifetime, so a since-removed member's binding cannot stand
        // for longer than that even while the snapshot still names them.
        let frozen = fixture(AdmissionMode::Snapshot);
        let resolution = frozen.graph.resolve(frozen.cohort.id, t0()).unwrap();
        let snapshot = CohortSnapshot::take(CohortSnapshotId::new(), &resolution).unwrap();

        let long_after = t0() + Duration::days(30);
        assert!(snapshot.assert_usable().is_ok());
        let activation = mint(
            &frozen.cohort,
            AdmissionBasis::Snapshot(&snapshot),
            frozen.dana,
            long_after,
        )
        .unwrap();
        assert!(activation.authorizes(frozen.dana, crate::cohort_fixture::REQUEST, long_after));
        assert!(!activation.authorizes(
            frozen.dana,
            crate::cohort_fixture::REQUEST,
            long_after + Duration::hours(2)
        ));
    }
}
