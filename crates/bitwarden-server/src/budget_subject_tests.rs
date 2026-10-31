use super::*;
use chrono::Utc;
use opensesame_storage::bitwarden::BitwardenKdf;

pub(crate) fn user(email: &str) -> BitwardenUser {
    let now = Utc::now();
    BitwardenUser {
        id: format!("user-{email}"),
        email: email.into(),
        name: None,
        master_password_hash: String::new(),
        master_password_hint: None,
        kdf: BitwardenKdf {
            kdf_type: 0,
            iterations: 600_000,
            memory: None,
            parallelism: None,
        },
        user_key: "2.a|b|c".into(),
        user_key_id: None,
        public_key: None,
        private_key: None,
        security_stamp: "stamp".into(),
        culture: "en-US".into(),
        created_at: now,
        revision_at: now,
    }
}

#[test]
fn loaded_subjects_preserve_the_deployed_key_formats() {
    let user = user("  Alice@Example.test  ");
    assert_eq!(
        BudgetSubject::Account(&user).key(),
        "account:alice@example.test"
    );
    assert_eq!(
        BudgetSubject::SignInRequest(&user).key(),
        "alice@example.test"
    );
    assert_eq!(
        BudgetSubject::ApiKey(&user).key(),
        format!("api-key:user.{}", user.id)
    );
    let now = Utc::now();
    let request = BitwardenAuthRequest {
        id: "request-id".into(),
        user_id: user.id.clone(),
        device_identifier: "d".into(),
        device_type: 14,
        access_code_digest: "digest".into(),
        public_key: "public".into(),
        key: None,
        master_password_hash: None,
        approved: None,
        response_device: None,
        created_at: now,
        response_at: None,
    };
    assert_eq!(
        BudgetSubject::AuthRequest(&request).key(),
        "auth-request:request-id"
    );
    let send = BitwardenSend {
        id: "send-id".into(),
        user_id: user.id,
        send_type: 0,
        data: "{}".into(),
        key: "2.a|b|c".into(),
        password_hash: None,
        max_access_count: None,
        access_count: 0,
        disabled: false,
        hide_email: false,
        file_id: None,
        file_size: None,
        uploaded: true,
        created_at: now,
        revision_at: now,
        expiration_at: None,
        deletion_at: now,
    };
    assert_eq!(BudgetSubject::Send(&send).key(), "send:send-id");
}
