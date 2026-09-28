//! The client half of organizations: an organization key made on the
//! "device", wrapped with RSA-OAEP-SHA1 (`EncString` type 4) for each member
//! exactly as Bitwarden clients wrap it, and a small bearer-token API caller.

use aws_lc_rs::encoding::{AsDer, Pkcs8V1Der, PublicKeyX509Der};
use aws_lc_rs::rsa::{
    KeyPair, KeySize, OaepPublicEncryptingKey, PublicEncryptingKey, OAEP_SHA1_MGF1SHA1,
};
use aws_lc_rs::signature::KeyPair as _;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use opensesame_provider_bitwarden::SymmetricKey;
use rand::RngCore as _;
use serde_json::{json, Value};
use zeroize::Zeroizing;

use super::client::{encrypt, http, Account, PBKDF2};

/// A signed-in caller of `/api`.
pub struct Api {
    pub base: String,
    pub token: String,
}

impl Api {
    pub fn new(base: &str, token: String) -> Self {
        Self {
            base: base.to_owned(),
            token,
        }
    }

    pub async fn call(&self, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
        let url = format!("{}/api{path}", self.base);
        let method = reqwest::Method::from_bytes(method.as_bytes()).unwrap();
        let mut request = http().request(method, url).bearer_auth(&self.token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        let text = response.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    pub async fn get(&self, path: &str) -> (u16, Value) {
        self.call("GET", path, None).await
    }

    pub async fn post(&self, path: &str, body: Value) -> (u16, Value) {
        self.call("POST", path, Some(body)).await
    }

    pub async fn put(&self, path: &str, body: Value) -> (u16, Value) {
        self.call("PUT", path, Some(body)).await
    }

    pub async fn delete(&self, path: &str, body: Value) -> (u16, Value) {
        self.call("DELETE", path, Some(body)).await
    }

    /// Require a 2xx and return the body.
    pub async fn ok(&self, method: &str, path: &str, body: Option<Value>) -> Value {
        let (status, out) = self.call(method, path, body).await;
        assert!(
            (200..300).contains(&status),
            "{method} {path}: {status} {out}"
        );
        out
    }

    /// The account's own id, from its profile.
    pub async fn user_id(&self) -> String {
        self.ok("GET", "/accounts/profile", None).await["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }
}

/// `4.<b64>`: `secret` under an RSA public key (X.509 DER, base64), OAEP
/// with SHA-1 — Bitwarden's `Rsa2048_OaepSha1_B64`.
pub fn rsa_wrap(public_b64: &str, secret: &[u8]) -> String {
    let der = B64.decode(public_b64).unwrap();
    let key = OaepPublicEncryptingKey::new(PublicEncryptingKey::from_der(&der).unwrap()).unwrap();
    let mut out = vec![0u8; key.ciphertext_size()];
    let sealed = key
        .encrypt(&OAEP_SHA1_MGF1SHA1, secret, &mut out, None)
        .unwrap();
    format!("4.{}", B64.encode(sealed))
}

/// An organization as its owner's device knows it.
pub struct Org {
    pub id: String,
    key: Zeroizing<Vec<u8>>,
}

impl Org {
    pub fn key(&self) -> SymmetricKey {
        SymmetricKey::from_bytes(&self.key).unwrap()
    }

    /// Text encrypted under the organization key.
    pub fn enc(&self, text: &str) -> String {
        encrypt(&self.key(), text.as_bytes())
    }

    /// The organization key wrapped for an account, by its user id.
    pub async fn wrap_for(&self, api: &Api, user_id: &str) -> String {
        let (_, key) = api.get(&format!("/users/{user_id}/public-key")).await;
        rsa_wrap(key["publicKey"].as_str().unwrap(), &self.key)
    }

    /// A login cipher body under the organization key.
    pub fn login(&self, name: &str, password: &str) -> Value {
        json!({
            "type": 1,
            "organizationId": self.id,
            "name": self.enc(name),
            "login": {"username": self.enc("user"), "password": self.enc(password)},
        })
    }

    /// Create an organization the way the web vault does, with a first
    /// collection; returns it and that collection's id.
    pub async fn create(api: &Api, name: &str) -> (Self, String) {
        let mut key = Zeroizing::new(vec![0u8; 64]);
        rand::rngs::OsRng.fill_bytes(&mut key);
        let symmetric = SymmetricKey::from_bytes(&key).unwrap();
        let pair = KeyPair::generate(KeySize::Rsa2048).unwrap();
        let private: Pkcs8V1Der = pair.as_der().unwrap();
        let public: PublicKeyX509Der = pair.public_key().as_der().unwrap();
        let (_, mine) = api.get("/accounts/keys").await;
        let wrapped = rsa_wrap(mine["publicKey"].as_str().unwrap(), &key);
        let created = api
            .ok(
                "POST",
                "/organizations",
                Some(json!({
                    "name": name,
                    "billingEmail": "billing@example.com",
                    "planType": 0,
                    "key": wrapped,
                    "keys": {
                        "publicKey": B64.encode(public.as_ref()),
                        "encryptedPrivateKey": encrypt(&symmetric, private.as_ref()),
                    },
                    "collectionName": encrypt(&symmetric, b"Default collection"),
                })),
            )
            .await;
        let org = Self {
            id: created["id"].as_str().unwrap().to_owned(),
            key,
        };
        let collections = api.ok("GET", "/collections", None).await;
        let collection = collections["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["organizationId"] == org.id.as_str())
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        (org, collection)
    }
}

pub const PASSWORD: &str = "correct horse battery staple";

pub async fn account(harness: &super::Harness, email: &str) -> (Account, Api) {
    let account = Account::register(&harness.http_url, email, PASSWORD, PBKDF2).await;
    let token = account.access_token(&harness.http_url).await;
    (account, Api::new(&harness.http_url, token))
}

pub fn ids(list: &Value) -> Vec<String> {
    list["data"]
        .as_array()
        .or_else(|| list.as_array())
        .unwrap()
        .iter()
        .map(|v| v["id"].as_str().unwrap().to_owned())
        .collect()
}

pub async fn member_id(owner: &Api, org: &Org, email: &str) -> String {
    let members = owner
        .ok("GET", &format!("/organizations/{}/users", org.id), None)
        .await;
    members["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["email"] == email)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// Invite `email`, give it `collections`, and confirm it.
pub async fn add_member(
    owner: &Api,
    org: &Org,
    email: &str,
    member: &Api,
    collections: Value,
) -> String {
    owner
        .ok(
            "POST",
            &format!("/organizations/{}/users/invite", org.id),
            Some(json!({"emails": [email], "type": 2, "collections": collections})),
        )
        .await;
    let id = member_id(owner, org, email).await;
    let key = org.wrap_for(owner, &member.user_id().await).await;
    owner
        .ok(
            "POST",
            &format!("/organizations/{}/users/{id}/confirm", org.id),
            Some(json!({"key": key})),
        )
        .await;
    id
}
