//! Organizations and emergency contacts moving from vaultwarden (ADR 0148
//! §2): a member keeps the key it held only when its own account came
//! across; otherwise it waits — for re-confirmation if an account at its
//! address is here, as an invitation if none is.
mod common;

use common::client::{Account, PBKDF2};
use common::vaultwarden::{fixture, ORG};
use common::Harness;
use opensesame_bitwarden_server::import::{self, vaultwarden, Source, WriteOptions, Written};
use opensesame_storage::bitwarden::{member_status, BitwardenOrgMember};

async fn source() -> (tempfile::TempDir, Source) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite3");
    fixture(&path).await;
    let source = vaultwarden::read(&path).await.unwrap();
    (dir, source)
}

async fn member(harness: &Harness, email: &str) -> BitwardenOrgMember {
    harness
        .db
        .bitwarden_org_members(ORG)
        .await
        .unwrap()
        .into_iter()
        .find(|m| m.email == email)
        .unwrap()
}

#[tokio::test]
async fn members_keep_their_key_only_with_their_own_account() {
    let (_dir, source) = source().await;
    let target = Harness::start().await;
    // Someone registered here at the invited address before the move.
    Account::register(
        &target.http_url,
        "invited@example.test",
        "pw pw pw pw",
        PBKDF2,
    )
    .await;
    import::write(&target.db, &source, WriteOptions::default())
        .await
        .unwrap();
    import::write_shared(&target.db, &source, WriteOptions::default())
        .await
        .unwrap();

    let owner = member(&target, common::vaultwarden::EMAIL).await;
    assert_eq!(owner.status, member_status::CONFIRMED);
    assert!(owner.key.as_deref().is_some_and(|k| k.starts_with("4.")));
    assert_eq!(owner.user_id.as_deref(), Some(common::vaultwarden::USER));

    let invited = member(&target, "invited@example.test").await;
    assert_eq!(
        invited.status,
        member_status::ACCEPTED,
        "waits to be confirmed again"
    );
    assert_eq!(invited.key, None);
    assert!(invited.user_id.is_some());
}

#[tokio::test]
async fn an_unregistered_member_and_contact_wait_for_their_address() {
    let (_dir, source) = source().await;
    let target = Harness::start().await;
    import::write(&target.db, &source, WriteOptions::default())
        .await
        .unwrap();
    import::write_shared(&target.db, &source, WriteOptions::default())
        .await
        .unwrap();
    let invited = member(&target, "invited@example.test").await;
    assert_eq!(
        (invited.status, invited.user_id),
        (member_status::INVITED, None)
    );
    let contacts = target
        .db
        .bitwarden_emergency_contacts(common::vaultwarden::USER, true)
        .await
        .unwrap();
    assert_eq!(contacts[0].email, "contact@example.test");
    assert_eq!((contacts[0].status, contacts[0].access_type), (0, 1));

    // Both are claimed when the addresses register.
    Account::register(
        &target.http_url,
        "invited@example.test",
        "pw pw pw pw",
        PBKDF2,
    )
    .await;
    Account::register(
        &target.http_url,
        "contact@example.test",
        "pw pw pw pw",
        PBKDF2,
    )
    .await;
    assert_eq!(
        member(&target, "invited@example.test").await.status,
        member_status::ACCEPTED
    );
    let contacts = target
        .db
        .bitwarden_emergency_contacts(common::vaultwarden::USER, true)
        .await
        .unwrap();
    assert_eq!(contacts[0].status, 1);
}

#[tokio::test]
async fn a_second_run_leaves_an_organization_alone_unless_told_to_replace_it() {
    let (_dir, source) = source().await;
    let target = Harness::start().await;
    import::write(&target.db, &source, WriteOptions::default())
        .await
        .unwrap();
    let first = import::write_shared(&target.db, &source, WriteOptions::default())
        .await
        .unwrap();
    assert_eq!(first.organizations[0].written, Written::Created);
    let again = import::write_shared(&target.db, &source, WriteOptions::default())
        .await
        .unwrap();
    assert_eq!(again.organizations[0].written, Written::IdTaken);
    let replace = WriteOptions {
        replace: true,
        dry_run: false,
    };
    let replaced = import::write_shared(&target.db, &source, replace)
        .await
        .unwrap();
    assert_eq!(replaced.organizations[0].written, Written::Replaced);
    assert_eq!(target.db.bitwarden_org_ciphers(ORG).await.unwrap().len(), 1);
    let dry = WriteOptions {
        replace: false,
        dry_run: true,
    };
    let checked = import::write_shared(&target.db, &source, dry)
        .await
        .unwrap();
    assert_eq!(checked.organizations[0].written, Written::DryRun);
}
