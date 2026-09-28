//! Reading one person's account from a live Bitwarden server (ADR 0148 §2):
//! bitwarden.com, bitwarden.eu, a self-hosted Bitwarden server, or a
//! vaultwarden whose database is out of reach.
//!
//! The person's master password is used where they type it, as any
//! Bitwarden client uses it: the account's own KDF derives the master key,
//! and only the login hash leaves the machine, to the old server. The master
//! key opens the wrapped user key once, to prove the password is the one the
//! vault was sealed with; nothing in the vault is decrypted. The Host keeps a
//! hash of the same login hash, so the same password opens the same vault.

use chrono::{DateTime, Utc};
use opensesame_provider_bitwarden::{
    Client, DeviceIdentity, EncString, Endpoints, Error, Kdf, MasterKey,
};
use opensesame_storage::bitwarden::{
    ArrivingSignIn, BitwardenArrival, BitwardenKdf, BitwardenTwoFactor, BitwardenUser,
};
use serde_json::Value;
use zeroize::Zeroizing;

use super::{cipher, folder, keep_known_folders, leave, Arrival, CipherDates, LeftBehind, Source};
use crate::hashing::HashRegistry;
use crate::second_factor::{is_authenticator_key, normalize_key, AUTHENTICATOR};

/// A question the old server asks before it lets the importer in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Challenge {
    /// Two-step login: one of these provider numbers (0 authenticator app,
    /// 1 email, 3 `YubiKey` OTP, …).
    TwoFactor { providers: Vec<u32> },
    /// A code the server mailed to the account for this new device.
    NewDevice,
}

/// A person's answer: which provider they used (for [`Challenge::TwoFactor`])
/// and the code.
#[derive(Clone, Debug)]
pub struct Answer {
    pub provider: Option<u32>,
    pub code: Zeroizing<String>,
}

/// Asks the person; `None` gives up.
pub trait Ask {
    fn ask(&mut self, challenge: &Challenge) -> Option<Answer>;
}

/// Where to read from, and whose account.
pub struct AccountRequest<'a> {
    pub server_url: &'a str,
    pub email: &'a str,
    pub master_password: &'a [u8],
}

const MAX_CHALLENGES: usize = 3;

fn member<'v>(value: &'v Value, key: &str) -> Option<&'v Value> {
    let mut chars = key.chars();
    let upper = chars
        .next()
        .map(|c| c.to_ascii_uppercase().to_string() + chars.as_str())
        .unwrap_or_default();
    value
        .get(key)
        .or_else(|| value.get(upper))
        .filter(|v| !v.is_null())
}

