//! AT-COPIED-KEY: Host item fetch dies at expiry; a copied wrapping key still decrypts.
//!
//! `SessionGrant::permits` is the question `shared_session_fence::authorizing_grant`
//! asks. Expiry is that fence, not a claim that delivered wrapping keys vanish.

use chrono::{Duration, Utc};
use opensesame_domain::{
    GrantLink, GrantScope, NewSessionGrant, PrincipalId, SessionGrant, SessionGrantId, SessionId,
    SessionRole, VaultId, VaultItemId,
};
use opensesame_human_vault::{
    decrypt_item, encrypt_item, AssociatedData, ItemDataKey, ENVELOPE_VERSION,
};

#[test]
fn expiry_denies_fetch_copied_key_still_decrypts() {
    let now = Utc::now();
    let holder = PrincipalId::new();
    let vault_id = VaultId::new();
    let item_id = VaultItemId::new();
    let grant = SessionGrant::new(NewSessionGrant {
        id: SessionGrantId::new(),
        session_id: SessionId::new(),
        subject_principal_id: holder,
        granted_by_principal_id: PrincipalId::new(),
        scope: GrantScope::Collection { vault_id },
        role: SessionRole::Read,
        granted_at: now - Duration::minutes(5),
        expires_at: now + Duration::minutes(5),
        link: GrantLink::LifecycleBound,
    })
    .expect("live grant");

    assert!(
        grant.permits(holder, vault_id, item_id, SessionRole::Read, now),
        "while the grant is live, a Host item fetch is admitted"
    );

    let idk = ItemDataKey::generate();
    let envelope = encrypt_item(
        &idk,
        b"copied-plaintext",
        AssociatedData {
            envelope_version: ENVELOPE_VERSION,
            item_id: item_id.to_string(),
            organization_id: "org:copied".into(),
            project_id: "project:copied".into(),
            collection_id: "col:copied".into(),
            key_id: "idk:copied".into(),
            revision: 1,
        },
    )
    .expect("seal while the grant is live");

    let after = grant.expires_at;
    assert!(
        !grant.permits(holder, vault_id, item_id, SessionRole::Read, after),
        "a Host item fetch after expiry must be denied"
    );
    let plaintext = decrypt_item(&idk, &envelope)
        .expect("a wrapping key copied before expiry still decrypts the old ciphertext");
    assert_eq!(plaintext, b"copied-plaintext");

    let wire = serde_json::to_value(&grant).expect("session grant is product JSON");
    assert!(wire.get("copies_invalidated").is_none());
    assert!(wire.get("plaintext_recalled").is_none());
    assert!(wire.get("ciphertext_erased").is_none());
}
