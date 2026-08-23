//! Shared, **offline** test scaffolding: deterministic account material, the
//! fixture builders that generate `tests/fixtures/`, and a loopback `hyper`
//! stub that serves those fixtures.
//!
//! No test in this crate touches the network (constitution C9). The stub
//! binds `127.0.0.1:0`; the client is pointed at it explicitly.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use http_body_util::Full;
use hyper::body::Bytes;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use opensesame_provider_bitwarden::{Kdf, MasterKey, SymmetricKey};
use serde_json::{json, Value};

/// The two server topologies this client must drive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    /// bitwarden.com: separate api / identity hosts, PascalCase payloads,
    /// PBKDF2, user key delivered on the token response.
    Cloud,
    /// vaultwarden: one origin with `/api` and `/identity`, camelCase
    /// payloads, Argon2id, user key delivered on the sync profile only.
    Vaultwarden,
}

impl Shape {
    pub fn dir(self) -> &'static str {
        match self {
            Shape::Cloud => "cloud",
            Shape::Vaultwarden => "vaultwarden",
        }
    }

    pub fn email(self) -> &'static str {
        match self {
            Shape::Cloud => "Cloud-User@Example.COM",
            Shape::Vaultwarden => "self-hosted@example.test",
        }
    }

    pub fn master_password(self) -> &'static str {
        match self {
            // Self-generated fixture credentials. Not a real account.
            Shape::Cloud => "correct horse battery staple",
            Shape::Vaultwarden => "hunter2-hunter2-hunter2",
        }
    }

    /// Deliberately small work factors: these run in a debug-profile test
    /// suite. `tests/vectors/crypto_vectors.json` carries the
    /// production-shaped parameters instead.
    pub fn kdf(self) -> Kdf {
        match self {
            Shape::Cloud => Kdf::Pbkdf2 { iterations: 10_000 },
            Shape::Vaultwarden => Kdf::argon2id(2, 8 * 1024, 1).expect("valid argon2 params"),
        }
    }

    pub fn access_token(self) -> &'static str {
        match self {
            Shape::Cloud => "cloud-access-token-fixture",
            Shape::Vaultwarden => "vaultwarden-access-token-fixture",
        }
    }

    pub fn refresh_token(self) -> &'static str {
        match self {
            Shape::Cloud => "cloud-refresh-token-fixture",
            Shape::Vaultwarden => "vaultwarden-refresh-token-fixture",
        }
    }

    /// Fixed 64-byte user key so the fixtures are byte-reproducible.
    pub fn user_key_bytes(self) -> Vec<u8> {
        let seed: u8 = match self {
            Shape::Cloud => 3,
            Shape::Vaultwarden => 29,
        };
        (0u8..64).map(|i| i.wrapping_mul(seed).wrapping_add(11)).collect()
    }

    pub fn user_key(self) -> SymmetricKey {
        SymmetricKey::from_bytes(&self.user_key_bytes()).expect("64-byte user key")
    }

    pub fn master_key(self) -> MasterKey {
        MasterKey::derive(
            self.master_password().as_bytes(),
            self.email(),
            &self.kdf(),
        )
        .expect("fixture KDF parameters are valid")
    }
}

/// Deterministic IVs. Fixtures must be byte-stable across regenerations, so
/// nothing here is random; real vault writes are out of scope for a
/// consume-client.
pub struct Ivs(u8);

impl Ivs {
    pub fn new() -> Self {
        Ivs(0)
    }
    pub fn next(&mut self) -> [u8; 16] {
        self.0 = self.0.wrapping_add(1);
        [self.0; 16]
    }
}

impl Default for Ivs {
    fn default() -> Self {
        Self::new()
    }
}

fn enc(key: &SymmetricKey, ivs: &mut Ivs, plaintext: &str) -> String {
    key.encrypt_with_iv(plaintext.as_bytes(), ivs.next())
        .expect("fixture encryption")
        .to_string()
}

/// Recursively PascalCase every object key — the shape older Bitwarden
/// servers emit, and the reason every response struct carries aliases.
fn pascalize(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| {
                    let mut chars = key.chars();
                    let key = match chars.next() {
                        Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
                        None => String::new(),
                    };
                    (key, pascalize(value))
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(pascalize).collect()),
        other => other.clone(),
    }
}

pub const FOLDER_ID: &str = "11111111-1111-4111-8111-111111111111";
pub const LOGIN_ID: &str = "22222222-2222-4222-8222-222222222222";
pub const ROOT_LOGIN_ID: &str = "33333333-3333-4333-8333-333333333333";
pub const NOTE_ID: &str = "44444444-4444-4444-8444-444444444444";
pub const TRASHED_ID: &str = "55555555-5555-4555-8555-555555555555";
pub const ORG_ITEM_ID: &str = "66666666-6666-4666-8666-666666666666";
pub const COSE_ID: &str = "77777777-7777-4777-8777-777777777777";

