//! `Debug` for the Bitwarden records that hold key material (ADR 0157).
//!
//! The server stores a hash of each master-password hash, the client-wrapped
//! user and organization keys, an API key, a recovery code and an
//! authenticator's base32 key. `#[derive(Debug)]` would print every one into
//! any `{:?}`, `tracing` field or panic message handed the record, so each
//! impl prints what is metadata and `[REDACTED]` for what is not.

use std::fmt;

use super::accounts::{BitwardenCredentials, BitwardenUser};
use super::auth_requests::BitwardenAuthRequest;
use super::moves::ArrivingSignIn;
use super::orgs::BitwardenOrganization;
use super::second_factors::BitwardenTwoFactor;
use super::sends::BitwardenSend;

const REDACTED: &str = "[REDACTED]";

fn present<T>(value: Option<&T>) -> Option<&'static str> {
    value.map(|_| REDACTED)
}

impl fmt::Debug for BitwardenUser {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BitwardenUser")
            .field("id", &self.id)
            .field("email", &self.email)
            .field("name", &self.name)
            .field("master_password_hash", &REDACTED)
            .field(
                "master_password_hint",
                &present(self.master_password_hint.as_ref()),
            )
            .field("kdf", &self.kdf)
            .field("user_key", &REDACTED)
            .field("user_key_id", &self.user_key_id)
            .field("public_key", &self.public_key)
            .field("private_key", &present(self.private_key.as_ref()))
            .field("security_stamp", &REDACTED)
            .field("culture", &self.culture)
            .field("created_at", &self.created_at)
            .field("revision_at", &self.revision_at)
            .finish()
    }
}

impl fmt::Debug for BitwardenCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BitwardenCredentials")
            .field("master_password_hash", &REDACTED)
            .field("kdf", &self.kdf)
            .field("user_key", &REDACTED)
            .field("security_stamp", &REDACTED)
            .finish()
    }
}

impl fmt::Debug for BitwardenAuthRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BitwardenAuthRequest")
            .field("id", &self.id)
            .field("user_id", &self.user_id)
            .field("device_identifier", &self.device_identifier)
            .field("device_type", &self.device_type)
            .field("access_code_digest", &REDACTED)
            .field("public_key", &self.public_key)
            .field("key", &present(self.key.as_ref()))
            .field(
                "master_password_hash",
                &present(self.master_password_hash.as_ref()),
            )
            .field("approved", &self.approved)
            .field("response_device", &self.response_device)
            .field("created_at", &self.created_at)
            .field("response_at", &self.response_at)
            .finish()
    }
}

impl fmt::Debug for BitwardenSend {
    /// `data` is client-encrypted, but the key and the password hash open it.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BitwardenSend")
            .field("id", &self.id)
            .field("user_id", &self.user_id)
            .field("send_type", &self.send_type)
            .field("data", &REDACTED)
            .field("key", &REDACTED)
            .field("password_hash", &present(self.password_hash.as_ref()))
            .field("max_access_count", &self.max_access_count)
            .field("access_count", &self.access_count)
            .field("disabled", &self.disabled)
            .field("hide_email", &self.hide_email)
            .field("file_id", &self.file_id)
            .field("file_size", &self.file_size)
            .field("uploaded", &self.uploaded)
            .field("created_at", &self.created_at)
            .field("revision_at", &self.revision_at)
            .field("expiration_at", &self.expiration_at)
            .field("deletion_at", &self.deletion_at)
            .finish()
    }
}

impl fmt::Debug for ArrivingSignIn {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ArrivingSignIn")
            .field("api_key", &present(self.api_key.as_ref()))
            .field("recovery_code", &present(self.recovery_code.as_ref()))
            .field("two_factors", &self.two_factors)
            .finish()
    }
}

impl fmt::Debug for BitwardenOrganization {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BitwardenOrganization")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("billing_email", &self.billing_email)
            .field("plan_type", &self.plan_type)
            .field("seats", &self.seats)
            .field("public_key", &self.public_key)
            .field("private_key", &present(self.private_key.as_ref()))
            .field("created_at", &self.created_at)
            .field("revision_at", &self.revision_at)
            .finish()
    }
}

impl fmt::Debug for BitwardenTwoFactor {
    /// `data` is the authenticator's base32 key.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BitwardenTwoFactor")
            .field("provider", &self.provider)
            .field("enabled", &self.enabled)
            .field("data", &REDACTED)
            .field("last_used_step", &self.last_used_step)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::super::accounts::BitwardenKdf;
    use super::*;

