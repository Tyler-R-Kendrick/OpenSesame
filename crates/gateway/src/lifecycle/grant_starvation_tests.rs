//! A full pass of lapsed grants whose expiry was already published must not
//! crowd a live grant out of collection (ADR 0074, ADR 0079 §4, ADR 0120 §5).
//!
//! Nothing revokes or deletes a session grant or an authority sidecar when it
//! lapses, so a busy organization keeps a long tail of them. Each case fills a
//! pass's cap with lapsed grants, adds one live grant, and asks the scanner to
//! warn about it, then to publish its `expired` once it lapses too.

use chrono::{DateTime, Duration, Utc};
use opensesame_domain::{
    GrantLink, GrantScope, NewSessionGrant, PrincipalId, SessionGrant, SessionGrantId, SessionId,
    SessionRole, SessionVisibility, VaultId,
};
use opensesame_lifecycle::{ExpiryStage, SubjectKind, Track};
use opensesame_storage::authority::{AuthorityIssue, NewAccessDomain, PermissionEntry};
use opensesame_storage::StoredSession;
use serde_json::json;

use super::authority_subjects::AUTHORITY_GRANT_SCAN_LIMIT;
use super::subjects::SESSION_GRANT_SCAN_LIMIT;
use crate::app_state::{test_demo_state, AppState};
use crate::lifecycle::scanner::scan_organization;

const DOMAIN: &str = "adom:starvation";

/// How far up the alert ladder the scanner has published one subject.
async fn alert_stage(state: &AppState, kind: SubjectKind, subject_id: &str) -> Option<String> {
    state
        .db
        .get_lifecycle_watermarks(
            &state.connection_organization.to_string(),
            kind.as_str(),
            subject_id,
        )
        .await
        .expect("watermarks")
        .into_iter()
        .find(|row| row.track == Track::Alert.as_str())
        .map(|row| row.stage)
}

async fn open_session(state: &AppState) -> StoredSession {
    let session = StoredSession {
        id: SessionId::new(),
        organization_id: state.connection_organization.to_string(),
        operator_principal_id: PrincipalId::new(),
        display_name: "Long-running incident".into(),
        visibility: SessionVisibility::Private,
        created_at: Utc::now() - Duration::days(2),
        closed_at: None,
    };
    state.db.create_session(&session).await.expect("session");
    session
}

async fn session_grant(
    state: &AppState,
    session: &StoredSession,
    expires_at: DateTime<Utc>,
) -> SessionGrantId {
    let grant = SessionGrant::new(NewSessionGrant {
        id: SessionGrantId::new(),
        session_id: session.id,
        subject_principal_id: PrincipalId::new(),
        granted_by_principal_id: session.operator_principal_id,
        scope: GrantScope::Collection {
            vault_id: VaultId::new(),
        },
        role: SessionRole::Read,
        granted_at: expires_at - Duration::hours(1),
        expires_at,
        link: GrantLink::LifecycleBound,
    })
    .expect("a valid grant");
    state
        .db
        .insert_session_grant(&session.organization_id, &grant)
        .await
        .expect("grant");
    grant.id
}