fn text(value: &Value, key: &str) -> Option<String> {
    member(value, key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn date(value: &Value, key: &str) -> Option<DateTime<Utc>> {
    text(value, key)
        .and_then(|raw| DateTime::parse_from_rfc3339(&raw).ok())
        .map(|at| at.with_timezone(&Utc))
}

async fn sign_in(
    api: &Client,
    email: &str,
    hash: &str,
    ask: &mut dyn Ask,
) -> anyhow::Result<String> {
    let mut answer: Vec<(&'static str, String)> = Vec::new();
    for _ in 0..=MAX_CHALLENGES {
        let form: Vec<(&str, &str)> = answer.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let challenge = match api.login_password_answering(email, hash, &form).await {
            Ok(token) => return Ok(token.access_token),
            Err(Error::TwoFactorRequired { providers }) => Challenge::TwoFactor { providers },
            Err(Error::NewDeviceVerification) => Challenge::NewDevice,
            Err(other) => return Err(other.into()),
        };
        let reply = ask
            .ask(&challenge)
            .ok_or_else(|| anyhow::anyhow!("the old server's challenge was not answered"))?;
        let given: Vec<(&'static str, String)> = match challenge {
            Challenge::TwoFactor { providers } => {
                let provider = reply
                    .provider
                    .or_else(|| providers.first().copied())
                    .unwrap_or(0);
                vec![
                    ("twoFactorToken", reply.code.to_string()),
                    ("twoFactorProvider", provider.to_string()),
                    ("twoFactorRemember", "0".to_owned()),
                ]
            }
            Challenge::NewDevice => vec![("newdeviceotp", reply.code.to_string())],
        };
        // Earlier answers still stand: a server may ask one thing, then another.
        answer.retain(|(key, _)| given.iter().all(|(k, _)| k != key));
        answer.extend(given);
    }
    anyhow::bail!("the old server kept asking for a second factor; giving up")
}

/// The account's `KDF` as the old server reports it, and as the client runs it.
async fn kdf_of(api: &Client, email: &str) -> anyhow::Result<(BitwardenKdf, Kdf)> {
    let prelogin = api.prelogin(email).await?;
    let kdf = Kdf::from_prelogin(
        prelogin.kdf,
        prelogin.kdf_iterations,
        prelogin.kdf_memory,
        prelogin.kdf_parallelism,
    )?;
    let stored = BitwardenKdf {
        kdf_type: i64::from(prelogin.kdf),
        iterations: i64::from(prelogin.kdf_iterations),
        memory: prelogin.kdf_memory.map(i64::from),
        parallelism: prelogin.kdf_parallelism.map(i64::from),
    };
    Ok((stored, kdf))
}

fn count_left_behind(sync: &Value, left: &mut LeftBehind) {
    let array = |key: &str| member(sync, key).and_then(Value::as_array);
    let ciphers = array("ciphers").map_or(&[][..], Vec::as_slice);
    let profile = member(sync, "profile");
    leave(
        left,
        "organization memberships",
        profile
            .and_then(|p| member(p, "organizations"))
            .and_then(Value::as_array)
            .map_or(0, Vec::len),
    );
    leave(
        left,
        "organization items",
        ciphers
            .iter()
            .filter(|c| text(c, "organizationId").is_some())
            .count(),
    );
}

fn vault_of(user: &BitwardenUser, sync: &Value, left: &mut LeftBehind) -> BitwardenArrival {
    let array = |key: &str| {
        member(sync, key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let mut folders = Vec::new();
    for raw in array("folders") {
        let revised = date(&raw, "revisionDate").unwrap_or(user.created_at);
        match (text(&raw, "id"), text(&raw, "name")) {
            (Some(id), Some(name)) => match folder(&user.id, &id, &name, revised, revised) {
                Some(folder) => folders.push(folder),
                None => leave(left, "unreadable folders", 1),
            },
            _ => leave(left, "unreadable folders", 1),
        }
    }
    let mut ciphers = Vec::new();
    for raw in array("ciphers") {
        if text(&raw, "organizationId").is_some() {
            continue;
        }
        let Some(id) = text(&raw, "id") else {
            leave(left, "unreadable items", 1);
            continue;
        };
        let created = date(&raw, "creationDate").unwrap_or(user.created_at);
        let dates = CipherDates {
            created,
            revised: date(&raw, "revisionDate").unwrap_or(created),
            deleted: date(&raw, "deletedDate"),
            archived: date(&raw, "archivedDate"),
        };
        match cipher(&user.id, &id, raw, dates) {
            Some(cipher) => ciphers.push(cipher),
            None => leave(left, "unreadable items", 1),
        }
    }
    let mut account = BitwardenArrival {
        user: user.clone(),
        folders,
        ciphers,
        sign_in: ArrivingSignIn::default(),
    };
    keep_known_folders(&mut account);
    account
}

/// The account's API key and, if two-step login is on, its authenticator and
/// recovery code: what the web vault shows the person after they re-enter
/// their master password, read the same way. Providers that cannot move are
/// counted.
async fn sign_in_methods(
    api: &Client,
    token: &str,
    login_hash: &str,
    two_factor_on: bool,
    left: &mut LeftBehind,
) -> ArrivingSignIn {
    let proof = serde_json::json!({ "masterPasswordHash": login_hash });
    let read = |path: &'static str| api.post_json(path, token, &proof);
    let mut sign_in = ArrivingSignIn {
        api_key: read("/accounts/api-key")
            .await
            .ok()
            .and_then(|body| text(&body, "apiKey")),
        ..ArrivingSignIn::default()
    };
    if !two_factor_on {
        return sign_in;
    }
    let providers: Vec<i64> = read("/two-factor")
        .await
        .ok()
        .and_then(|body| member(&body, "data").and_then(Value::as_array).cloned())
        .unwrap_or_default()
        .iter()
        .filter(|p| member(p, "enabled").and_then(Value::as_bool) == Some(true))
        .filter_map(|p| member(p, "type").and_then(Value::as_i64))
        .collect();
    let key = if providers.contains(&AUTHENTICATOR) {
        read("/two-factor/get-authenticator")
            .await
            .ok()
            .and_then(|body| text(&body, "key"))
            .map(|key| normalize_key(&key))
            .filter(|key| is_authenticator_key(key))
    } else {
        None
    };
    leave(
        left,
        "two-step login methods",
        providers.len() - usize::from(key.is_some()),
    );
    if let Some(key) = key {
        sign_in.two_factors.push(BitwardenTwoFactor {
            provider: AUTHENTICATOR,
            enabled: true,
            data: key,
            // The code the person just typed for the old server stays spent.
            last_used_step: Utc::now().timestamp().div_euclid(30),
        });
        sign_in.recovery_code = read("/two-factor/get-recover")
            .await
            .ok()
            .and_then(|body| text(&body, "code"))
            .map(|code| normalize_key(&code));
    }
    sign_in
}

/// Sign in to the old server as the person and read their account.
///
/// # Errors
///
/// Returns an error when the server cannot be reached, refuses the sign-in,
/// asks a question nobody answers, or holds a key the password does not open.
pub async fn read(
    request: &AccountRequest<'_>,
    hashes: &HashRegistry,
    ask: &mut dyn Ask,
) -> anyhow::Result<Source> {
    let email = opensesame_provider_bitwarden::normalize_email(request.email);
    let device = DeviceIdentity::new(format!("opensesame-import-{}", uuid::Uuid::new_v4()));
    let api = Client::new(Endpoints::from_server_url(request.server_url)?, device)?;
    let (stored_kdf, kdf) = kdf_of(&api, &email).await?;
    let master_key = MasterKey::derive(request.master_password, &email, &kdf)?;
    let login_hash = Zeroizing::new(master_key.password_hash_b64(request.master_password));
    let token = Zeroizing::new(sign_in(&api, &email, &login_hash, ask).await?);

    let sync = api.get_json("/sync?excludeDomains=true", &token).await?;
    let profile = member(&sync, "profile")
        .ok_or_else(|| anyhow::anyhow!("the old server's sync carried no profile"))?;
    let id = text(profile, "id").ok_or_else(|| anyhow::anyhow!("the profile has no id"))?;
    let user_key =
        text(profile, "key").ok_or_else(|| anyhow::anyhow!("the profile carries no user key"))?;
    // Prove the password opens this key before anything is written with it.
    master_key
        .decrypt_user_key(&user_key.parse::<EncString>()?)
        .map_err(|e| {
            anyhow::anyhow!("the master password does not open this account's key: {e}")
        })?;
    let public_key = api
        .get_json(&format!("/users/{id}/public-key"), &token)
        .await
        .ok()
        .and_then(|keys| text(&keys, "publicKey"));

    let now = Utc::now();
    let user = BitwardenUser {
        id,
        email,
        name: text(profile, "name"),
        master_password_hash: hashes.hash(login_hash.as_bytes())?,
        master_password_hint: None,
        kdf: stored_kdf,
        user_key,
        user_key_id: None,
        public_key,
        private_key: text(profile, "privateKey"),
        security_stamp: uuid::Uuid::new_v4().to_string(),
        culture: text(profile, "culture").unwrap_or_else(|| "en-US".to_owned()),
        created_at: date(profile, "creationDate").unwrap_or(now),
        revision_at: now,
    };
    let mut left = LeftBehind::new();
    count_left_behind(&sync, &mut left);
    let two_factor_on = member(profile, "twoFactorEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let sign_in = sign_in_methods(&api, &token, &login_hash, two_factor_on, &mut left).await;
    let mut account = vault_of(&user, &sync, &mut left);
    account.sign_in = sign_in;
    let scratch = tempfile::tempdir()?;
    let attachments =
        super::account_files::attachments(&api, &token, &sync, &user, scratch.path(), &mut left)
            .await;
    let sends = super::account_files::sends(&sync, &user, &mut left);
    Ok(Source {
        arrivals: vec![Arrival {
            account,
            left_behind: left,
            attachments,
            sends,
        }],
        scratch: Some(std::sync::Arc::new(scratch)),
        ..Source::default()
    })
}
