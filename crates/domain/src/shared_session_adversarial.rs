#[cfg(test)]
mod tests {
    use crate::*;
    use chrono::{Duration, Utc};
    use std::collections::BTreeSet;

    fn rows(vault_id: VaultId, items: &[VaultItemId]) -> GrantScope {
        GrantScope::Rows {
            vault_id,
            items: items.iter().copied().collect::<BTreeSet<_>>(),
        }
    }

    /// Takes `now` rather than reading the clock itself: a grant that starts
    /// a microsecond after the test's own reading is refused by
    /// `assert_active`, which is correct behaviour and a confusing test.
    fn grant(
        now: chrono::DateTime<Utc>,
        scope: GrantScope,
        role: SessionRole,
        lifetime: Duration,
    ) -> SessionGrant {
        SessionGrant::new(NewSessionGrant {
            id: SessionGrantId::new(),
            session_id: SessionId::new(),
            subject_principal_id: PrincipalId::new(),
            granted_by_principal_id: PrincipalId::new(),
            scope,
            role,
            granted_at: now,
            expires_at: now + lifetime,
        })
        .expect("grant should be valid")
    }

    // ── Every grant expires ───────────────────────────────────────────────

    #[test]
    fn refuses_a_lifetime_beyond_the_cap() {
        // Revocation is re-keying, not a switch: a grant that outlives the
        // operator's attention is a key handed out and forgotten.
        let now = Utc::now();
        let error = SessionGrant::new(NewSessionGrant {
            id: SessionGrantId::new(),
            session_id: SessionId::new(),
            subject_principal_id: PrincipalId::new(),
            granted_by_principal_id: PrincipalId::new(),
            scope: GrantScope::Collection {
                vault_id: VaultId::new(),
            },
            role: SessionRole::Read,
            granted_at: now,
            expires_at: now + MAX_GRANT_LIFETIME + Duration::seconds(1),
        })
        .expect_err("a lifetime past the cap must be refused");
        assert!(matches!(error, DomainError::SessionGrantLifetime(_)));
    }

    #[test]
    fn refuses_rather_than_clamps() {
        // Silently shortening would leave the operator believing the system
        // did something it did not.
        let now = Utc::now();
        let outcome = SessionGrant::new(NewSessionGrant {
            id: SessionGrantId::new(),
            session_id: SessionId::new(),
            subject_principal_id: PrincipalId::new(),
            granted_by_principal_id: PrincipalId::new(),
            scope: GrantScope::Collection {
                vault_id: VaultId::new(),
            },
            role: SessionRole::Read,
            granted_at: now,
            expires_at: now + Duration::days(365),
        });
        assert!(outcome.is_err());
    }

    #[test]
    fn refuses_a_lifetime_that_is_over_before_it_starts() {
        let now = Utc::now();
        for expires_at in [now, now - Duration::hours(1), now + Duration::seconds(5)] {
            let outcome = SessionGrant::new(NewSessionGrant {
                id: SessionGrantId::new(),
                session_id: SessionId::new(),
                subject_principal_id: PrincipalId::new(),
                granted_by_principal_id: PrincipalId::new(),
                scope: GrantScope::Collection {
                    vault_id: VaultId::new(),
                },
                role: SessionRole::Read,
                granted_at: now,
                expires_at,
            });
            assert!(outcome.is_err(), "{expires_at} should be refused");
        }
    }

    #[test]
    fn expiry_is_enforced_by_the_check_not_by_a_scanner() {
        // The lifecycle feed announces the deadline; it never performs it. A
        // missed scanner tick must not extend anybody's reach.
        let now = Utc::now();
        let held = grant(
            now,
            GrantScope::Collection {
                vault_id: VaultId::new(),
            },
            SessionRole::Read,
            Duration::hours(1),
        );
        assert!(held.assert_active(now).is_ok());
        assert!(matches!(
            held.assert_active(held.expires_at),
            Err(DomainError::GrantTimeWindow)
        ));
        assert!(matches!(
            held.assert_active(held.expires_at + Duration::days(400)),
            Err(DomainError::GrantTimeWindow)
        ));
    }

    #[test]
    fn a_revoked_grant_is_dead_even_inside_its_window() {
        let now = Utc::now();
        let mut held = grant(
            now,
            GrantScope::Collection {
                vault_id: VaultId::new(),
            },
            SessionRole::Read,
            Duration::hours(1),
        );
        held.revoked_at = Some(now);
        assert!(matches!(
            held.assert_active(now),
            Err(DomainError::GrantRevoked)
        ));
    }

