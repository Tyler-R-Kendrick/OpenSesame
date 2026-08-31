//! Persistence for shared sessions, participants and scoped grants (ADR 0079).
//!
//! This layer stores and reconstructs domain values; it does not re-decide
//! anything. `SessionGrant::new` is the only way to mint a grant, so the
//! seven-day ceiling and the row-scope rules cannot be bypassed by reaching
//! the database instead — [`Db::insert_session_grant`] takes an already-valid
//! grant rather than the parts of one.
//!
//! The read path is deliberately belt-and-braces. [`Db::active_grants_for`]
//! narrows in SQL (this session, this subject, not revoked, not yet expired)
//! and the caller still asks [`opensesame_domain::SessionGrant::permits`],
//! which re-checks the subject, the clock, the role and the scope together.
//! The query is an index, not an authority: if the two ever disagree the
//! domain wins, because it is the one that cannot be fooled by a clock skew
//! between the database and the process.

use anyhow::{bail, Context};
use chrono::{DateTime, Utc};
use opensesame_domain::{
    GrantScope, JoinDecision, JoinRequest, JoinRequestId, PrincipalId, SessionGrant,
    SessionGrantId, SessionId, SessionRole, SessionVisibility, VaultId, VaultItemId,
};
use sqlx::{sqlite::SqliteRow, Row};
use std::collections::BTreeSet;

use crate::Db;

/// A session as stored: who runs it, what it is called, and whether strangers
/// may ask to join.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredSession {
    pub id: SessionId,
    pub organization_id: String,
    pub operator_principal_id: PrincipalId,
    /// Shown on a public session's discovery record. Never its contents.
    pub display_name: String,
    pub visibility: SessionVisibility,
    pub created_at: DateTime<Utc>,
    pub closed_at: Option<DateTime<Utc>>,
}

fn parse_time(raw: &str, field: &str) -> anyhow::Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .with_context(|| format!("{field} is not an RFC3339 timestamp"))
        .map(|value| value.with_timezone(&Utc))
}

fn parse_optional_time(raw: Option<String>, field: &str) -> anyhow::Result<Option<DateTime<Utc>>> {
    raw.map(|value| parse_time(&value, field)).transpose()
}

fn visibility_from(raw: &str) -> anyhow::Result<SessionVisibility> {
    match raw {
        "private" => Ok(SessionVisibility::Private),
        "public" => Ok(SessionVisibility::Public),
        other => bail!("unknown session visibility '{other}'"),
    }
}

fn visibility_str(visibility: SessionVisibility) -> &'static str {
    match visibility {
        SessionVisibility::Private => "private",
        SessionVisibility::Public => "public",
    }
}

fn role_from(raw: &str) -> anyhow::Result<SessionRole> {
    match raw {
        "read" => Ok(SessionRole::Read),
        "write" => Ok(SessionRole::Write),
        other => bail!("unknown session role '{other}'"),
    }
}

fn role_str(role: SessionRole) -> &'static str {
    match role {
        SessionRole::Read => "read",
        SessionRole::Write => "write",
    }
}

fn decision_str(decision: JoinDecision) -> &'static str {
    match decision {
        JoinDecision::Pending => "pending",
        JoinDecision::Admitted { .. } => "admitted",
        JoinDecision::Refused => "refused",
    }
}

fn stored_session(row: &SqliteRow) -> anyhow::Result<StoredSession> {
    let created_at: String = row.get("created_at");
    let closed_at: Option<String> = row.get("closed_at");
    let visibility: String = row.get("visibility");
    let operator: String = row.get("operator_principal_id");
    let id: String = row.get("id");
    Ok(StoredSession {
        id: SessionId::parse(&id).context("session id")?,
        organization_id: row.get("organization_id"),
        operator_principal_id: PrincipalId::parse(&operator).context("operator principal")?,
        display_name: row.get("display_name"),
        visibility: visibility_from(&visibility)?,
        created_at: parse_time(&created_at, "created_at")?,
        closed_at: parse_optional_time(closed_at, "closed_at")?,
    })
}