    fn assert_redacted(shown: &str, leaked: &[&str]) {
        assert!(shown.contains("[REDACTED]"), "{shown}");
        for secret in leaked {
            assert!(!shown.contains(secret), "{secret} in {shown}");
        }
    }

    fn kdf() -> BitwardenKdf {
        BitwardenKdf {
            kdf_type: 1,
            iterations: 3,
            memory: Some(64),
            parallelism: Some(4),
        }
    }

    #[test]
    fn a_user_prints_no_hash_or_key() {
        let user = BitwardenUser {
            id: "u1".into(),
            email: "a@example.com".into(),
            name: None,
            master_password_hash: "$argon2id$hash-12345".into(),
            master_password_hint: Some("hint-12345".into()),
            kdf: kdf(),
            user_key: "2.userkey-12345".into(),
            user_key_id: None,
            public_key: Some("pub-visible".into()),
            private_key: Some("2.privkey-12345".into()),
            security_stamp: "stamp-12345".into(),
            culture: "en-US".into(),
            created_at: Utc::now(),
            revision_at: Utc::now(),
        };
        let shown = format!("{user:?}");
        assert_redacted(
            &shown,
            &[
                "hash-12345",
                "hint-12345",
                "userkey-12345",
                "privkey-12345",
                "stamp-12345",
            ],
        );
        assert!(
            shown.contains("a@example.com") && shown.contains("pub-visible"),
            "{shown}"
        );
    }

    #[test]
    fn credentials_print_no_hash_or_key() {
        let credentials = BitwardenCredentials {
            master_password_hash: "$argon2id$hash-12345".into(),
            kdf: kdf(),
            user_key: "2.userkey-12345".into(),
            security_stamp: "stamp-12345".into(),
        };
        assert_redacted(
            &format!("{credentials:?}"),
            &["hash-12345", "userkey-12345", "stamp-12345"],
        );
    }

    #[test]
    fn an_auth_request_prints_no_key_or_hash() {
        let request = BitwardenAuthRequest {
            id: "r1".into(),
            user_id: "u1".into(),
            device_identifier: "dev".into(),
            device_type: 9,
            access_code_digest: "digest-12345".into(),
            public_key: "pub-visible".into(),
            key: Some("2.wrapped-12345".into()),
            master_password_hash: Some("hash-12345".into()),
            approved: None,
            response_device: None,
            created_at: Utc::now(),
            response_at: None,
        };
        assert_redacted(
            &format!("{request:?}"),
            &["digest-12345", "wrapped-12345", "hash-12345"],
        );
    }

    #[test]
    fn a_send_prints_no_key_data_or_hash() {
        let send = BitwardenSend {
            id: "s1".into(),
            user_id: "u1".into(),
            send_type: 0,
            data: "2.data-12345".into(),
            key: "2.sendkey-12345".into(),
            password_hash: Some("hash-12345".into()),
            max_access_count: None,
            access_count: 0,
            disabled: false,
            hide_email: false,
            file_id: None,
            file_size: None,
            uploaded: false,
            created_at: Utc::now(),
            revision_at: Utc::now(),
            expiration_at: None,
            deletion_at: Utc::now(),
        };
        assert_redacted(
            &format!("{send:?}"),
            &["data-12345", "sendkey-12345", "hash-12345"],
        );
    }

    #[test]
    fn an_arriving_sign_in_prints_no_api_key_recovery_code_or_totp_key() {
        let sign_in = ArrivingSignIn {
            api_key: Some("apikey-12345".into()),
            recovery_code: Some("recovery-12345".into()),
            two_factors: vec![BitwardenTwoFactor {
                provider: 0,
                enabled: true,
                data: "BASE32SEED12345".into(),
                last_used_step: 0,
            }],
        };
        assert_redacted(
            &format!("{sign_in:?}"),
            &["apikey-12345", "recovery-12345", "BASE32SEED12345"],
        );
    }

    #[test]
    fn an_organization_prints_no_private_key() {
        let org = BitwardenOrganization {
            id: "o1".into(),
            name: "Org".into(),
            billing_email: "b@example.com".into(),
            plan_type: 0,
            seats: None,
            public_key: Some("pub-visible".into()),
            private_key: Some("2.orgpriv-12345".into()),
            created_at: Utc::now(),
            revision_at: Utc::now(),
        };
        let shown = format!("{org:?}");
        assert_redacted(&shown, &["orgpriv-12345"]);
        assert!(shown.contains("pub-visible"), "{shown}");
    }
}