/// Build every fixture payload for a shape, from the shape's own key
/// material. Regenerating is deterministic: same bytes in, same bytes out.
pub fn build_fixtures(shape: Shape) -> BTreeMap<&'static str, Value> {
    let master = shape.master_key();
    let user_key = shape.user_key();
    let mut ivs = Ivs::new();
    let wrapped_user_key = master
        .stretch()
        .encrypt_with_iv(&shape.user_key_bytes(), ivs.next())
        .expect("wrap user key")
        .to_string();

    let prelogin = match shape.kdf() {
        Kdf::Pbkdf2 { iterations } => json!({
            "kdf": 0,
            "kdfIterations": iterations,
        }),
        Kdf::Argon2id {
            iterations,
            memory_kib,
            parallelism,
        } => json!({
            "kdf": 1,
            "kdfIterations": iterations,
            "kdfMemory": memory_kib / 1024,
            "kdfParallelism": parallelism,
        }),
    };

    let mut token = json!({
        "access_token": shape.access_token(),
        "expires_in": 3600,
        "refresh_token": shape.refresh_token(),
        "token_type": "Bearer",
        "scope": "api offline_access",
    });
    if shape == Shape::Cloud {
        // Cloud hands the wrapped user key back on the token response.
        token["Key"] = json!(wrapped_user_key);
    }

    let sync = json!({
        "object": "sync",
        "profile": {
            "id": "99999999-9999-4999-8999-999999999999",
            "email": opensesame_provider_bitwarden::normalize_email(shape.email()),
            // vaultwarden's fixture omits the token key, so the profile key is
            // the only path to the user key — exercising that branch.
            "key": wrapped_user_key,
            "organizations": [],
        },
        "folders": [
            { "id": FOLDER_ID, "name": enc(&user_key, &mut ivs, "Work"), "revisionDate": "2026-01-02T03:04:05.000Z" }
        ],
        "ciphers": [
            {
                "id": LOGIN_ID,
                "organizationId": null,
                "folderId": FOLDER_ID,
                "type": 1,
                "name": enc(&user_key, &mut ivs, "GitHub"),
                "notes": enc(&user_key, &mut ivs, "recovery codes are in the safe\nsecond line"),
                "favorite": true,
                "revisionDate": "2026-02-03T04:05:06.000Z",
                "login": {
                    "username": enc(&user_key, &mut ivs, "octocat"),
                    "password": enc(&user_key, &mut ivs, "s3cr3t-github-password"),
                    "totp": enc(&user_key, &mut ivs, "otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub"),
                    "uris": [
                        { "uri": enc(&user_key, &mut ivs, "https://github.com"), "match": null },
                        { "uri": enc(&user_key, &mut ivs, "https://api.github.com"), "match": 0 }
                    ]
                },
                "fields": [
                    { "name": enc(&user_key, &mut ivs, "recovery-email"), "value": enc(&user_key, &mut ivs, "octo@example.com"), "type": 0 },
                    { "name": enc(&user_key, &mut ivs, "pin"), "value": enc(&user_key, &mut ivs, "4815"), "type": 1 }
                ]
            },
            {
                "id": ROOT_LOGIN_ID,
                "organizationId": null,
                "folderId": null,
                "type": 1,
                "name": enc(&user_key, &mut ivs, "Router"),
                "notes": null,
                "favorite": false,
                "revisionDate": "2026-02-03T04:05:07.000Z",
                "login": {
                    "username": enc(&user_key, &mut ivs, "admin"),
                    "password": enc(&user_key, &mut ivs, "admin-password"),
                    "totp": null,
                    "uris": []
                },
                "fields": []
            },
            {
                "id": NOTE_ID,
                "organizationId": null,
                "folderId": FOLDER_ID,
                "type": 2,
                "name": enc(&user_key, &mut ivs, "Door code"),
                "notes": enc(&user_key, &mut ivs, "1234#"),
                "favorite": false,
                "revisionDate": "2026-02-03T04:05:08.000Z",
                "login": null,
                "fields": []
            },
            {
                "id": TRASHED_ID,
                "organizationId": null,
                "folderId": null,
                "type": 1,
                "name": enc(&user_key, &mut ivs, "Old thing"),
                "deletedDate": "2026-02-01T00:00:00.000Z",
                "favorite": false,
                "revisionDate": "2026-02-01T00:00:00.000Z",
                "login": { "username": null, "password": enc(&user_key, &mut ivs, "stale"), "totp": null, "uris": [] },
                "fields": []
            },
            {
                "id": ORG_ITEM_ID,
                "organizationId": "88888888-8888-4888-8888-888888888888",
                "folderId": null,
                "type": 1,
                "name": enc(&user_key, &mut ivs, "Shared deploy key"),
                "favorite": false,
                "revisionDate": "2026-02-03T04:05:09.000Z",
                "login": { "username": null, "password": enc(&user_key, &mut ivs, "org-only"), "totp": null, "uris": [] },
                "fields": []
            },
            {
                "id": COSE_ID,
                "organizationId": null,
                "folderId": null,
                "type": 1,
                // A live example of Bitwarden's COSE migration: type 7. The
                // client must name it, not guess at it.
                "name": enc(&user_key, &mut ivs, "Migrated to COSE"),
                "favorite": false,
                "revisionDate": "2026-02-03T04:05:10.000Z",
                "login": {
                    "username": null,
                    "password": "7.2E2ldTVOKk2Zh8YQ0gxpAg==", // gitleaks:allow -- synthetic type-7 COSE EncString
                    "totp": null,
                    "uris": []
                },
                "fields": []
            }
        ],
        "collections": [],
        "policies": [],
        "domains": null
    });

    let config = json!({
        "version": match shape { Shape::Cloud => "2026.8.1", Shape::Vaultwarden => "1.35.0" },
        "gitHash": "0000000",
        "server": match shape {
            Shape::Cloud => json!(null),
            Shape::Vaultwarden => json!({ "name": "Vaultwarden", "url": "https://github.com/dani-garcia/vaultwarden" }),
        },
        "environment": { "vault": "http://127.0.0.1" },
        "featureStates": {}
    });

    let (prelogin, sync, config) = match shape {
        Shape::Cloud => (pascalize(&prelogin), pascalize(&sync), pascalize(&config)),
        Shape::Vaultwarden => (prelogin, sync, config),
    };

    BTreeMap::from([
        ("prelogin.json", prelogin),
        ("token.json", token),
        ("sync.json", sync),
        ("config.json", config),
    ])
}

