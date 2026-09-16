//! Adversarial tests for the step that turns eligibility into authority: one
//! named principal, one request, no cohort-wide credential anywhere.

#[cfg(test)]
mod tests {
    use crate::cohort_fixture::{fixture, mint, t0, REQUEST};
    use crate::{
        AdmissionBasis, AdmissionMode, AdmissionRecord, CohortActivation, CohortActivationId,
        CohortSnapshot, CohortSnapshotId, DomainError, NewCohortActivation, PrincipalId,
        MAX_ACTIVATION_LIFETIME, MIN_ACTIVATION_LIFETIME,
    };
    use chrono::Duration;
    use serde_json::Value;

    /// Field names that would mean a cohort had started holding a credential.
    const FORBIDDEN: [&str; 6] = ["token", "secret", "bearer", "credential", "password", "key"];

    #[test]
    fn an_activation_binds_one_principal_and_never_the_cohort() {
        // The property the whole module exists for. Dana and Ridley are equally
        // eligible; Dana's activation authorizes Dana and refuses Ridley, and
        // Ridley has to be bound separately.
        let live = fixture(AdmissionMode::Live);
        let resolution = live.graph.resolve(live.cohort.id, t0()).unwrap();
        let basis = AdmissionBasis::Live(&resolution);
        assert!(resolution.eligibility(live.ridley).is_some());

        let dana_activation = mint(&live.cohort, basis, live.dana, t0()).unwrap();
        assert!(dana_activation.authorizes(live.dana, REQUEST, t0()));
        assert!(
            !dana_activation.authorizes(live.ridley, REQUEST, t0()),
            "eligibility is not authority: Ridley needs their own binding"
        );

        let ridley_activation = mint(&live.cohort, basis, live.ridley, t0()).unwrap();
        assert_ne!(dana_activation.id, ridley_activation.id);
        assert_eq!(ridley_activation.subject_principal_id, live.ridley);
        assert!(!ridley_activation.authorizes(live.dana, REQUEST, t0()));
    }

    #[test]
    fn an_activation_settles_one_request_once() {
        let live = fixture(AdmissionMode::Live);
        let resolution = live.graph.resolve(live.cohort.id, t0()).unwrap();
        let activation = mint(
            &live.cohort,
            AdmissionBasis::Live(&resolution),
            live.dana,
            t0(),
        )
        .unwrap();

        assert!(!activation.authorizes(live.dana, "sha256:some-other-request", t0()));
        assert!(!activation.authorizes(live.dana, REQUEST, t0() - Duration::seconds(1)));
        assert!(!activation.authorizes(live.dana, REQUEST, t0() + Duration::hours(2)));

        let spent = activation.spend(t0()).unwrap();
        assert_eq!(spent.spent_at, Some(t0()));
        assert!(!spent.authorizes(live.dana, REQUEST, t0()));
        assert_eq!(
            spent.clone().spend(t0()).unwrap_err(),
            DomainError::CohortActivationSpent
        );
        assert_eq!(
            spent.assert_active(t0()).unwrap_err(),
            DomainError::CohortActivationSpent
        );
    }

    #[test]
    fn an_activation_must_name_a_request_and_stay_inside_its_lifetime_bounds() {
        let live = fixture(AdmissionMode::Live);
        let resolution = live.graph.resolve(live.cohort.id, t0()).unwrap();
        let basis = AdmissionBasis::Live(&resolution);

        // An unbound activation would be a small bearer token.
        assert!(matches!(
            CohortActivation::mint(NewCohortActivation {
                id: CohortActivationId::new(),
                cohort: &live.cohort,
                basis,
                subject_principal_id: live.dana,
                request_digest: "   ".to_string(),
                activated_at: t0(),
                expires_at: t0() + Duration::minutes(10),
            })
            .unwrap_err(),
            DomainError::CohortActivationBindingMismatch(_)
        ));

        for expires_at in [
            t0() + MIN_ACTIVATION_LIFETIME - Duration::seconds(1),
            t0() + MAX_ACTIVATION_LIFETIME + Duration::seconds(1),
        ] {
            assert!(matches!(
                CohortActivation::mint(NewCohortActivation {
                    id: CohortActivationId::new(),
                    cohort: &live.cohort,
                    basis,
                    subject_principal_id: live.dana,
                    request_digest: REQUEST.to_string(),
                    activated_at: t0(),
                    expires_at,
                })
                .unwrap_err(),
                DomainError::CohortActivationLifetime(_)
            ));
        }
    }

