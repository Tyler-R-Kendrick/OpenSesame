//! Signed `authorization_response` and the user JWT inside an allow.
//!
//! Config mode (what the live test exercises): the response is signed by the
//! `auth_callout.issuer` account key, `aud` is the server id, `sub` is the
//! one-time user nkey, and the user JWT's `aud` is the *name* of the target
//! account. Operator mode uses the account's public key as that audience and
//! is not claimed here.

use opensesame_authz::CalloutPermissions;
use serde::{Deserialize, Serialize};

use crate::error::{misconfigured, CalloutError};
use crate::jwt::{encode, jti_for};
use crate::model::{CLAIMS_VERSION, RESPONSE_TYPE, USER_TYPE};

/// Longest a response or user JWT may be valid for, whatever is configured.
pub const MAX_EXP_SECS: i64 = 15 * 60;
/// Default validity when none is configured.
pub const DEFAULT_EXP_SECS: i64 = 5 * 60;

#[derive(Serialize, Deserialize)]
struct AllowList {
    allow: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct UserNats {
    #[serde(rename = "pub")]
    publish: AllowList,
    #[serde(rename = "sub")]
    subscribe: AllowList,
    subs: i64,
    data: i64,
    payload: i64,
    #[serde(rename = "type")]
    kind: String,
    version: u32,
}

/// The user JWT claims (jwt v2 `UserClaims`, the subset we issue).
#[derive(Serialize, Deserialize)]
pub struct UserClaims {
    pub jti: String,
    pub iat: i64,
    pub exp: i64,
    pub iss: String,
    pub sub: String,
    pub aud: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    nats: UserNats,
}

impl UserClaims {
    /// Publish allow list.
    #[must_use]
    pub fn publish_allow(&self) -> &[String] {
        &self.nats.publish.allow
    }
    /// Subscribe allow list.
    #[must_use]
    pub fn subscribe_allow(&self) -> &[String] {
        &self.nats.subscribe.allow
    }
}

#[derive(Serialize, Deserialize)]
struct ResponseNats {
    #[serde(skip_serializing_if = "Option::is_none")]
    jwt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(rename = "type")]
    kind: String,
    version: u32,
}

/// The response claims (jwt v2 `AuthorizationResponseClaims`).
#[derive(Serialize, Deserialize)]
pub struct ResponseClaims {
    pub jti: String,
    pub iat: i64,
    pub exp: i64,
    pub iss: String,
    pub sub: String,
    pub aud: String,
    nats: ResponseNats,
}

impl ResponseClaims {
    /// The user JWT of an allow.
    #[must_use]
    pub fn user_jwt(&self) -> Option<&str> {
        self.nats.jwt.as_deref()
    }
    /// The error of a deny.
    #[must_use]
    pub fn error(&self) -> Option<&str> {
        self.nats.error.as_deref()
    }
}

/// What an allow grants.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UserGrant {
    pub user_nkey: String,
    /// Config mode: the target account's name.
    pub target_account: String,
    pub permissions: CalloutPermissions,
    /// Absolute unix expiry of the user JWT; clamped to `MAX_EXP_SECS`.
    pub expires_at: i64,
    pub name: Option<String>,
}

/// Signs responses with the callout account's seed.
pub struct ResponseSigner {
    account: nkeys::KeyPair,
    max_exp_secs: i64,
}

impl std::fmt::Debug for ResponseSigner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResponseSigner")
            .field("account", &self.account.public_key())
            .field("max_exp_secs", &self.max_exp_secs)
            .finish()
    }
}