pub fn fixture_dir(shape: Shape) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(shape.dir())
}

pub fn load_fixture(shape: Shape, name: &str) -> String {
    let path = fixture_dir(shape).join(name);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("missing fixture {}: {e}", path.display()))
}

/// One recorded request: method, path, and whether a bearer token was sent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hit {
    pub method: String,
    pub path: String,
    pub query: Option<String>,
    pub authorization: Option<String>,
    pub body: String,
}

pub type Route = (u16, String);

/// A loopback HTTP stub serving a fixed path→(status, body) table and
/// recording every hit. Any path not in the table answers 404, which is how
/// "the client called the wrong endpoint" shows up as a test failure rather
/// than a hang.
pub async fn spawn_stub(routes: BTreeMap<String, Route>) -> (String, Arc<Mutex<Vec<Hit>>>) {
    let hits = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let routes = Arc::new(routes);
    let hits_task = hits.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let io = TokioIo::new(stream);
            let routes = routes.clone();
            let hits = hits_task.clone();
            tokio::spawn(async move {
                let service = service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
                    let routes = routes.clone();
                    let hits = hits.clone();
                    async move {
                        use http_body_util::BodyExt;
                        let method = req.method().to_string();
                        let path = req.uri().path().to_string();
                        let query = req.uri().query().map(str::to_string);
                        let authorization = req
                            .headers()
                            .get("authorization")
                            .and_then(|v| v.to_str().ok())
                            .map(str::to_string);
                        let body = req
                            .into_body()
                            .collect()
                            .await
                            .map(|c| String::from_utf8_lossy(&c.to_bytes()).into_owned())
                            .unwrap_or_default();
                        hits.lock().unwrap().push(Hit {
                            method,
                            path: path.clone(),
                            query,
                            authorization,
                            body,
                        });
                        let (status, body) = routes
                            .get(&path)
                            .cloned()
                            .unwrap_or_else(|| (404, r#"{"message":"no such route"}"#.to_owned()));
                        let response = hyper::Response::builder()
                            .status(status)
                            .header("content-type", "application/json");
                        let response = match status {
                            301..=308 => response.header("location", "https://evil.example.com/"),
                            _ => response,
                        };
                        Ok::<_, std::convert::Infallible>(
                            response.body(Full::new(Bytes::from(body))).unwrap(),
                        )
                    }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(io, service)
                    .await;
            });
        }
    });
    (format!("http://127.0.0.1:{}", addr.port()), hits)
}

/// Routes for the vaultwarden topology: one origin, `/identity` + `/api`.
pub fn vaultwarden_routes() -> BTreeMap<String, Route> {
    let shape = Shape::Vaultwarden;
    BTreeMap::from([
        (
            "/identity/accounts/prelogin".to_owned(),
            (200, load_fixture(shape, "prelogin.json")),
        ),
        (
            "/identity/connect/token".to_owned(),
            (200, load_fixture(shape, "token.json")),
        ),
        ("/api/sync".to_owned(), (200, load_fixture(shape, "sync.json"))),
        (
            "/api/config".to_owned(),
            (200, load_fixture(shape, "config.json")),
        ),
    ])
}

/// Routes for the cloud topology: identity host and api host are separate
/// servers, mounted at the root of each.
pub fn cloud_identity_routes() -> BTreeMap<String, Route> {
    let shape = Shape::Cloud;
    BTreeMap::from([
        (
            "/accounts/prelogin".to_owned(),
            (200, load_fixture(shape, "prelogin.json")),
        ),
        (
            "/connect/token".to_owned(),
            (200, load_fixture(shape, "token.json")),
        ),
    ])
}

pub fn cloud_api_routes() -> BTreeMap<String, Route> {
    let shape = Shape::Cloud;
    BTreeMap::from([
        ("/sync".to_owned(), (200, load_fixture(shape, "sync.json"))),
        (
            "/config".to_owned(),
            (200, load_fixture(shape, "config.json")),
        ),
    ])
}
