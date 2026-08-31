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
    // ——— Share links: two clocks, and the shorter one has to be the link's ———

    fn invite(
        now: chrono::DateTime<Utc>,
        link: Duration,
        access: Duration,
    ) -> Result<SessionInvite, DomainError> {
        SessionInvite::new(NewSessionInvite {
            id: SessionInviteId::new(),
            session_id: SessionId::new(),
            invited_by_principal_id: PrincipalId::new(),
            scope: GrantScope::Collection {
                vault_id: VaultId::new(),
            },
            role: SessionRole::Read,
            created_at: now,
            link_expires_at: now + link,
            grant_expires_at: now + access,
        })
    }

    #[test]
    fn a_link_that_would_outlive_its_access_is_refused_not_shortened() {
        let now = Utc::now();
        // Seven days of link over two hours of access: most of the link's life
        // would be spent standing for something already gone.
        let refused = invite(now, Duration::days(7), Duration::hours(2));
        assert!(matches!(
            refused,
            Err(DomainError::SessionInviteOutlivesGrant(_))
        ));
        // Nothing was quietly clamped into existence instead.
        assert!(refused.is_err());
    }

    #[test]
    fn the_link_must_close_with_time_left_to_use_what_it_opens() {
        let now = Utc::now();
        let access = Duration::hours(8);
        // Exactly coincident is refused: accepting on the last second would
        // mint a grant that has already lapsed.
        assert!(invite(now, access, access).is_err());
        // A hair inside the margin is still refused.
        assert!(invite(now, access - Duration::seconds(30), access).is_err());
        // At the margin it stands.
        assert!(invite(now, access - MIN_GRANT_LIFETIME, access).is_ok());
    }

    #[test]
    fn latest_link_expiry_is_the_boundary_a_picker_greys_out_against() {
        let now = Utc::now();
        let access_ends = now + Duration::hours(8);
        let latest = SessionInvite::latest_link_expiry(access_ends);
        assert_eq!(latest, access_ends - MIN_GRANT_LIFETIME);
        // Everything at or under it composes; anything past it does not. This
        // is what makes the dead invite unrepresentable in the UI rather than
        // refused after the operator has already chosen it.
        assert!(invite(now, latest - now, Duration::hours(8)).is_ok());
        assert!(invite(now, latest - now + Duration::seconds(1), Duration::hours(8)).is_err());
    }

    #[test]
    fn an_invite_cannot_promise_access_the_grant_rules_would_refuse() {
        let now = Utc::now();
        // Over the seven-day ceiling: caught when the invite is made, not when
        // somebody accepts it and discovers the offer was never real.
        assert!(matches!(
            invite(now, Duration::hours(1), Duration::days(30)),
            Err(DomainError::SessionGrantLifetime(_))
        ));
        // And under the floor.
        assert!(matches!(
            invite(now, Duration::seconds(5), Duration::seconds(10)),
            Err(DomainError::SessionGrantLifetime(_))
        ));
    }

    #[test]
    fn a_link_below_the_floor_is_refused() {
        let now = Utc::now();
        assert!(matches!(
            invite(now, Duration::seconds(30), Duration::hours(8)),
            Err(DomainError::SessionInviteLifetime(_))
        ));
    }

    #[test]
    fn an_invite_to_no_rows_is_refused_like_any_other_empty_scope() {
        let now = Utc::now();
        let refused = SessionInvite::new(NewSessionInvite {
            id: SessionInviteId::new(),
            session_id: SessionId::new(),
            invited_by_principal_id: PrincipalId::new(),
            scope: rows(VaultId::new(), &[]),
            role: SessionRole::Read,
            created_at: now,
            link_expires_at: now + Duration::hours(1),
            grant_expires_at: now + Duration::hours(8),
        });
        assert!(matches!(refused, Err(DomainError::SessionGrantScopeEmpty)));
    }

    #[test]
    fn accepting_spends_the_link_and_a_second_presentation_gets_nothing() {
        let now = Utc::now();
        let offer = invite(now, Duration::hours(1), Duration::hours(8)).expect("a valid invite");
        let taker = PrincipalId::new();

        let (spent, grant) = offer
            .clone()
            .accept(SessionGrantId::new(), taker, now)
            .expect("the first taker gets it");
        assert_eq!(grant.subject_principal_id, taker);
        assert_eq!(grant.expires_at, offer.grant_expires_at);
        assert_eq!(spent.accepted_at, Some(now));

        // Somebody else presenting the same link afterwards gets nothing —
        // single use, whatever the clock says.
        assert!(matches!(
            spent.accept(SessionGrantId::new(), PrincipalId::new(), now),
            Err(DomainError::SessionInviteClosed(_))
        ));
    }

    #[test]
    fn the_grant_runs_from_acceptance_to_the_deadline_the_operator_named() {
        // "Until Friday", not "eight hours from whenever you get round to it".
        let now = Utc::now();
        let offer = invite(now, Duration::hours(1), Duration::hours(8)).expect("a valid invite");
        let later = now + Duration::minutes(50);
        let (_, grant) = offer
            .clone()
            .accept(SessionGrantId::new(), PrincipalId::new(), later)
            .expect("still open at 50 minutes");
        assert_eq!(grant.granted_at, later);
        assert_eq!(grant.expires_at, offer.grant_expires_at);
        // And it is worth having: the margin guaranteed at construction is
        // what makes this true at every instant the link was still open.
        assert!(grant.assert_active(later).is_ok());
    }

    #[test]
    fn a_lapsed_link_mints_nothing_even_though_the_access_has_time_left() {
        let now = Utc::now();
        let offer = invite(now, Duration::hours(1), Duration::hours(8)).expect("a valid invite");
        let after = now + Duration::hours(2);
        assert!(matches!(
            offer.assert_open(after),
            Err(DomainError::SessionInviteClosed(_))
        ));
        assert!(matches!(
            offer.accept(SessionGrantId::new(), PrincipalId::new(), after),
            Err(DomainError::SessionInviteClosed(_))
        ));
    }

    #[test]
    fn a_withdrawn_link_is_closed_before_it_lapses() {
        let now = Utc::now();
        let offer = invite(now, Duration::hours(1), Duration::hours(8)).expect("a valid invite");
        let withdrawn = SessionInvite {
            revoked_at: Some(now),
            ..offer
        };
        assert!(matches!(
            withdrawn.accept(SessionGrantId::new(), PrincipalId::new(), now),
            Err(DomainError::SessionInviteClosed(_))
        ));
    }

    #[test]
    fn the_default_link_lifetime_is_a_day_and_fits_inside_the_grant_ceiling() {
        // The default has to be composable against the *shortest* access an
        // operator is likely to pair it with, or the fallback itself would be
        // the thing that fails.
        assert_eq!(DEFAULT_INVITE_LIFETIME, Duration::hours(24));
        assert!(DEFAULT_INVITE_LIFETIME < MAX_GRANT_LIFETIME);
        let now = Utc::now();
        assert!(invite(now, DEFAULT_INVITE_LIFETIME, Duration::days(7)).is_ok());
        // Paired with an access shorter than itself, it is refused rather than
        // silently applied — the caller picks a shorter link.
        assert!(invite(now, DEFAULT_INVITE_LIFETIME, Duration::hours(2)).is_err());
    }
}