impl ResponseSigner {
    /// From an account seed (`SA…`). The seed is not retained beyond the key
    /// pair, and the key pair never prints it.
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` for a seed that is not an account seed, or a
    /// `max_exp_secs` outside `1..=MAX_EXP_SECS`.
    pub fn from_seed(seed: &str, max_exp_secs: i64) -> Result<Self, CalloutError> {
        let account = nkeys::KeyPair::from_seed(seed.trim())
            .map_err(|_| misconfigured("callout signing seed is not an nkey seed"))?;
        if account.key_pair_type() != nkeys::KeyPairType::Account {
            return Err(misconfigured("callout signing seed must be an account seed"));
        }
        if !(1..=MAX_EXP_SECS).contains(&max_exp_secs) {
            return Err(misconfigured(format!(
                "callout max expiry must be within 1..={MAX_EXP_SECS} seconds"
            )));
        }
        Ok(Self {
            account,
            max_exp_secs,
        })
    }

    /// The account public key (`A…`): the `iss` of every response and the
    /// `aud` every request must carry in config mode.
    #[must_use]
    pub fn account_public_key(&self) -> String {
        self.account.public_key()
    }

    /// Configured maximum validity.
    #[must_use]
    pub fn max_exp_secs(&self) -> i64 {
        self.max_exp_secs
    }

    fn sign<T: Serialize>(&self, mut claims: T, set_jti: impl Fn(&mut T, String)) -> Result<String, CalloutError> {
        set_jti(&mut claims, String::new());
        let bytes = serde_json::to_vec(&claims).map_err(|_| CalloutError::SigningFailed)?;
        set_jti(&mut claims, jti_for(&bytes));
        encode(&claims, &self.account)
    }

    fn response(&self, server_id: &str, user_nkey: &str, now: i64, nats: ResponseNats) -> Result<String, CalloutError> {
        let claims = ResponseClaims {
            jti: String::new(),
            iat: now,
            exp: now + self.max_exp_secs,
            iss: self.account_public_key(),
            sub: user_nkey.to_owned(),
            aud: server_id.to_owned(),
            nats,
        };
        self.sign(claims, |c, jti| c.jti = jti)
    }

    /// A signed allow: a user JWT for `grant` wrapped in a response to
    /// `server_id`.
    ///
    /// # Errors
    ///
    /// `SigningFailed`.
    pub fn allow(&self, server_id: &str, grant: &UserGrant, now: i64) -> Result<String, CalloutError> {
        let exp = grant.expires_at.min(now + self.max_exp_secs);
        if exp <= now {
            return Err(CalloutError::SigningFailed);
        }
        let user = UserClaims {
            jti: String::new(),
            iat: now,
            exp,
            iss: self.account_public_key(),
            sub: grant.user_nkey.clone(),
            aud: grant.target_account.clone(),
            name: grant.name.clone(),
            nats: UserNats {
                publish: AllowList {
                    allow: grant.permissions.publish.clone(),
                },
                subscribe: AllowList {
                    allow: grant.permissions.subscribe.clone(),
                },
                subs: -1,
                data: -1,
                payload: -1,
                kind: USER_TYPE.into(),
                version: CLAIMS_VERSION,
            },
        };
        let user_jwt = self.sign(user, |c, jti| c.jti = jti)?;
        self.response(
            server_id,
            &grant.user_nkey,
            now,
            ResponseNats {
                jwt: Some(user_jwt),
                error: None,
                kind: RESPONSE_TYPE.into(),
                version: CLAIMS_VERSION,
            },
        )
    }

    /// A signed deny carrying a stable, non-secret code.
    ///
    /// # Errors
    ///
    /// `SigningFailed`.
    pub fn deny(&self, server_id: &str, user_nkey: &str, code: &str, now: i64) -> Result<String, CalloutError> {
        self.response(
            server_id,
            user_nkey,
            now,
            ResponseNats {
                jwt: None,
                error: Some(code.to_owned()),
                kind: RESPONSE_TYPE.into(),
                version: CLAIMS_VERSION,
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jwt::peek_claims;

    fn signer() -> ResponseSigner {
        let seed = nkeys::KeyPair::new_account().seed().unwrap();
        ResponseSigner::from_seed(&seed, 300).unwrap()
    }

    #[test]
    fn allow_binds_server_user_account_and_permissions() {
        let s = signer();
        let user = nkeys::KeyPair::new_user().public_key();
        let grant = UserGrant {
            user_nkey: user.clone(),
            target_account: "APP".into(),
            permissions: CalloutPermissions {
                publish: vec!["opensesame.callout.principal.p1.>".into()],
                subscribe: vec!["_INBOX.>".into()],
            },
            expires_at: 1_000_000,
            name: Some("p1".into()),
        };
        let token = s.allow("NSERVER", &grant, 100).unwrap();
        let resp: ResponseClaims = peek_claims(&token).unwrap();
        assert_eq!(resp.aud, "NSERVER");
        assert_eq!(resp.sub, user);
        assert_eq!(resp.iss, s.account_public_key());
        assert_eq!(resp.exp, 400);
        assert!(resp.error().is_none());
        let u: UserClaims = peek_claims(resp.user_jwt().unwrap()).unwrap();
        assert_eq!(u.aud, "APP");
        assert_eq!(u.sub, user);
        assert_eq!(u.exp, 400, "clamped to the configured maximum");
        assert_eq!(u.publish_allow(), ["opensesame.callout.principal.p1.>"]);
        assert_eq!(u.subscribe_allow(), ["_INBOX.>"]);
        // The user JWT verifies under the account key.
        let sig_input = resp.user_jwt().unwrap().rsplit_once('.').unwrap();
        let sig = base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, sig_input.1).unwrap();
        nkeys::KeyPair::from_public_key(&s.account_public_key())
            .unwrap()
            .verify(sig_input.0.as_bytes(), &sig)
            .unwrap();
    }

    #[test]
    fn deny_carries_only_the_code() {
        let s = signer();
        let token = s.deny("NSERVER", "UUSER", "host_unreachable", 100).unwrap();
        let resp: ResponseClaims = peek_claims(&token).unwrap();
        assert_eq!(resp.error(), Some("host_unreachable"));
        assert!(resp.user_jwt().is_none());
        assert!(!token.contains("secret"));
    }

    #[test]
    fn seed_kind_and_expiry_bounds_are_enforced() {
        let user_seed = nkeys::KeyPair::new_user().seed().unwrap();
        assert!(ResponseSigner::from_seed(&user_seed, 300).is_err());
        let acct = nkeys::KeyPair::new_account().seed().unwrap();
        assert!(ResponseSigner::from_seed(&acct, 0).is_err());
        assert!(ResponseSigner::from_seed(&acct, MAX_EXP_SECS + 1).is_err());
        assert!(ResponseSigner::from_seed("not a seed", 300).is_err());
        let s = ResponseSigner::from_seed(&acct, 300).unwrap();
        assert!(!format!("{s:?}").contains(&acct));
        let grant = UserGrant {
            user_nkey: "U".into(),
            target_account: "APP".into(),
            permissions: CalloutPermissions { publish: vec![], subscribe: vec![] },
            expires_at: 50,
            name: None,
        };
        assert_eq!(s.allow("N", &grant, 100).unwrap_err(), CalloutError::SigningFailed);
    }
}