    #[test]
    fn a_principal_the_basis_does_not_admit_gets_nothing() {
        let live = fixture(AdmissionMode::Live);
        let resolution = live.graph.resolve(live.cohort.id, t0()).unwrap();
        let stranger = PrincipalId::new();
        assert!(matches!(
            mint(
                &live.cohort,
                AdmissionBasis::Live(&resolution),
                stranger,
                t0()
            )
            .unwrap_err(),
            DomainError::CohortNotEligible(_)
        ));
    }

    #[test]
    fn a_bad_basis_is_diagnosed_as_a_bad_basis_not_as_ineligibility() {
        // Order matters: an operator told "not eligible" when the real problem is
        // a stale reading will go and edit a membership list that was never wrong.
        let live = fixture(AdmissionMode::Live);
        let resolution = live.graph.resolve(live.cohort.id, t0()).unwrap();
        let stranger = PrincipalId::new();
        assert!(matches!(
            mint(
                &live.cohort,
                AdmissionBasis::Live(&resolution),
                stranger,
                t0() + Duration::hours(1)
            )
            .unwrap_err(),
            DomainError::CohortResolutionStale(_)
        ));
    }

    #[test]
    fn an_activation_records_the_membership_it_was_minted_from() {
        // Months later, "why was Dana allowed to do this" is answerable from the
        // record alone: which reading, pinned by which digest, and by what route
        // it admitted her.
        let frozen = fixture(AdmissionMode::Snapshot);
        let resolution = frozen.graph.resolve(frozen.cohort.id, t0()).unwrap();
        let snapshot = CohortSnapshot::take(CohortSnapshotId::new(), &resolution).unwrap();
        let activation = mint(
            &frozen.cohort,
            AdmissionBasis::Snapshot(&snapshot),
            frozen.dana,
            t0(),
        )
        .unwrap();

        assert_eq!(activation.basis.mode(), AdmissionMode::Snapshot);
        assert_eq!(activation.basis.roster_digest(), snapshot.roster_digest);
        assert_eq!(
            activation.basis,
            AdmissionRecord::Snapshot {
                snapshot_id: snapshot.id,
                roster_digest: snapshot.roster_digest.clone(),
            }
        );
        assert_eq!(activation.eligibility.principal_id, frozen.dana);
        assert!(activation.eligibility.path.is_via_team());
    }

    #[test]
    fn nothing_a_cohort_produces_carries_a_secret() {
        // There is no cohort-wide bearer token, and this is the test that keeps it
        // that way: a future field called `token` or `shared_secret` on any of
        // these records fails here rather than in review. Everything a cohort
        // produces is a record about people, safe to log whole.
        let frozen = fixture(AdmissionMode::Snapshot);
        let resolution = frozen.graph.resolve(frozen.cohort.id, t0()).unwrap();
        let snapshot = CohortSnapshot::take(CohortSnapshotId::new(), &resolution).unwrap();
        let activation = mint(
            &frozen.cohort,
            AdmissionBasis::Snapshot(&snapshot),
            frozen.dana,
            t0(),
        )
        .unwrap();

        for (what, value) in [
            ("cohort", serde_json::to_value(&frozen.cohort).unwrap()),
            ("resolution", serde_json::to_value(&resolution).unwrap()),
            ("snapshot", serde_json::to_value(&snapshot).unwrap()),
            ("activation", serde_json::to_value(&activation).unwrap()),
        ] {
            let mut keys = Vec::new();
            collect_keys(&value, &mut keys);
            let smells = keys.into_iter().find(|key| {
                let lowered = key.to_ascii_lowercase();
                FORBIDDEN.iter().any(|word| lowered.contains(word))
            });
            assert!(
                smells.is_none(),
                "{what} carries a field named {smells:?}, which reads like a credential"
            );
        }

        // And the activation names exactly one subject — one string, not a roster
        // and not a role.
        let json = serde_json::to_value(&activation).unwrap();
        assert_eq!(
            json.get("subject_principal_id").and_then(Value::as_str),
            Some(
                activation
                    .subject_principal_id
                    .as_uuid()
                    .to_string()
                    .as_str()
            )
        );
    }

    fn collect_keys(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::Object(map) => {
                for (key, nested) in map {
                    out.push(key.clone());
                    collect_keys(nested, out);
                }
            }
            Value::Array(items) => {
                for item in items {
                    collect_keys(item, out);
                }
            }
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
        }
    }
}
