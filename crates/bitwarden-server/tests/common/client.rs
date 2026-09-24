//! The client half of Bitwarden's protocol that `bw` does not expose:
//! registration and a KDF change, done the way the web vault does them, with
//! the key schedule from `opensesame-provider-bitwarden`.

use aws_lc_rs::encoding::{AsDer, Pkcs8V1Der, PublicKeyX509Der};
use aws_lc_rs::rsa::{KeyPair, KeySize};
use aws_lc_rs::signature::KeyPair as _;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use opensesame_provider_bitwarden::{Kdf, MasterKey, SymmetricKey};
use rand::RngCore as _;
use serde_json::{json, Value};
use zeroize::Zeroizing;

/// Bitwarden's recommended Argon2id: 64 MiB, three passes, four lanes.
pub const ARGON2ID: Kdf = Kdf::Argon2id {
    iterations: 3,
    memory_kib: 64 * 1024,
    parallelism: 4,
};

pub const PBKDF2: Kdf = Kdf::Pbkdf2 {
    iterations: 600_000,
};

pub struct Account {
    pub email: String,
    pub password: String,
    pub kdf: Kdf,
    user_key: Zeroizing<Vec<u8>>,
}

pub fn http() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}

/// `{kdfType, iterations, memory (MiB), parallelism}`.
pub fn kdf_json(kdf: &Kdf) -> Value {
    match *kdf {
        Kdf::Pbkdf2 { iterations } => {
            json!({"kdfType": 0, "iterations": iterations, "memory": null, "parallelism": null})
        }
        Kdf::Argon2id {
            iterations,
            memory_kib,
            parallelism,
        } => json!({"kdfType": 1, "iterations": iterations,
                    "memory": memory_kib / 1024, "parallelism": parallelism}),
    }
}

/// Master key → (hash the server checks, user key wrapped under the stretched
/// master key).
fn wrap(password: &str, email: &str, kdf: &Kdf, user_key: &[u8]) -> (String, String) {
    let master = MasterKey::derive(password.as_bytes(), email, kdf).unwrap();
    let hash = master.password_hash_b64(password.as_bytes());
    let wrapped = encrypt(&master.stretch(), user_key);
    (hash, wrapped)
}

pub fn encrypt(key: &SymmetricKey, plaintext: &[u8]) -> String {
    let mut iv = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut iv);
    key.encrypt_with_iv(plaintext, iv).unwrap().to_string()
}

impl Account {
    pub fn user_key(&self) -> SymmetricKey {
        SymmetricKey::from_bytes(&self.user_key).unwrap()
    }

    pub fn password_hash(&self) -> String {
        MasterKey::derive(self.password.as_bytes(), &self.email, &self.kdf)
            .unwrap()
            .password_hash_b64(self.password.as_bytes())
    }

    /// Register through `send-verification-email` → `register/finish`, in the
    /// current (authentication + unlock) body shape, with a real RSA-2048 pair.
    /// `email` is sent as typed; the salt, as every client computes it, is
    /// the trimmed lower-case form.
    pub async fn register(base: &str, typed_email: &str, password: &str, kdf: Kdf) -> Self {
        let email = typed_email.trim().to_ascii_lowercase();
        let email = email.as_str();
        let mut user_key = Zeroizing::new(vec![0u8; 64]);
        rand::rngs::OsRng.fill_bytes(&mut user_key);
        let (hash, wrapped) = wrap(password, email, &kdf, &user_key);
        let pair = KeyPair::generate(KeySize::Rsa2048).unwrap();
        let private: Pkcs8V1Der = pair.as_der().unwrap();
        let public: PublicKeyX509Der = pair.public_key().as_der().unwrap();
        let symmetric = SymmetricKey::from_bytes(&user_key).unwrap();

        let http = http();
        let token: String = http
            .post(format!(
                "{base}/identity/accounts/register/send-verification-email"
            ))
            .json(&json!({"email": typed_email, "name": "Oracle", "receiveMarketingEmails": false}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        let body = json!({
            "email": typed_email,
            "emailVerificationToken": token,
            "masterPasswordHint": "oracle hint",
            "userAsymmetricKeys": {
                "publicKey": B64.encode(public.as_ref()),
                "encryptedPrivateKey": encrypt(&symmetric, private.as_ref()),
            },
            "masterPasswordAuthentication": {
                "kdf": kdf_json(&kdf),
                "masterPasswordAuthenticationHash": hash,
                "salt": email,
            },
            "masterPasswordUnlock": {
                "kdf": kdf_json(&kdf),
                "masterKeyWrappedUserKey": wrapped,
                "salt": email,
            },
        });
        let response = http
            .post(format!("{base}/identity/accounts/register/finish"))
            .json(&body)
            .send()
            .await
            .unwrap();
        assert!(
            response.status().is_success(),
            "{}",
            response.text().await.unwrap()
        );
        Self {
            email: email.to_owned(),
            password: password.to_owned(),
            kdf,
            user_key,
        }
    }

    /// A password-grant token, as any client obtains one.
    pub async fn access_token(&self, base: &str) -> String {
        let response: Value = http()
            .post(format!("{base}/identity/connect/token"))
            .form(&[
                ("grant_type", "password"),
                ("username", self.email.as_str()),
                ("password", self.password_hash().as_str()),
                ("scope", "api offline_access"),
                ("client_id", "web"),
                ("deviceType", "9"),
                ("deviceIdentifier", "oracle-web-vault"),
                ("deviceName", "chrome"),
            ])
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        response["access_token"].as_str().unwrap().to_owned()
    }

    /// Change the KDF the way the web vault does: re-derive under the new KDF
    /// and re-wrap the *same* user key, so no cipher needs touching.
    pub async fn change_kdf(&mut self, base: &str, kdf: Kdf) -> reqwest::Response {
        let access = self.access_token(base).await;
        let current = self.password_hash();
        let (hash, wrapped) = wrap(&self.password, &self.email, &kdf, &self.user_key);
        let body = json!({
            "masterPasswordHash": current,
            "authenticationData": {
                "kdf": kdf_json(&kdf),
                "masterPasswordAuthenticationHash": hash,
                "salt": self.email,
            },
            "unlockData": {
                "kdf": kdf_json(&kdf),
                "masterKeyWrappedUserKey": wrapped,
                "salt": self.email,
            },
        });
        let response = http()
            .post(format!("{base}/api/accounts/kdf"))
            .bearer_auth(access)
            .json(&body)
            .send()
            .await
            .unwrap();
        if response.status().is_success() {
            self.kdf = kdf;
        }
        response
    }
}
