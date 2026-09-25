//! Access, refresh and registration tokens.
//!
//! Bitwarden clients decode the access token themselves (user id from `sub`,
//! `email`, `premium`, `exp`), so it is a JWT with Bitwarden's claim names.
//! It is HS256-signed with a key that never leaves the process. Refresh tokens
//! are opaque random strings the database holds only as SHA-256 digests.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use chrono::Utc;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use opensesame_storage::bitwarden::BitwardenUser;
use rand::RngCore as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::error::{ApiError, ApiResult};

const REGISTRATION_AUDIENCE: &str = "opensesame.bitwarden.register";
const REGISTRATION_TTL_SECONDS: i64 = 15 * 60;

/// The claims Bitwarden's identity server puts in an access token.
#[derive(Debug, Serialize, Deserialize)]
pub struct AccessClaims {
    pub nbf: i64,
    pub exp: i64,
    pub iat: i64,
    pub iss: String,
    pub sub: String,
    pub premium: bool,
    pub name: String,
    pub email: String,
    pub email_verified: bool,
    pub sstamp: String,
    pub device: String,
    pub client_id: String,
    pub scope: Vec<String>,
    pub amr: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct RegistrationClaims {
    sub: String,
    aud: String,
    iss: String,
    exp: i64,
}

/// Signing keys and lifetimes for every token the server mints.
pub struct TokenKeys {
    encoding: EncodingKey,
    decoding: DecodingKey,
    issuer: String,
    access_ttl_seconds: i64,
}

impl TokenKeys {
    /// Keys from `secret`, or from 32 fresh random bytes when none is given —
    /// in which case every access token dies with the process and clients
    /// quietly refresh.
    #[must_use]
    pub fn new(secret: Option<&[u8]>, issuer: &str, access_ttl_seconds: i64) -> Self {
        let mut generated = Zeroizing::new([0u8; 32]);
        let secret = secret.unwrap_or_else(|| {
            rand::rngs::OsRng.fill_bytes(generated.as_mut());
            generated.as_ref()
        });
        Self {
            encoding: EncodingKey::from_secret(secret),
            decoding: DecodingKey::from_secret(secret),
            issuer: issuer.to_owned(),
            access_ttl_seconds,
        }
    }

    #[must_use]
    pub fn access_ttl_seconds(&self) -> i64 {
        self.access_ttl_seconds
    }

    /// Mint an access token for `user` on `device_id`.
    ///
    /// # Errors
    ///
    /// Returns a 500 [`ApiError`] when signing fails.
    pub fn mint_access(
        &self,
        user: &BitwardenUser,
        device_id: &str,
        client_id: &str,
    ) -> ApiResult<String> {
        let now = Utc::now().timestamp();
        let claims = AccessClaims {
            nbf: now,
            exp: now + self.access_ttl_seconds,
            iat: now,
            iss: self.issuer.clone(),
            sub: user.id.clone(),
            premium: true,
            name: user.name.clone().unwrap_or_default(),
            email: user.email.clone(),
            email_verified: true,
            sstamp: user.security_stamp.clone(),
            device: device_id.to_owned(),
            client_id: client_id.to_owned(),
            scope: vec!["api".into(), "offline_access".into()],
            amr: vec!["Application".into()],
        };
        jsonwebtoken::encode(&Header::new(Algorithm::HS256), &claims, &self.encoding)
            .map_err(|e| ApiError::internal(&e.into()))
    }

    /// Verify signature, issuer and expiry. Says nothing about whether the
    /// security stamp is still current — the caller checks that.
    #[must_use]
    pub fn verify_access(&self, token: &str) -> Option<AccessClaims> {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.set_issuer(&[&self.issuer]);
        validation.leeway = 0;
        jsonwebtoken::decode::<AccessClaims>(token, &self.decoding, &validation)
            .ok()
            .map(|data| data.claims)
    }

    /// The token `register/send-verification-email` hands back when the
    /// server sends no mail, binding the finish step to one email.
    ///
    /// # Errors
    ///
    /// Returns a 500 [`ApiError`] when signing fails.
    pub fn mint_registration(&self, email: &str) -> ApiResult<String> {
        let claims = RegistrationClaims {
            sub: email.to_owned(),
            aud: REGISTRATION_AUDIENCE.into(),
            iss: self.issuer.clone(),
            exp: Utc::now().timestamp() + REGISTRATION_TTL_SECONDS,
        };
        jsonwebtoken::encode(&Header::new(Algorithm::HS256), &claims, &self.encoding)
            .map_err(|e| ApiError::internal(&e.into()))
    }

    /// Whether `token` is a live registration token for exactly `email`.
    #[must_use]
    pub fn verify_registration(&self, token: &str, email: &str) -> bool {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.set_issuer(&[&self.issuer]);
        validation.set_audience(&[REGISTRATION_AUDIENCE]);
        jsonwebtoken::decode::<RegistrationClaims>(token, &self.decoding, &validation)
            .is_ok_and(|data| data.claims.sub == email)
    }
}

/// A fresh opaque refresh token.
#[must_use]
pub fn new_refresh_token() -> String {
    let mut bytes = Zeroizing::new([0u8; 64]);
    rand::rngs::OsRng.fill_bytes(bytes.as_mut());
    URL_SAFE_NO_PAD.encode(bytes.as_ref())
}

/// What the database stores in place of a refresh token.
#[must_use]
pub fn refresh_token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// A fresh security stamp.
#[must_use]
pub fn new_security_stamp() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kdf::KdfConfig;

    fn user() -> BitwardenUser {
        let now = Utc::now();
        BitwardenUser {
            id: "7a3c".into(),
            email: "a@example.com".into(),
            name: None,
            master_password_hash: String::new(),
            master_password_hint: None,
            kdf: KdfConfig::ARGON2ID_DEFAULT.to_stored(),
            user_key: String::new(),
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
    fn access_tokens_carry_bitwarden_claims_and_only_verify_here() {
        let keys = TokenKeys::new(Some(b"k".repeat(32).as_slice()), "https://h/identity", 3600);
        let token = keys.mint_access(&user(), "dev-1", "cli").unwrap();
        let claims = keys.verify_access(&token).unwrap();
        assert_eq!(
            (
                claims.sub.as_str(),
                claims.email.as_str(),
                claims.sstamp.as_str()
            ),
            ("7a3c", "a@example.com", "stamp")
        );
        assert_eq!(claims.device, "dev-1");
        let other = TokenKeys::new(None, "https://h/identity", 3600);
        assert!(other.verify_access(&token).is_none());
        let expired = TokenKeys::new(Some(b"k".repeat(32).as_slice()), "https://h/identity", -10);
        assert!(keys
            .verify_access(&expired.mint_access(&user(), "d", "cli").unwrap())
            .is_none());
    }

    #[test]
    fn registration_and_access_tokens_are_not_interchangeable() {
        let keys = TokenKeys::new(None, "iss", 3600);
        let registration = keys.mint_registration("a@example.com").unwrap();
        assert!(keys.verify_registration(&registration, "a@example.com"));
        assert!(!keys.verify_registration(&registration, "b@example.com"));
        assert!(keys.verify_access(&registration).is_none());
        let access = keys.mint_access(&user(), "d", "cli").unwrap();
        assert!(!keys.verify_registration(&access, "a@example.com"));
    }

    #[test]
    fn refresh_tokens_are_random_and_stored_as_digests() {
        let token = new_refresh_token();
        assert_ne!(token, new_refresh_token());
        assert_eq!(refresh_token_hash(&token).len(), 64);
        assert_ne!(refresh_token_hash(&token), token);
    }
}
