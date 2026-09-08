use opensesame_storage::Db;

async fn credential(db: &Db, org: &str, id: &str, bytes: i64) {
    sqlx::query("INSERT INTO connections(id,organization_id,provider_id,logical_name,display_name,status,requested_scopes,granted_scopes,owner_kind,shareability,max_invoke_level,egress_json,created_at,updated_at) VALUES (?,?,'test',?,'test','active','[]','[]','organization','private',1,'{}','t','t')")
        .bind(id).bind(org).bind(id).execute(db.pool()).await.unwrap();
    sqlx::query("INSERT INTO connection_credentials(connection_id,ciphertext,nonce,aad_digest,token_type,refreshable,created_at,updated_at,version) VALUES (?,zeroblob(?),X'01','digest','Bearer',0,'t','t','version')")
        .bind(id).bind(bytes).execute(db.pool()).await.unwrap();
}

async fn vault(db: &Db, org: &str, id: &str) {
    sqlx::query("INSERT OR IGNORE INTO organizations(id,name,created_at) VALUES (?,'test','t')")
        .bind(org)
        .execute(db.pool())
        .await
        .unwrap();
    sqlx::query("INSERT INTO vaults(id,organization_id,created_at) VALUES (?,?,'t')")
        .bind(id)
        .bind(org)
        .execute(db.pool())
        .await
        .unwrap();
}

async fn revision(db: &Db, vault: &str, item: &str, number: i64, bytes: i64) {
    sqlx::query("INSERT INTO encrypted_item_revisions(id,vault_id,item_id,revision,envelope_version,ciphertext,wrapping_json,ad_digest,created_at) VALUES (?,?,?,?,1,zeroblob(?),'{}','digest','t')")
        .bind(format!("{vault}/{item}/{number}")).bind(vault).bind(item).bind(number).bind(bytes)
        .execute(db.pool()).await.unwrap();
}

#[tokio::test]
async fn credential_pages_are_ordered_count_bounded_and_tenant_scoped() {
    let db = Db::connect_memory().await.unwrap();
    for n in (0..40).rev() {
        credential(&db, "a", &format!("c{n:03}"), 4).await;
    }
    credential(&db, "b", "foreign", 4).await;
    let (first, more) = db.backup_credentials_page("a", "").await.unwrap();
    assert!(more);
    assert_eq!(first.len(), 32);
    assert_eq!(first[0].connection_id, "c000");
    assert_eq!(first[31].connection_id, "c031");
    let (second, more) = db
        .backup_credentials_page("a", &first[31].connection_id)
        .await
        .unwrap();
    assert!(!more);
    assert_eq!(second.len(), 8);
    assert_eq!(second[0].connection_id, "c032");
    assert_eq!(second[7].connection_id, "c039");
    assert_eq!(
        db.backup_credentials_page("b", "").await.unwrap().0.len(),
        1
    );
}

#[tokio::test]
async fn revision_pages_preserve_equal_key_components_and_tenant_scope() {
    let db = Db::connect_memory().await.unwrap();
    vault(&db, "a", "v1").await;
    vault(&db, "b", "v2").await;
    for n in (0..40).rev() {
        revision(&db, "v1", "same", n, 4).await;
    }
    revision(&db, "v1", "then", 0, 4).await;
    revision(&db, "v2", "foreign", 0, 4).await;
    let (first, more) = db.backup_revisions_page("a", None).await.unwrap();
    assert!(more);
    assert_eq!(first.len(), 32);
    assert_eq!(
        first.iter().map(|r| r.revision).collect::<Vec<_>>(),
        (0..32).collect::<Vec<_>>()
    );
    let cursor = ("v1".into(), "same".into(), 31);
    let (second, more) = db.backup_revisions_page("a", Some(&cursor)).await.unwrap();
    assert!(!more);
    assert_eq!(second.len(), 9);
    assert_eq!(second[0].revision, 32);
    assert_eq!(second[8].item_id, "then");
    assert!(second.iter().all(|row| row.vault_id == "v1"));
}

#[tokio::test]
async fn byte_budget_stops_before_loading_the_complete_owner_inventory() {
    let db = Db::connect_memory().await.unwrap();
    for n in 0..4 {
        credential(&db, "a", &format!("c{n}"), 2 * 1024 * 1024 - 1).await;
    }
    let (page, more) = db.backup_credentials_page("a", "").await.unwrap();
    assert!(more);
    assert_eq!(page.len(), 2);
    let (last, more) = db
        .backup_credentials_page("a", &page[1].connection_id)
        .await
        .unwrap();
    assert!(!more);
    assert_eq!(last.len(), 2);
}

#[tokio::test]
async fn hostile_metadata_and_bodies_refuse_at_the_metadata_query() {
    let db = Db::connect_memory().await.unwrap();
    credential(&db, "a", "huge", 16 * 1024 * 1024).await;
    assert!(db.backup_credentials_page("a", "").await.is_err());
    sqlx::query("UPDATE connection_credentials SET ciphertext=X'01',token_type=? WHERE connection_id='huge'")
        .bind("x".repeat(16*1024+1)).execute(db.pool()).await.unwrap();
    assert!(db.backup_credentials_page("a", "").await.is_err());
    vault(&db, "a", "v").await;
    revision(&db, "v", "item", 0, 16 * 1024 * 1024).await;
    assert!(db.backup_revisions_page("a", None).await.is_err());
    sqlx::query("UPDATE encrypted_item_revisions SET ciphertext=X'01',wrapping_json=?")
        .bind("x".repeat(16 * 1024 + 1))
        .execute(db.pool())
        .await
        .unwrap();
    assert!(db.backup_revisions_page("a", None).await.is_err());
}