async fn authority_grant(state: &AppState, grant_id: &str, expires_at: DateTime<Utc>) {
    let organization = state.connection_organization.to_string();
    sqlx::query(
        "INSERT INTO grants (id, organization_id, body_json, revoked_at, created_at) \
         VALUES (?, ?, ?, NULL, ?)",
    )
    .bind(grant_id)
    .bind(&organization)
    .bind(
        json!({
            "id": grant_id,
            "actions": ["read"],
            "resources": ["connection:alpha"],
            "connection_id": "connection:alpha",
            "parent_grant_id": serde_json::Value::Null,
            "delegation_depth": 0,
            "created_at": (expires_at - Duration::hours(1)).to_rfc3339(),
            "expires_at": expires_at.to_rfc3339(),
        })
        .to_string(),
    )
    .bind(Utc::now().to_rfc3339())
    .execute(state.db.pool())
    .await
    .expect("grant envelope");
    let issued = state
        .db
        .issue_authority(
            &AuthorityIssue {
                grant_id,
                organization_id: &organization,
                domain_id: DOMAIN,
                parent_grant_id: None,
                issuance_basis: "root",
                lineage_digest: "digest:lineage",
                policy_digest: "digest:policy",
                role_revision: None,
                offer_id: None,
                delegation_depth_remaining: 0,
                not_before: expires_at - Duration::hours(1),
                expires_at,
                evidence_id: None,
            },
            &[PermissionEntry {
                resource_selector: "resource:A".into(),
                provider_operation_id: "connection.invoke:connection:alpha".into(),
                action_set_json: "[\"read\"]".into(),
                parameter_constraints_json: "{}".into(),
                audience_set_json: "[]".into(),
                manifest_digest: "digest:manifest".into(),
            }],
        )
        .await
        .expect("issue");
    assert!(issued, "{grant_id} was not issued");
}

/// The lapsed tail fills one read exactly: lapsed 23 hours ago, a second apart.
fn lapsed_at(now: DateTime<Utc>, index: i64) -> DateTime<Utc> {
    now - Duration::hours(23) + Duration::seconds(index)
}

/// The two passes every case runs, and what each must have published.
async fn assert_live_grant_is_narrated(
    state: &AppState,
    kind: SubjectKind,
    oldest_lapsed: &str,
    live: &str,
    now: DateTime<Utc>,
) {
    let organization = state.connection_organization;
    scan_organization(state, &organization, now)
        .await
        .expect("first pass");
    assert_eq!(
        alert_stage(state, kind, oldest_lapsed).await.as_deref(),
        Some(ExpiryStage::Expired.as_str())
    );
    assert_eq!(
        alert_stage(state, kind, live).await.as_deref(),
        Some(ExpiryStage::Urgent.as_str()),
        "a live grant got no advance notice"
    );

    // The live grant lapses while every older one, already published, has
    // not been revoked or deleted.
    scan_organization(state, &organization, now + Duration::minutes(31))
        .await
        .expect("second pass");
    assert_eq!(
        alert_stage(state, kind, live).await.as_deref(),
        Some(ExpiryStage::Expired.as_str()),
        "a lapsed grant's expiry was not published on the pass after it"
    );
}

#[tokio::test]
async fn published_session_grant_expiries_never_crowd_a_live_grant_out_of_the_pass() {
    let state = test_demo_state().await;
    let session = open_session(&state).await;
    let now = Utc::now();
    let oldest = session_grant(&state, &session, lapsed_at(now, 0)).await;
    for index in 1..SESSION_GRANT_SCAN_LIMIT {
        session_grant(&state, &session, lapsed_at(now, index)).await;
    }
    let live = session_grant(&state, &session, now + Duration::minutes(30)).await;

    assert_live_grant_is_narrated(
        &state,
        SubjectKind::SessionGrant,
        &oldest.to_string(),
        &live.to_string(),
        now,
    )
    .await;
}

#[tokio::test]
async fn published_authority_grant_expiries_never_crowd_a_live_grant_out_of_the_pass() {
    let state = test_demo_state().await;
    state
        .db
        .create_access_domain(&NewAccessDomain {
            id: DOMAIN,
            organization_id: &state.connection_organization.to_string(),
            parent_id: None,
            project_id: None,
        })
        .await
        .expect("domain");
    let now = Utc::now();
    for index in 0..AUTHORITY_GRANT_SCAN_LIMIT {
        authority_grant(
            &state,
            &format!("grant:lapsed-{index:03}"),
            lapsed_at(now, index),
        )
        .await;
    }
    authority_grant(&state, "grant:live", now + Duration::minutes(30)).await;

    assert_live_grant_is_narrated(
        &state,
        SubjectKind::AuthorityGrant,
        "grant:lapsed-000",
        "grant:live",
        now,
    )
    .await;
}
