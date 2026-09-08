use access::{
    permits, set_project_access, set_role_ceiling, PolicyActor, ProjectAccess, ResourcePermission,
};
use opensesame_connection_broker::config_access as access;
use opensesame_domain::{OrganizationId, OrganizationRole, PrincipalId};
use opensesame_storage::Db;

#[tokio::test]
async fn concurrent_policy_updates_have_one_winner_and_preserve_revocation_fence() {
    let db = store().await;
    let org = OrganizationId::new();
    let principal = PrincipalId::new();
    set_role_ceiling(
        db.pool(),
        &org,
        &principal,
        Some(OrganizationRole::Admin),
        0,
        10,
    )
    .await
    .unwrap();
    let (left, right) = tokio::join!(
        set_role_ceiling(db.pool(), &org, &principal, None, 1, 20),
        set_role_ceiling(
            db.pool(),
            &org,
            &principal,
            Some(OrganizationRole::Member),
            1,
            20
        ),
    );
    assert_ne!(left.is_ok(), right.is_ok());
    let stale = PolicyActor::Session {
        principal,
        role: OrganizationRole::Admin,
    };
    assert!(!permits(
        db.pool(),
        &org,
        &stale,
        "project",
        ResourcePermission::Manage
    )
    .await
    .unwrap());
    assert!(
        narrow_from_identity(db.pool(), &org, &principal, OrganizationRole::Owner, 19)
            .await
            .is_err()
    );
}

async fn store() -> Db {
    let db = Db::connect_memory().await.unwrap();
    let exists: i64 = sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='config_authorization_roles'").fetch_one(db.pool()).await.unwrap();
    if exists == 0 {
        sqlx::raw_sql(include_str!(
            "../../../migrations/0032_config_authorization.sql"
        ))
        .execute(db.pool())
        .await
        .unwrap();
    }
    db
}

#[tokio::test]
async fn role_project_and_key_permissions_are_independent_and_revocation_is_live() {
    let db = store().await;
    let org = OrganizationId::new();
    let other = OrganizationId::new();
    let principal = PrincipalId::new();
    let member = PolicyActor::Session {
        principal,
        role: OrganizationRole::Member,
    };
    assert!(
        !permits(db.pool(), &org, &member, "a", ResourcePermission::Metadata)
            .await
            .unwrap()
    );
    set_role_ceiling(
        db.pool(),
        &org,
        &principal,
        Some(OrganizationRole::Member),
        0,
        10,
    )
    .await
    .unwrap();
    assert!(access::role_policy(db.pool(), &org, &principal)
        .await
        .unwrap()
        .is_some());
    set_project_access(
        db.pool(),
        &org,
        &PolicyActor::Operator,
        "a",
        &principal,
        ProjectAccess {
            metadata_read: true,
            keys_read: false,
        },
    )
    .await
    .unwrap();
    assert!(
        permits(db.pool(), &org, &member, "a", ResourcePermission::Metadata)
            .await
            .unwrap()
    );
    for permission in [ResourcePermission::Keys, ResourcePermission::Manage] {
        assert!(!permits(db.pool(), &org, &member, "a", permission)
            .await
            .unwrap());
    }
    assert!(
        !permits(db.pool(), &org, &member, "b", ResourcePermission::Metadata)
            .await
            .unwrap()
    );
    assert!(!permits(
        db.pool(),
        &other,
        &member,
        "a",
        ResourcePermission::Metadata
    )
    .await
    .unwrap());
    set_project_access(
        db.pool(),
        &org,
        &PolicyActor::Operator,
        "a",
        &principal,
        ProjectAccess {
            metadata_read: true,
            keys_read: true,
        },
    )
    .await
    .unwrap();
    assert!(
        permits(db.pool(), &org, &member, "a", ResourcePermission::Keys)
            .await
            .unwrap()
    );
    assert_revocation_clears_project_access(&db, &org, &principal, &member).await;
}

#[tokio::test]
async fn stale_admin_session_and_old_identity_evidence_cannot_raise_a_ceiling() {
    let db = store().await;
    let org = OrganizationId::new();
    let principal = PrincipalId::new();
    let admin = PolicyActor::Session {
        principal,
        role: OrganizationRole::Admin,
    };
    assert!(
        narrow_from_identity(db.pool(), &org, &principal, OrganizationRole::Owner, 1)
            .await
            .is_err()
    );
    set_role_ceiling(
        db.pool(),
        &org,
        &principal,
        Some(OrganizationRole::Admin),
        0,
        10,
    )
    .await
    .unwrap();
    assert!(
        permits(db.pool(), &org, &admin, "a", ResourcePermission::Manage)
            .await
            .unwrap()
    );
    set_role_ceiling(
        db.pool(),
        &org,
        &principal,
        Some(OrganizationRole::Member),
        1,
        20,
    )
    .await
    .unwrap();
    assert!(
        !permits(db.pool(), &org, &admin, "a", ResourcePermission::Manage)
            .await
            .unwrap()
    );
    assert!(
        narrow_from_identity(db.pool(), &org, &principal, OrganizationRole::Owner, 19)
            .await
            .is_err()
    );
    narrow_from_identity(db.pool(), &org, &principal, OrganizationRole::Owner, 21)
        .await
        .unwrap();
    assert!(
        !permits(db.pool(), &org, &admin, "a", ResourcePermission::Manage)
            .await
            .unwrap()
    );
    assert!(set_role_ceiling(
        db.pool(),
        &org,
        &principal,
        Some(OrganizationRole::Owner),
        0,
        22
    )
    .await
    .is_err());
    assert!(set_project_access(
        db.pool(),
        &org,
        &admin,
        "a",
        &principal,
        ProjectAccess {
            metadata_read: true,
            keys_read: true
        }
    )
    .await
    .is_err());
}

async fn narrow_from_identity(
    pool: &sqlx::SqlitePool,
    organization: &OrganizationId,
    principal: &PrincipalId,
    role: OrganizationRole,
    auth_time: i64,
) -> anyhow::Result<()> {
    let role = match role {
        OrganizationRole::Owner => "owner",
        OrganizationRole::Admin => "admin",
        OrganizationRole::Member => "member",
    };
    let mut tx = pool.begin().await?;
    opensesame_storage::host_authorizations::narrow_identity_role(
        &mut tx,
        &organization.to_string(),
        &principal.to_string(),
        role,
        auth_time,
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn assert_revocation_clears_project_access(
    db: &Db,
    org: &OrganizationId,
    principal: &PrincipalId,
    member: &PolicyActor,
) {
    set_role_ceiling(db.pool(), org, principal, None, 1, 20)
        .await
        .unwrap();
    assert!(
        !permits(db.pool(), org, member, "a", ResourcePermission::Keys)
            .await
            .unwrap()
    );
    assert!(
        narrow_from_identity(db.pool(), org, principal, OrganizationRole::Owner, 30)
            .await
            .is_err()
    );
    set_role_ceiling(
        db.pool(),
        org,
        principal,
        Some(OrganizationRole::Member),
        2,
        40,
    )
    .await
    .unwrap();
    assert!(
        !permits(db.pool(), org, member, "a", ResourcePermission::Metadata)
            .await
            .unwrap()
    );
}
