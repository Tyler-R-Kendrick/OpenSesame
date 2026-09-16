//! The coordination rules, attacked rather than demonstrated (ADR 0079).
//!
//! Every test here is a way somebody could end up holding reach they were
//! never meant to hold: an observer with a wrapped key, a reference that
//! reaches past what it references, a closed session whose grants live on.

#[cfg(test)]
mod tests {
    use crate::*;
    use chrono::{Duration, Utc};

    fn seat(mode: SessionMode) -> SessionMembership {
        SessionMembership::new(
            SessionId::new(),
            PrincipalId::new(),
            mode,
            PrincipalId::new(),
            Utc::now(),
        )
    }

    // ---- SES-MODES: an observer holds nothing, and cannot be given anything

    #[test]
    fn an_observer_is_never_the_subject_of_a_grant() {
        // The whole point of the mode. A grant is a wrapped key and ADR 0079
        // §3's revocation is re-keying, so a key wrapped for somebody who
        // needed none cannot be taken back — the refusal has to be at the
        // minting, not at the use.
        let observer = seat(SessionMode::Observer);
        assert!(matches!(
            observer.assert_may_hold_grant(),
            Err(DomainError::SessionObserverHoldsNoGrant)
        ));
        assert!(seat(SessionMode::Participant)
            .assert_may_hold_grant()
            .is_ok());
    }

    #[test]
    fn an_ended_seat_holds_nothing_whatever_mode_it_ended_in() {
        let gone = seat(SessionMode::Participant).ended(Utc::now());
        assert!(matches!(
            gone.assert_may_hold_grant(),
            Err(DomainError::SessionMembershipEnded)
        ));
        assert!(matches!(
            gone.clone().raised_to_participant(),
            Err(DomainError::SessionMembershipEnded)
        ));
        assert!(matches!(
            gone.lowered_to_observer(0),
            Err(DomainError::SessionMembershipEnded)
        ));
    }

    #[test]
    fn lowering_somebody_who_still_holds_reach_is_refused() {
        // Otherwise the observer invariant becomes a lie the moment an
        // operator demotes a participant, and every later check would have to
        // re-test what the mode was supposed to guarantee. Revoking is the act
        // that removes the reach; this only records that it is gone.
        let member = seat(SessionMode::Participant);
        assert!(matches!(
            member.clone().lowered_to_observer(1),
            Err(DomainError::SessionObserverHoldsNoGrant)
        ));
        let lowered = member.lowered_to_observer(0).expect("no live grants");
        assert_eq!(lowered.mode, SessionMode::Observer);
        assert!(!lowered.mode.may_hold_a_grant());
    }

    #[test]
    fn raising_is_permission_to_be_given_reach_and_not_reach_itself() {
        // A raised member still reads nothing until somebody grants them
        // something. Collapsing the two would make every grant silently
        // promote its subject.
        let raised = seat(SessionMode::Observer)
            .raised_to_participant()
            .expect("an active seat");
        assert_eq!(raised.mode, SessionMode::Participant);
        assert!(raised.assert_may_hold_grant().is_ok());
    }

    #[test]
    fn a_seat_never_un_ends() {
        let now = Utc::now();
        let left = seat(SessionMode::Participant).ended(now);
        let again = left.clone().ended(now + Duration::hours(1));
        assert_eq!(again.ended_at, left.ended_at, "a departure was rewritten");
    }

    #[test]
    fn a_membership_carries_no_scope_role_or_key() {
        // The structural half of "observers need no vault keys": there is
        // nowhere on the type for one to sit. A field added later is a diff a
        // reviewer sees.
        let json = serde_json::to_value(seat(SessionMode::Observer)).expect("serializes");
        let mut keys: Vec<&str> = json
            .as_object()
            .expect("an object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "admitted_at",
                "admitted_by_principal_id",
                "ended_at",
                "mode",
                "principal_id",
                "session_id",
            ]
        );
    }

    // ---- SES-ADMIT: admission is a named seat, never an unstated one

    #[test]
    fn an_admission_says_which_seat_it_gave() {
        let grant_id = SessionGrantId::new();
        let seated = Admission::Participant { grant_id };
        assert_eq!(seated.mode(), SessionMode::Participant);
        assert_eq!(seated.grant_id(), Some(grant_id));

        let watching = Admission::Observer;
        assert_eq!(watching.mode(), SessionMode::Observer);
        assert_eq!(
            watching.grant_id(),
            None,
            "an observer admission minted a grant"
        );
    }

    #[test]
    fn a_pending_or_refused_request_never_reports_a_grant() {
        assert_eq!(JoinDecision::Pending.granted(), None);
        assert_eq!(JoinDecision::Refused.granted(), None);
        assert_eq!(
            JoinDecision::Admitted {
                admission: Admission::Observer
            }
            .granted(),
            None
        );
    }

    #[test]
    fn admission_cannot_be_recorded_without_the_grant_it_minted() {
        // The vault path admits by granting, and the decision still has to
        // say which grant that was. An `Admission` widened what a seat may
        // be, not whether admitting states one: there is no bare `Admitted`,
        // so "in the room, and we will work out what that means later" stays
        // unrepresentable.
        let grant_id = SessionGrantId::new();
        let admitted = JoinDecision::Admitted {
            admission: Admission::Participant { grant_id },
        };
        match admitted {
            JoinDecision::Admitted { admission } => {
                assert_eq!(admission.grant_id(), Some(grant_id));
                assert_eq!(admission.mode(), SessionMode::Participant);
            }
            other => panic!("unexpected decision {other:?}"),
        }
        assert_eq!(admitted.granted(), Some(grant_id));
    }
}