/// Rebuild a request from its row.
///
/// The decision is reassembled from two columns — `decision` and `grant_id` —
/// which the table's own CHECK keeps consistent: a grant id exists exactly
/// when the decision is `admitted`. A row that somehow arrived without one is
/// refused here rather than read as a bare admission, because an admission
/// that names no grant is an admission nobody can point at.
fn stored_join_request(row: &SqliteRow) -> anyhow::Result<JoinRequest> {
    let id: String = row.get("id");
    let session_id: String = row.get("session_id");
    let requester: String = row.get("requester_principal_id");
    let requested_at: String = row.get("requested_at");
    let decision: String = row.get("decision");
    let grant_id: Option<String> = row.get("grant_id");
    let decided_at: Option<String> = row.get("decided_at");
    let decided_by: Option<String> = row.get("decided_by_principal_id");

    let decision = match decision.as_str() {
        "pending" => JoinDecision::Pending,
        "admitted" => {
            let minted = grant_id.context("an admitted request with no grant")?;
            JoinDecision::Admitted {
                grant_id: SessionGrantId::parse(&minted).context("admitted grant id")?,
            }
        }
        "refused" => JoinDecision::Refused,
        other => bail!("unknown join decision '{other}'"),
    };

    Ok(JoinRequest {
        id: JoinRequestId::parse(&id).context("join request id")?,
        session_id: SessionId::parse(&session_id).context("session id")?,
        requester_principal_id: PrincipalId::parse(&requester).context("requester principal")?,
        note: row.get("note"),
        requested_at: parse_time(&requested_at, "requested_at")?,
        decision,
        decided_at: parse_optional_time(decided_at, "decided_at")?,
        decided_by_principal_id: decided_by
            .map(|raw| PrincipalId::parse(&raw).context("deciding principal"))
            .transpose()?,
    })
}

