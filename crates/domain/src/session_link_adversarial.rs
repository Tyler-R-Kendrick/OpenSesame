//! Grant links, attacked rather than demonstrated (ADR 0079 §3, §7).
//!
//! A reference points at somebody's existing reach, so every test here is a
//! way a pointer could end up wider, longer-lived or aimed somewhere other
//! than the grant it was checked against — or a way closing a session could
//! take back reach it never granted.

#[cfg(test)]
mod tests {
    use crate::*;
    use chrono::{DateTime, Duration, Utc};
    use std::collections::BTreeSet;

    fn rows(vault_id: VaultId, items: &[VaultItemId]) -> GrantScope {
        GrantScope::Rows {
            vault_id,
            items: items.iter().copied().collect::<BTreeSet<_>>(),
        }
    }

    struct Spec {
        session_id: SessionId,
        subject: PrincipalId,
        scope: GrantScope,
        role: SessionRole,
        lifetime: Duration,
        now: DateTime<Utc>,
    }

    fn spec_for(spec: Spec) -> NewSessionGrant {
        NewSessionGrant {
            id: SessionGrantId::new(),
            session_id: spec.session_id,
            subject_principal_id: spec.subject,
            granted_by_principal_id: PrincipalId::new(),
            scope: spec.scope,
            role: spec.role,
            granted_at: spec.now,
            expires_at: spec.now + spec.lifetime,
            link: GrantLink::LifecycleBound,
        }
    }

    fn collection_grant(
        session_id: SessionId,
        subject: PrincipalId,
        vault_id: VaultId,
        role: SessionRole,
        lifetime: Duration,
        now: DateTime<Utc>,
    ) -> SessionGrant {
        SessionGrant::new(spec_for(Spec {
            session_id,
            subject,
            scope: GrantScope::Collection { vault_id },
            role,
            lifetime,
            now,
        }))
        .expect("a valid grant")
    }

    // ---- SES-LINKS: lifecycle_bound versus referenced

    #[test]
    fn a_reference_cannot_be_asserted_by_the_ordinary_constructor() {
        // `new` has not been handed the source, so it cannot have compared
        // anything with it. Recording the caller's claim would make the link
        // self-certifying.
        let now = Utc::now();
        let refused = SessionGrant::new(NewSessionGrant {
            link: GrantLink::Referenced {
                source_grant_id: SessionGrantId::new(),
            },
            ..spec_for(Spec {
                session_id: SessionId::new(),
                subject: PrincipalId::new(),
                scope: GrantScope::Collection {
                    vault_id: VaultId::new(),
                },
                role: SessionRole::Read,
                lifetime: Duration::hours(1),
                now,
            })
        });
        assert!(matches!(
            refused,
            Err(DomainError::SessionGrantLinkUnchecked(_))
        ));
    }

    #[test]
    fn a_reference_may_narrow_what_it_points_at() {
        let now = Utc::now();
        let session_id = SessionId::new();
        let holder = PrincipalId::new();
        let vault_id = VaultId::new();
        let row = VaultItemId::new();
        let source = collection_grant(
            SessionId::new(),
            holder,
            vault_id,
            SessionRole::Write,
            Duration::days(2),
            now,
        );

        let narrowed = SessionGrant::referencing(
            &source,
            NewSessionGrant {
                link: GrantLink::Referenced {
                    source_grant_id: source.id,
                },
                ..spec_for(Spec {
                    session_id,
                    subject: holder,
                    scope: rows(vault_id, &[row]),
                    role: SessionRole::Read,
                    lifetime: Duration::hours(1),
                    now,
                })
            },
        )
        .expect("a narrowing reference");

        assert!(!narrowed.ends_with_session());
        assert_eq!(narrowed.link.source_grant_id(), Some(source.id));
        assert!(narrowed.permits(holder, vault_id, row, SessionRole::Read, now));
        assert!(
            !narrowed.permits(holder, vault_id, row, SessionRole::Write, now),
            "a read reference authorized a write"
        );
    }

    #[test]
    fn a_reference_may_never_reach_further_than_its_source() {
        let now = Utc::now();
        let holder = PrincipalId::new();
        let vault_id = VaultId::new();
        let granted = VaultItemId::new();
        let source = SessionGrant::new(spec_for(Spec {
            session_id: SessionId::new(),
            subject: holder,
            scope: rows(vault_id, &[granted]),
            role: SessionRole::Read,
            lifetime: Duration::days(2),
            now,
        }))
        .expect("a valid source");

        // Whole collection out of three rows: the mistake the subset test
        // exists to catch.
        let widened = SessionGrant::referencing(
            &source,
            NewSessionGrant {
                link: GrantLink::Referenced {
                    source_grant_id: source.id,
                },
                ..spec_for(Spec {
                    session_id: SessionId::new(),
                    subject: holder,
                    scope: GrantScope::Collection { vault_id },
                    role: SessionRole::Read,
                    lifetime: Duration::hours(1),
                    now,
                })
            },
        );
        assert!(matches!(widened, Err(DomainError::SessionGrantWiden(_))));
    }