    // ── Scope narrows, never widens ──────────────────────────────────────

    #[test]
    fn rows_never_widen_into_the_collection() {
        let vault_id = VaultId::new();
        let one = VaultItemId::new();
        let held = rows(vault_id, &[one]);
        let whole = GrantScope::Collection { vault_id };

        assert!(held.narrows_to(&whole), "rows sit inside the collection");
        assert!(
            !whole.narrows_to(&held),
            "a whole vault must never be carved out of a handful of rows"
        );
    }

    #[test]
    fn a_row_set_narrows_only_to_a_superset() {
        let vault_id = VaultId::new();
        let a = VaultItemId::new();
        let b = VaultItemId::new();
        let c = VaultItemId::new();

        assert!(rows(vault_id, &[a]).narrows_to(&rows(vault_id, &[a, b])));
        assert!(rows(vault_id, &[a, b]).narrows_to(&rows(vault_id, &[a, b])));
        assert!(
            !rows(vault_id, &[a, c]).narrows_to(&rows(vault_id, &[a, b])),
            "one unlisted row is enough to refuse the whole set"
        );
    }

    #[test]
    fn a_scope_never_reaches_across_vaults() {
        let mine = VaultId::new();
        let theirs = VaultId::new();
        let item = VaultItemId::new();

        assert!(!rows(mine, &[item]).narrows_to(&rows(theirs, &[item])));
        assert!(!GrantScope::Collection { vault_id: mine }
            .narrows_to(&GrantScope::Collection { vault_id: theirs }));
        assert!(
            !rows(mine, &[item]).admits(theirs, item),
            "the same item id in another vault is a different item"
        );
    }

    #[test]
    fn an_unlisted_row_is_denied_rather_than_unspecified() {
        let vault_id = VaultId::new();
        let listed = VaultItemId::new();
        let unlisted = VaultItemId::new();
        let scope = rows(vault_id, &[listed]);

        assert!(scope.admits(vault_id, listed));
        assert!(!scope.admits(vault_id, unlisted));
    }

    #[test]
    fn a_row_scope_naming_nothing_is_refused() {
        let empty = GrantScope::Rows {
            vault_id: VaultId::new(),
            items: BTreeSet::new(),
        };
        assert!(matches!(
            empty.assert_non_empty(),
            Err(DomainError::SessionGrantScopeEmpty)
        ));
        assert_eq!(empty.row_count(), Some(0));
    }

    // ── Role ─────────────────────────────────────────────────────────────

    #[test]
    fn reading_never_implies_writing() {
        assert!(SessionRole::Write.covers(SessionRole::Read));
        assert!(SessionRole::Read.covers(SessionRole::Read));
        assert!(!SessionRole::Read.covers(SessionRole::Write));
    }

    // ── The one question the fence asks ──────────────────────────────────

    #[test]
    fn permits_refuses_every_way_it_can_be_wrong() {
        let now = Utc::now();
        let vault_id = VaultId::new();
        let item = VaultItemId::new();
        let other_item = VaultItemId::new();
        let held = grant(
            now,
            rows(vault_id, &[item]),
            SessionRole::Read,
            Duration::hours(1),
        );
        let subject = held.subject_principal_id;

        assert!(held.permits(subject, vault_id, item, SessionRole::Read, now));

        // Somebody else's grant.
        assert!(!held.permits(PrincipalId::new(), vault_id, item, SessionRole::Read, now));
        // A row it does not name.
        assert!(!held.permits(subject, vault_id, other_item, SessionRole::Read, now));
        // Another vault.
        assert!(!held.permits(subject, VaultId::new(), item, SessionRole::Read, now));
        // More than it grants.
        assert!(!held.permits(subject, vault_id, item, SessionRole::Write, now));
        // After it has lapsed.
        assert!(!held.permits(
            subject,
            vault_id,
            item,
            SessionRole::Read,
            held.expires_at + Duration::seconds(1)
        ));
    }