impl Db {
    /// Open a session. The operator is whoever creates it.
    ///
    /// # Errors
    ///
    /// Returns an error when the insert fails.
    pub async fn create_session(&self, session: &StoredSession) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO sessions (id, organization_id, project_id, \
             operator_principal_id, display_name, visibility, created_at, closed_at) \
             VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7)",
        )
        .bind(session.id.to_string())
        .bind(&session.organization_id)
        .bind(session.operator_principal_id.to_string())
        .bind(&session.display_name)
        .bind(visibility_str(session.visibility))
        .bind(session.created_at.to_rfc3339())
        .bind(session.closed_at.map(|at| at.to_rfc3339()))
        .execute(&self.pool)
        .await
        .context("insert session")?;
        Ok(())
    }

    /// One session by id, scoped to its organization.
    ///
    /// # Errors
    ///
    /// Returns an error when the query or the stored row cannot be read.
    pub async fn session(
        &self,
        organization_id: &str,
        id: SessionId,
    ) -> anyhow::Result<Option<StoredSession>> {
        let row = sqlx::query("SELECT * FROM sessions WHERE organization_id = ?1 AND id = ?2")
            .bind(organization_id)
            .bind(id.to_string())
            .fetch_optional(&self.pool)
            .await
            .context("select session")?;
        row.as_ref().map(stored_session).transpose()
    }

    /// Persist a grant that the domain has already validated.
    ///
    /// Takes a [`SessionGrant`] rather than its parts on purpose: the only way
    /// to construct one is `SessionGrant::new`, which enforces the lifetime
    /// bounds and refuses an empty row scope. A caller cannot reach past those
    /// rules by writing here instead.
    ///
    /// # Errors
    ///
    /// Returns an error when the insert fails, including when the database's
    /// own constraints refuse the row.
    pub async fn insert_session_grant(
        &self,
        organization_id: &str,
        grant: &SessionGrant,
    ) -> anyhow::Result<()> {
        let mut transaction = self.pool.begin().await.context("begin grant")?;
        let (scope_kind, vault_id, items) = match &grant.scope {
            GrantScope::Collection { vault_id } => ("collection", *vault_id, Vec::new()),
            GrantScope::Rows { vault_id, items } => {
                ("rows", *vault_id, items.iter().copied().collect::<Vec<_>>())
            }
        };

        sqlx::query(
            "INSERT INTO session_grants (id, session_id, organization_id, \
             subject_principal_id, granted_by_principal_id, scope_kind, vault_id, \
             role, granted_at, expires_at, revoked_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        )
        .bind(grant.id.to_string())
        .bind(grant.session_id.to_string())
        .bind(organization_id)
        .bind(grant.subject_principal_id.to_string())
        .bind(grant.granted_by_principal_id.to_string())
        .bind(scope_kind)
        .bind(vault_id.to_string())
        .bind(role_str(grant.role))
        .bind(grant.granted_at.to_rfc3339())
        .bind(grant.expires_at.to_rfc3339())
        .bind(grant.revoked_at.map(|at| at.to_rfc3339()))
        .execute(&mut *transaction)
        .await
        .context("insert session grant")?;

        for item in items {
            sqlx::query("INSERT INTO session_grant_items (grant_id, item_id) VALUES (?1, ?2)")
                .bind(grant.id.to_string())
                .bind(item.to_string())
                .execute(&mut *transaction)
                .await
                .context("insert granted row")?;
        }

        transaction.commit().await.context("commit grant")?;
        Ok(())
    }

    /// Every grant this principal holds in this session that is live at `now`.
    ///
    /// The SQL narrows; it does not decide. The caller still asks
    /// `SessionGrant::permits`, which re-checks subject, clock, role and scope
    /// together — see this module's header for why both.
    ///
    /// # Errors
    ///
    /// Returns an error when the query or a stored row cannot be read.
    pub async fn active_grants_for(
        &self,
        session_id: SessionId,
        subject_principal_id: PrincipalId,
        now: DateTime<Utc>,
    ) -> anyhow::Result<Vec<SessionGrant>> {
        let rows = sqlx::query(
            "SELECT * FROM session_grants \
             WHERE session_id = ?1 AND subject_principal_id = ?2 \
             AND revoked_at IS NULL AND expires_at > ?3 \
             ORDER BY granted_at",
        )
        .bind(session_id.to_string())
        .bind(subject_principal_id.to_string())
        .bind(now.to_rfc3339())
        .fetch_all(&self.pool)
        .await
        .context("select active grants")?;

        let mut grants = Vec::with_capacity(rows.len());
        for row in &rows {
            grants.push(self.stored_grant(row).await?);
        }
        Ok(grants)
    }

    /// Withdraw a grant. Idempotent, and never un-revokes one.
    ///
    /// Returns whether this call was the one that revoked it.
    ///
    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn revoke_session_grant(
        &self,
        id: SessionGrantId,
        now: DateTime<Utc>,
    ) -> anyhow::Result<bool> {
        // `revoked_at IS NULL` in the predicate is what makes this idempotent
        // and one-way: a second call updates nothing, and no call can move a
        // revocation later or clear it.
        let result = sqlx::query(
            "UPDATE session_grants SET revoked_at = ?1 \
             WHERE id = ?2 AND revoked_at IS NULL",
        )
        .bind(now.to_rfc3339())
        .bind(id.to_string())
        .execute(&self.pool)
        .await
        .context("revoke session grant")?;
        Ok(result.rows_affected() == 1)
    }

    async fn stored_grant(&self, row: &SqliteRow) -> anyhow::Result<SessionGrant> {
        let id: String = row.get("id");
        let id = SessionGrantId::parse(&id).context("grant id")?;
        let session_id: String = row.get("session_id");
        let subject: String = row.get("subject_principal_id");
        let granted_by: String = row.get("granted_by_principal_id");
        let scope_kind: String = row.get("scope_kind");
        let vault_id: String = row.get("vault_id");
        let vault_id = VaultId::parse(&vault_id).context("vault id")?;
        let role: String = row.get("role");
        let granted_at: String = row.get("granted_at");
        let expires_at: String = row.get("expires_at");
        let revoked_at: Option<String> = row.get("revoked_at");

        let scope = match scope_kind.as_str() {
            "collection" => GrantScope::Collection { vault_id },
            "rows" => {
                let item_rows =
                    sqlx::query("SELECT item_id FROM session_grant_items WHERE grant_id = ?1")
                        .bind(id.to_string())
                        .fetch_all(&self.pool)
                        .await
                        .context("select granted rows")?;
                let mut items = BTreeSet::new();
                for item_row in &item_rows {
                    let item_id: String = item_row.get("item_id");
                    items.insert(VaultItemId::parse(&item_id).context("granted item id")?);
                }
                GrantScope::Rows { vault_id, items }
            }
            other => bail!("unknown grant scope kind '{other}'"),
        };

        // Reconstructed rather than rebuilt through `SessionGrant::new`: a row
        // written under an older ceiling must still read back as what it is.
        // Whether it may be *used* is `assert_active`'s question, asked on
        // every check, and that does not depend on the ceiling at all.
        Ok(SessionGrant {
            id,
            session_id: SessionId::parse(&session_id).context("session id")?,
            subject_principal_id: PrincipalId::parse(&subject).context("subject principal")?,
            granted_by_principal_id: PrincipalId::parse(&granted_by)
                .context("granting principal")?,
            scope,
            role: role_from(&role)?,
            granted_at: parse_time(&granted_at, "granted_at")?,
            expires_at: parse_time(&expires_at, "expires_at")?,
            revoked_at: parse_optional_time(revoked_at, "revoked_at")?,
        })
    }

    /// Record a stranger asking to be let in.
    ///
    /// # Errors
    ///
    /// Returns an error when the insert fails, including when this principal
    /// already has a pending request on this session — asking twice is the
    /// same ask, and the partial unique index refuses the second.
    pub async fn insert_join_request(
        &self,
        organization_id: &str,
        request: &JoinRequest,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO session_join_requests (id, session_id, organization_id, \
             requester_principal_id, note, requested_at, decision) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending')",
        )
        .bind(request.id.to_string())
        .bind(request.session_id.to_string())
        .bind(organization_id)
        .bind(request.requester_principal_id.to_string())
        .bind(request.note.as_deref())
        .bind(request.requested_at.to_rfc3339())
        .execute(&self.pool)
        .await
        .context("insert join request")?;
        Ok(())
    }

    /// Admit or refuse a pending request, in one transaction with the grant
    /// that admitting mints.
    ///
    /// Admission IS a grant: passing `JoinDecision::Admitted` without having
    /// the grant to write alongside it is unrepresentable, and the two land
    /// together or not at all. A request that is no longer pending is refused
    /// rather than re-decided, so a second approval cannot rewrite the first.
    ///
    /// # Errors
    ///
    /// Returns an error when the request is not pending, when the grant does
    /// not match the decision, or when either write fails.
    pub async fn decide_join_request(
        &self,
        organization_id: &str,
        request_id: JoinRequestId,
        decision: JoinDecision,
        decided_by: PrincipalId,
        decided_at: DateTime<Utc>,
        minted: Option<&SessionGrant>,
    ) -> anyhow::Result<()> {
        // Matched on the decision itself rather than a tuple so the compiler
        // checks every shape: the pairings that are contradictions each get
        // their own refusal instead of falling through a catch-all.
        let grant_id = match decision {
            JoinDecision::Pending => {
                bail!("deciding a request to 'pending' is not a decision")
            }
            JoinDecision::Admitted { grant_id } => match minted {
                Some(grant) if grant.id == grant_id => Some(grant_id),
                _ => bail!("admission must carry the grant it mints"),
            },
            JoinDecision::Refused => {
                if minted.is_some() {
                    bail!("a refusal must not carry a grant");
                }
                None
            }
        };

        let mut transaction = self.pool.begin().await.context("begin decision")?;

        if let Some(grant) = minted {
            // Written inside the same transaction as the decision, so a
            // partial failure cannot leave an admitted request pointing at a
            // grant that does not exist.
            self.insert_grant_in(&mut transaction, organization_id, grant)
                .await?;
        }

        // `decision = 'pending'` in the predicate is the guard: a request that
        // has already been decided is not decided again, and the audit trail
        // cannot be edited in place. A later ask is a new row.
        let result = sqlx::query(
            "UPDATE session_join_requests \
             SET decision = ?1, decided_at = ?2, decided_by_principal_id = ?3, grant_id = ?4 \
             WHERE id = ?5 AND organization_id = ?6 AND decision = 'pending'",
        )
        .bind(decision_str(decision))
        .bind(decided_at.to_rfc3339())
        .bind(decided_by.to_string())
        .bind(grant_id.map(|id| id.to_string()))
        .bind(request_id.to_string())
        .bind(organization_id)
        .execute(&mut *transaction)
        .await
        .context("decide join request")?;

        if result.rows_affected() != 1 {
            bail!("join request is not pending");
        }

        transaction.commit().await.context("commit decision")?;
        Ok(())
    }

    /// The grant insert, inside a caller's transaction.
    async fn insert_grant_in(
        &self,
        transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        organization_id: &str,
        grant: &SessionGrant,
    ) -> anyhow::Result<()> {
        let (scope_kind, vault_id, items) = match &grant.scope {
            GrantScope::Collection { vault_id } => ("collection", *vault_id, Vec::new()),
            GrantScope::Rows { vault_id, items } => {
                ("rows", *vault_id, items.iter().copied().collect::<Vec<_>>())
            }
        };
        sqlx::query(
            "INSERT INTO session_grants (id, session_id, organization_id, \
             subject_principal_id, granted_by_principal_id, scope_kind, vault_id, \
             role, granted_at, expires_at, revoked_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)",
        )
        .bind(grant.id.to_string())
        .bind(grant.session_id.to_string())
        .bind(organization_id)
        .bind(grant.subject_principal_id.to_string())
        .bind(grant.granted_by_principal_id.to_string())
        .bind(scope_kind)
        .bind(vault_id.to_string())
        .bind(role_str(grant.role))
        .bind(grant.granted_at.to_rfc3339())
        .bind(grant.expires_at.to_rfc3339())
        .execute(&mut **transaction)
        .await
        .context("insert minted grant")?;

        for item in items {
            sqlx::query("INSERT INTO session_grant_items (grant_id, item_id) VALUES (?1, ?2)")
                .bind(grant.id.to_string())
                .bind(item.to_string())
                .execute(&mut **transaction)
                .await
                .context("insert minted grant row")?;
        }
        Ok(())
    }

    /// Open, public sessions in one organization — the discovery record.
    ///
    /// Selected, not filtered afterwards: `visibility = 'public'` is in the
    /// predicate, so a private session cannot reach a caller through this path
    /// even if the layer above forgot to check. Closed sessions are excluded
    /// too — a session nobody is running is not something to ask to join.
    ///
    /// The rows carry the whole [`StoredSession`]; what a *caller* is shown is
    /// the route's decision, and ADR 0079 §7 makes it a name and an id.
    ///
    /// # Errors
    ///
    /// Returns an error when the query or the reconstruction fails.
    pub async fn public_sessions(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredSession>> {
        let rows = sqlx::query(
            "SELECT * FROM sessions \
             WHERE organization_id = ?1 AND visibility = 'public' AND closed_at IS NULL \
             ORDER BY created_at DESC",
        )
        .bind(organization_id)
        .fetch_all(&self.pool)
        .await
        .context("select public sessions")?;
        rows.iter().map(stored_session).collect()
    }

    /// Every live grant on one session — the roster, from the grant side.
    ///
    /// Revoked and expired grants are excluded in SQL and every survivor is
    /// re-checked with `assert_active`, the same belt-and-braces the
    /// per-subject read uses. A roster is a list of who can reach something
    /// right now; a lapsed grant on it would misreport that.
    ///
    /// # Errors
    ///
    /// Returns an error when the query or the reconstruction fails.
    pub async fn active_session_grants(
        &self,
        session_id: SessionId,
        now: DateTime<Utc>,
    ) -> anyhow::Result<Vec<SessionGrant>> {
        let rows = sqlx::query(
            "SELECT * FROM session_grants \
             WHERE session_id = ?1 AND revoked_at IS NULL AND expires_at > ?2 \
             ORDER BY granted_at",
        )
        .bind(session_id.to_string())
        .bind(now.to_rfc3339())
        .fetch_all(&self.pool)
        .await
        .context("select session roster")?;

        let mut grants = Vec::with_capacity(rows.len());
        for row in &rows {
            let grant = self.stored_grant(row).await?;
            if grant.assert_active(now).is_ok() {
                grants.push(grant);
            }
        }
        Ok(grants)
    }

    /// One grant by id, whatever its state.
    ///
    /// Unfiltered on purpose: this is what a revoke path reads to find out
    /// which session a grant belongs to before deciding whether the caller may
    /// revoke it. Answering "does this grant exist" is not answering "may you
    /// use it" — that stays [`opensesame_domain::SessionGrant::permits`]'s
    /// question, asked separately.
    ///
    /// # Errors
    ///
    /// Returns an error when the query or the reconstruction fails.
    pub async fn session_grant(
        &self,
        organization_id: &str,
        id: SessionGrantId,
    ) -> anyhow::Result<Option<SessionGrant>> {
        let row =
            sqlx::query("SELECT * FROM session_grants WHERE organization_id = ?1 AND id = ?2")
                .bind(organization_id)
                .bind(id.to_string())
                .fetch_optional(&self.pool)
                .await
                .context("select session grant")?;
        match row {
            Some(row) => Ok(Some(self.stored_grant(&row).await?)),
            None => Ok(None),
        }
    }

    /// Requests on one session that nobody has decided yet.
    ///
    /// # Errors
    ///
    /// Returns an error when the query or the reconstruction fails.
    pub async fn pending_join_requests(
        &self,
        session_id: SessionId,
    ) -> anyhow::Result<Vec<JoinRequest>> {
        let rows = sqlx::query(
            "SELECT * FROM session_join_requests \
             WHERE session_id = ?1 AND decision = 'pending' ORDER BY requested_at",
        )
        .bind(session_id.to_string())
        .fetch_all(&self.pool)
        .await
        .context("select pending join requests")?;
        rows.iter().map(stored_join_request).collect()
    }

    /// One join request by id, whatever its decision.
    ///
    /// # Errors
    ///
    /// Returns an error when the query or the reconstruction fails.
    pub async fn join_request(
        &self,
        organization_id: &str,
        id: JoinRequestId,
    ) -> anyhow::Result<Option<JoinRequest>> {
        let row = sqlx::query(
            "SELECT * FROM session_join_requests WHERE organization_id = ?1 AND id = ?2",
        )
        .bind(organization_id)
        .bind(id.to_string())
        .fetch_optional(&self.pool)
        .await
        .context("select join request")?;
        row.as_ref().map(stored_join_request).transpose()
    }

    /// Live grants approaching their deadline, for the lifecycle scanner.
    ///
    /// Revoked grants are excluded: a withdrawn grant has no deadline worth
    /// narrating, and telling somebody their access expires in an hour when it
    /// ended yesterday is worse than silence.
    ///
    /// # Errors
    ///
    /// Returns an error when the query or a stored row cannot be read.
    pub async fn session_grants_expiring(
        &self,
        organization_id: &str,
        limit: i64,
    ) -> anyhow::Result<Vec<SessionGrant>> {
        let rows = sqlx::query(
            "SELECT * FROM session_grants \
             WHERE organization_id = ?1 AND revoked_at IS NULL \
             ORDER BY expires_at LIMIT ?2",
        )
        .bind(organization_id)
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .context("select expiring grants")?;
        let mut grants = Vec::with_capacity(rows.len());
        for row in &rows {
            grants.push(self.stored_grant(row).await?);
        }
        Ok(grants)
    }
}