    #[test]
    fn a_reference_may_not_upgrade_read_into_write_or_outlive_its_source() {
        let now = Utc::now();
        let holder = PrincipalId::new();
        let vault_id = VaultId::new();
        let source = collection_grant(
            SessionId::new(),
            holder,
            vault_id,
            SessionRole::Read,
            Duration::hours(2),
            now,
        );

        let escalated = SessionGrant::referencing(
            &source,
            NewSessionGrant {
                link: GrantLink::Referenced {
                    source_grant_id: source.id,
                },
                ..spec_for(Spec {
                    session_id: SessionId::new(),
                    subject: holder,
                    scope: GrantScope::Collection { vault_id },
                    role: SessionRole::Write,
                    lifetime: Duration::hours(1),
                    now,
                })
            },
        );
        assert!(matches!(escalated, Err(DomainError::SessionGrantWiden(_))));

        let outliving = SessionGrant::referencing(
            &source,
            NewSessionGrant {
                link: GrantLink::Referenced {
                    source_grant_id: source.id,
                },
                ..spec_for(Spec {
                    session_id: SessionId::new(),
                    subject: holder,
                    scope: GrantScope::Collection { vault_id },
                    role: SessionRole::Read,
                    lifetime: Duration::hours(6),
                    now,
                })
            },
        );
        assert!(matches!(outliving, Err(DomainError::SessionGrantWiden(_))));
    }

    #[test]
    fn a_reference_to_somebody_elses_grant_is_a_transfer_and_is_refused() {
        // The subtle one. Scope, role and expiry all narrow correctly; only
        // the holder is different, which turns "point at reach you already
        // have" into "give my colleague's access to you".
        let now = Utc::now();
        let vault_id = VaultId::new();
        let source = collection_grant(
            SessionId::new(),
            PrincipalId::new(),
            vault_id,
            SessionRole::Read,
            Duration::days(2),
            now,
        );
        let stolen = SessionGrant::referencing(
            &source,
            NewSessionGrant {
                link: GrantLink::Referenced {
                    source_grant_id: source.id,
                },
                ..spec_for(Spec {
                    session_id: SessionId::new(),
                    subject: PrincipalId::new(),
                    scope: GrantScope::Collection { vault_id },
                    role: SessionRole::Read,
                    lifetime: Duration::hours(1),
                    now,
                })
            },
        );
        assert!(matches!(
            stolen,
            Err(DomainError::SessionGrantLinkUnchecked(_))
        ));
    }

    #[test]
    fn a_reference_cannot_point_at_a_grant_it_was_not_checked_against() {
        let now = Utc::now();
        let holder = PrincipalId::new();
        let vault_id = VaultId::new();
        let source = collection_grant(
            SessionId::new(),
            holder,
            vault_id,
            SessionRole::Read,
            Duration::days(2),
            now,
        );
        let mismatched = SessionGrant::referencing(
            &source,
            NewSessionGrant {
                link: GrantLink::Referenced {
                    source_grant_id: SessionGrantId::new(),
                },
                ..spec_for(Spec {
                    session_id: SessionId::new(),
                    subject: holder,
                    scope: GrantScope::Collection { vault_id },
                    role: SessionRole::Read,
                    lifetime: Duration::hours(1),
                    now,
                })
            },
        );
        assert!(matches!(
            mismatched,
            Err(DomainError::SessionGrantLinkUnchecked(_))
        ));
    }

    #[test]
    fn referencing_a_dead_grant_does_not_resurrect_it() {
        let now = Utc::now();
        let holder = PrincipalId::new();
        let vault_id = VaultId::new();
        let mut source = collection_grant(
            SessionId::new(),
            holder,
            vault_id,
            SessionRole::Read,
            Duration::hours(1),
            now,
        );

        let reference = |source: &SessionGrant, at: DateTime<Utc>| {
            SessionGrant::referencing(
                source,
                NewSessionGrant {
                    link: GrantLink::Referenced {
                        source_grant_id: source.id,
                    },
                    ..spec_for(Spec {
                        session_id: SessionId::new(),
                        subject: holder,
                        scope: GrantScope::Collection { vault_id },
                        role: SessionRole::Read,
                        lifetime: Duration::minutes(5),
                        now: at,
                    })
                },
            )
        };

        assert!(reference(&source, now).is_ok());
        assert!(matches!(
            reference(&source, now + Duration::hours(2)),
            Err(DomainError::GrantTimeWindow)
        ));

        source.revoked_at = Some(now);
        assert!(matches!(
            reference(&source, now),
            Err(DomainError::GrantRevoked)
        ));
    }

    // ---- SES-END: what closing takes back, and what it must not

    #[test]
    fn only_lifecycle_bound_reach_ends_with_the_session() {
        // The pair this distinction exists for. Closing a meeting must revoke
        // what the meeting handed out, and must not revoke the project access
        // somebody walked in with.
        let now = Utc::now();
        let holder = PrincipalId::new();
        let vault_id = VaultId::new();
        let minted = collection_grant(
            SessionId::new(),
            holder,
            vault_id,
            SessionRole::Read,
            Duration::hours(1),
            now,
        );
        let source = collection_grant(
            SessionId::new(),
            holder,
            vault_id,
            SessionRole::Read,
            Duration::days(2),
            now,
        );
        let pointer = SessionGrant::referencing(
            &source,
            NewSessionGrant {
                link: GrantLink::Referenced {
                    source_grant_id: source.id,
                },
                ..spec_for(Spec {
                    session_id: SessionId::new(),
                    subject: holder,
                    scope: GrantScope::Collection { vault_id },
                    role: SessionRole::Read,
                    lifetime: Duration::hours(1),
                    now,
                })
            },
        )
        .expect("a narrowing reference");

        assert!(minted.ends_with_session());
        assert!(
            !pointer.ends_with_session(),
            "closing a session would have revoked reach it never granted"
        );
        assert!(GrantLink::LifecycleBound.ends_with_session());
        assert_eq!(GrantLink::LifecycleBound.source_grant_id(), None);
    }
}