    #[test]
    fn a_derived_grant_may_not_outlive_its_ceiling() {
        let now = Utc::now();
        let vault_id = VaultId::new();
        let item = VaultItemId::new();
        let ceiling = grant(
            now,
            GrantScope::Collection { vault_id },
            SessionRole::Write,
            Duration::hours(2),
        );

        let shorter = SessionGrant::new(NewSessionGrant {
            id: SessionGrantId::new(),
            session_id: ceiling.session_id,
            subject_principal_id: PrincipalId::new(),
            granted_by_principal_id: ceiling.subject_principal_id,
            scope: rows(vault_id, &[item]),
            role: SessionRole::Read,
            granted_at: now,
            expires_at: ceiling.expires_at - Duration::minutes(1),
        })
        .expect("valid");
        assert!(shorter.narrows_to(&ceiling));

        let longer = SessionGrant::new(NewSessionGrant {
            id: SessionGrantId::new(),
            session_id: ceiling.session_id,
            subject_principal_id: PrincipalId::new(),
            granted_by_principal_id: ceiling.subject_principal_id,
            scope: rows(vault_id, &[item]),
            role: SessionRole::Read,
            granted_at: now,
            expires_at: ceiling.expires_at + Duration::minutes(1),
        })
        .expect("valid");
        assert!(
            !longer.narrows_to(&ceiling),
            "a derived grant outliving its ceiling is a widening"
        );
    }

    // ── Join requests ────────────────────────────────────────────────────

    #[test]
    fn a_join_note_is_bounded_in_characters_not_bytes() {
        // Counted in characters so the bound means the same thing in every
        // script — a note of emoji is not secretly four times the budget.
        let over = "é".repeat(MAX_JOIN_NOTE_CHARS + 1);
        let error = JoinRequest::new(
            JoinRequestId::new(),
            SessionId::new(),
            PrincipalId::new(),
            Some(over),
            Utc::now(),
        )
        .expect_err("an over-long note must be refused");
        assert!(matches!(
            error,
            DomainError::SessionJoinNoteTooLong(n) if n == MAX_JOIN_NOTE_CHARS + 1
        ));

        let at_cap = "é".repeat(MAX_JOIN_NOTE_CHARS);
        assert!(JoinRequest::new(
            JoinRequestId::new(),
            SessionId::new(),
            PrincipalId::new(),
            Some(at_cap),
            Utc::now(),
        )
        .is_ok());
    }

    #[test]
    fn a_request_arrives_pending_and_carries_no_decision() {
        let request = JoinRequest::new(
            JoinRequestId::new(),
            SessionId::new(),
            PrincipalId::new(),
            None,
            Utc::now(),
        )
        .expect("valid");
        assert!(request.is_pending());
        assert_eq!(request.decision, JoinDecision::Pending);
        assert!(request.decided_at.is_none());
        assert!(request.decided_by_principal_id.is_none());
    }

    #[test]
    fn admission_cannot_be_recorded_without_the_grant_it_minted() {
        // There is no `Admitted` without a grant id, so "in the room with
        // nothing" is unrepresentable rather than merely discouraged.
        let admitted = JoinDecision::Admitted {
            grant_id: SessionGrantId::new(),
        };
        match admitted {
            JoinDecision::Admitted { grant_id } => {
                assert_ne!(grant_id.to_string(), String::new());
            }
            other => panic!("unexpected decision {other:?}"),
        }
    }

    #[test]
    fn the_holder_and_the_giver_stay_distinguishable() {
        // `NewSessionGrant` names both principals because positionally they
        // are one transposition apart, and transposing them hands the
        // operator's reach to the wrong party. This pins that the grant keeps
        // them as given rather than normalising them together.
        let now = Utc::now();
        let holder = PrincipalId::new();
        let giver = PrincipalId::new();
        let minted = SessionGrant::new(NewSessionGrant {
            id: SessionGrantId::new(),
            session_id: SessionId::new(),
            subject_principal_id: holder,
            granted_by_principal_id: giver,
            scope: GrantScope::Collection {
                vault_id: VaultId::new(),
            },
            role: SessionRole::Read,
            granted_at: now,
            expires_at: now + Duration::hours(1),
        })
        .expect("valid");

        assert_eq!(minted.subject_principal_id, holder);
        assert_eq!(minted.granted_by_principal_id, giver);
        // And the giver holds nothing by virtue of having given it.
        assert!(!minted.permits(
            giver,
            minted.scope.vault_id(),
            VaultItemId::new(),
            SessionRole::Read,
            now
        ));
    }

    // ── Serialization ────────────────────────────────────────────────────

    #[test]
    fn a_row_scope_serializes_the_same_whatever_order_it_was_built_in() {
        // The ordered set is why: two operators ticking the same rows in a
        // different order must produce one scope, not two.
        let vault_id = VaultId::new();
        let a = VaultItemId::new();
        let b = VaultItemId::new();
        let one = serde_json::to_string(&rows(vault_id, &[a, b])).expect("serializes");
        let other = serde_json::to_string(&rows(vault_id, &[b, a])).expect("serializes");
        assert_eq!(one, other);
    }
}
